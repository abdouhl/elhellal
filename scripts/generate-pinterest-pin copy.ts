#!/usr/bin/env bun
/**
 * Pinterest Pin Generator (Arabic / RTL) — الهلال
 * ------------------------------------------------
 * Renders a 1000x1500 Pinterest pin for every article in src/data/articles.json
 * and uploads it locally or to Cloudflare R2, alongside a Pinterest-ready RSS feed.
 *
 * Supports two storage backends — choose at runtime:
 *
 *   Local (default):
 *     bun run scripts/generate-pinterest-pin.ts
 *     bun run scripts/generate-pinterest-pin.ts --storage local
 *
 *   Cloudflare R2:
 *     bun run scripts/generate-pinterest-pin.ts --storage r2
 *
 * R2 requires env vars (or a .env file):
 *   R2_ACCOUNT_ID      Cloudflare account ID
 *   R2_ACCESS_KEY_ID   R2 access key
 *   R2_SECRET_KEY      R2 secret key
 *   R2_BUCKET          bucket name  (default: elhellalpins)
 *   R2_PUBLIC_URL      public bucket URL  e.g. https://pins.elhellal.com
 *
 * Other flags:
 *   --batch 200        override batch size (default 10000)
 *   --articles-file     override articles.json path
 *   --out-dir          override local output folder
 *
 * Besides one pin per article, this also generates collection pins for:
 *   - tag pages       (/tags/[tag])       once a tag has 3+ articles
 *   - category pages  (/[category])       once a category has 5+ articles
 *   - author pages    (/authors/[author]) once an author has 5+ articles
 */

import 'dotenv/config';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import type { Article, ArticlesConfig } from '../src/types/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── CLI args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const STORAGE = (getArg('--storage') || 'local').toLowerCase();

if (!['local', 'r2'].includes(STORAGE)) {
  console.error('❌  --storage must be "local" or "r2"');
  process.exit(1);
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Config ───────────────────────────────────────────────────────────────────
const ARTICLES_FILE = getArg('--articles-file')
  || path.join(__dirname, '../src/data/articles.json');
const LOCAL_PUBLIC = getArg('--out-dir')
  || path.join(__dirname, '../public/pins');
const BATCH_SIZE = parseInt(getArg('--batch') || '10000', 10);

// Local paths
const LOCAL_IMAGES = path.join(LOCAL_PUBLIC, 'images');
const LOCAL_FEED = path.join(LOCAL_PUBLIC, 'feed.xml');

// R2 config (from env) — separate bucket from any other project sharing the account
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_KEY = process.env.R2_SECRET_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || 'elhellalpins';
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || 'https://pins.elhellal.com').replace(/\/$/, '');

// Feed / article URL constants
const BASE_URL = 'https://elhellal.com/articles/';
const IMAGE_BASE = STORAGE === 'r2' ? `${R2_PUBLIC_URL}/images/` : 'https://elhellal.com/pins/images/';
const FEED_URL = STORAGE === 'r2' ? `${R2_PUBLIC_URL}/feed.xml` : 'https://elhellal.com/pins/feed.xml';
const SITE_TITLE = 'الهلال';
const SITE_DESC = 'دليل منتقى لأفضل المقالات العربية على الإنترنت';
// ─────────────────────────────────────────────────────────────────────────────

// ─── Lazy-load @aws-sdk/client-s3 only when needed ───────────────────────────
let s3Client: any, PutObjectCommand: any, GetObjectCommand: any;
async function initR2() {
  try {
    const { S3Client, PutObjectCommand: POC, GetObjectCommand: GOC } = await import('@aws-sdk/client-s3');
    PutObjectCommand = POC;
    GetObjectCommand = GOC;
    s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
    });
    console.log(`✅  R2 client ready → bucket: ${R2_BUCKET}\n`);
  } catch {
    console.error('❌  @aws-sdk/client-s3 not installed. Run: bun add @aws-sdk/client-s3');
    process.exit(1);
  }
}

async function r2Exists(key: string): Promise<boolean> {
  try {
    await s3Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch { return false; }
}

async function r2Upload(key: string, buffer: Buffer, contentType = 'image/png') {
  await s3Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET, Key: key, Body: buffer, ContentType: contentType,
  }));
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Storage abstraction ──────────────────────────────────────────────────────
async function imageExists(category: string, filename: string): Promise<boolean> {
  if (STORAGE === 'local') {
    return fs.existsSync(path.join(LOCAL_IMAGES, category, filename));
  }
  return r2Exists(`images/${category}/${filename}`);
}

async function saveImage(category: string, filename: string, buffer: Buffer) {
  if (STORAGE === 'local') {
    const dir = path.join(LOCAL_IMAGES, category);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), buffer);
  } else {
    await r2Upload(`images/${category}/${filename}`, buffer);
  }
}

async function readFeed(): Promise<string> {
  if (STORAGE === 'local') {
    return fs.existsSync(LOCAL_FEED) ? fs.readFileSync(LOCAL_FEED, 'utf-8') : '';
  }
  try {
    const res = await s3Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: 'feed.xml' }));
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf-8');
  } catch { return ''; }
}

async function writeFeedXml(xml: string) {
  if (STORAGE === 'local') {
    fs.mkdirSync(LOCAL_PUBLIC, { recursive: true });
    fs.writeFileSync(LOCAL_FEED, xml, 'utf-8');
  } else {
    await r2Upload('feed.xml', Buffer.from(xml, 'utf-8'), 'application/xml');
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Category accent colors (matches src/data/articles.json category slugs) ──
const CATEGORY_COLORS: Record<string, string> = {
  psychology: '#7B3FA0',
  quran: '#0E7C3A',
  'islamic-fiqh': '#0B6E4F',
  writing: '#B8860B',
  'self-development': '#1565C0',
  religion: '#107869',
  'mental-health': '#2E7D32',
  politics: '#8B1E1E',
  philosophy: '#4527A0',
  sociology: '#00695C',
  marketing: '#C62828',
  culture: '#AD8B00',
  general: '#37474F',
  management: '#283593',
  health: '#1A8C4E',
  relationships: '#AD1457',
  economics: '#0066CC',
  business: '#E65C00',
  investing: '#0055A5',
};
const FALLBACK_PALETTE = [
  '#1B6CA8', '#B34700', '#1A7A4A', '#6A1B9A',
  '#00695C', '#AD1457', '#283593', '#BF360C',
];
const _usedFallback: Record<string, string> = {};
function accentColor(cat: string): string {
  if (CATEGORY_COLORS[cat]) return CATEGORY_COLORS[cat];
  if (_usedFallback[cat]) return _usedFallback[cat];
  const used = Object.values(_usedFallback);
  const next = FALLBACK_PALETTE.find((c) => !used.includes(c))
    || FALLBACK_PALETTE[used.length % FALLBACK_PALETTE.length];
  _usedFallback[cat] = next;
  return next;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Collection pin thresholds (tag/category/author archive pages) ───────────
// MIN_TAG_ARTICLES mirrors src/utils/tags.ts — tag pages below this aren't built by the site.
const MIN_TAG_ARTICLES = 3;
const MIN_CATEGORY_ARTICLES = 5;
const MIN_AUTHOR_ARTICLES = 5;

function normalizeTag(raw: string): string {
  return raw.trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
}
function slugifyTag(raw: string): string {
  return normalizeTag(raw).replace(/\s+/g, '-');
}

interface CollectionPreviewArticle {
  title: string;
  image?: string | undefined;
}

interface CollectionPin {
  kind: 'tag' | 'category' | 'author';
  key: string;
  folder: 'tags' | 'categories' | 'authors';
  title: string;
  badge: string;
  count: number;
  color: string;
  previewArticles: CollectionPreviewArticle[];
  targetUrl: string;
}

/** Picks the N articles to actually preview inside a collection pin — images first, so thumbnails aren't blank. */
function pickPreviewArticles(entries: { article: Article }[], n: number): CollectionPreviewArticle[] {
  const withImage = entries.filter((e) => e.article.original_img_url);
  const withoutImage = entries.filter((e) => !e.article.original_img_url);
  return [...withImage, ...withoutImage]
    .slice(0, n)
    .map((e) => ({ title: e.article.title, image: e.article.original_img_url }));
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fetchImageAsBase64(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 12000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchImageAsBase64(res.headers.location).then(resolve);
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const mime = res.headers['content-type'] || 'image/jpeg';
        resolve(`data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`);
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function xe(s: unknown): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function slugify(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80);
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── HTML template (RTL / Arabic) ─────────────────────────────────────────────
function pinDocument(color: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html dir="rtl" lang="ar"><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Amiri:wght@700&family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:1000px;height:1500px;background:#0e0e0e;font-family:"Cairo",sans-serif;overflow:hidden}
  .pin{width:1000px;height:1500px;background:#0e0e0e;overflow:hidden;direction:rtl}
  .img-wrap{position:relative;width:100%;height:860px;overflow:hidden;background:#111}
  .img-wrap img{width:100%;height:100%;object-fit:cover;object-position:center top;filter:brightness(.7);display:block}
  .no-img{width:100%;height:100%;background:#1a1a1a}
  .top-bar{position:absolute;top:40px;left:40px;right:40px;display:flex;align-items:center;justify-content:space-between}
  .screen-name{color:rgba(255,255,255,.92);font-size:26px;letter-spacing:.01em;text-shadow:0 1px 6px rgba(0,0,0,.7);direction:ltr}
  .cat-tag{background:${color};color:#fff;font-size:24px;font-weight:700;padding:12px 28px;border-radius:50px}
  .overlay{position:absolute;bottom:0;left:0;right:0;height:240px;background:linear-gradient(transparent,rgba(0,0,0,.88))}
  .content{position:relative;background:#141414;padding:52px 52px 44px;height:640px;display:flex;flex-direction:column;justify-content:space-between;text-align:right;background-image:radial-gradient(${color}22 1.5px,transparent 1.5px);background-size:28px 28px;background-position:0 0}
  .title{font-family:"Amiri",serif;font-size:50px;line-height:1.5;font-weight:700;color:#f0ede8;letter-spacing:0;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
  .desc{font-size:27px;color:#a09d98;line-height:1.75;font-weight:400;margin-top:26px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;flex:1}
  .bottom{margin-top:auto}
  .divider{display:flex;align-items:center;gap:18px;margin-bottom:36px}
  .divider .line{flex:1;border-top:1px solid #2e2e2e}
  .divider .rosette{width:22px;height:22px;flex-shrink:0}
  .cta{display:flex;align-items:center;justify-content:center;gap:18px;background:${color};color:#fff;padding:36px 0;border-radius:16px;font-size:34px;font-weight:700}
  .footer{margin-top:32px;display:flex;align-items:center;justify-content:space-between}
  .brand-mark{display:flex;align-items:center;gap:10px;direction:ltr}
  .brand-mark span{font-size:24px;color:#504d4a}
  .p-mark{display:flex;align-items:center;gap:8px;direction:ltr}
  .p-mark span{font-size:20px;color:#504d4a}
  .collection-pin{width:1000px;height:1500px;background:#0e0e0e;overflow:hidden;direction:rtl;display:flex;flex-direction:column}
  .collection-header{padding:48px 52px 32px;background:linear-gradient(135deg,${color}2a,#141414 65%);background-image:radial-gradient(${color}22 1.5px,transparent 1.5px);background-size:28px 28px}
  .collection-top-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:30px}
  .collection-badge{background:${color};color:#fff;font-size:24px;font-weight:700;padding:12px 28px;border-radius:50px}
  .collection-count{color:rgba(255,255,255,.75);font-size:24px}
  .collection-title{font-family:"Amiri",serif;font-weight:700;color:#f0ede8;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .collection-subtitle{margin-top:16px;font-size:24px;color:#a09d98}
  .article-list{flex:1;display:flex;flex-direction:column;padding:8px 52px;justify-content:center;overflow:hidden}
  .article-row{display:flex;align-items:center;background:#181818;border:0.5px solid rgba(255,255,255,.08);border-radius:14px}
  .article-thumb{object-fit:cover;flex-shrink:0;border-radius:10px;background:#222}
  .article-row-title{font-weight:600;color:#e8e5e0;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;flex:1}
  .collection-footer{padding:8px 52px 44px}
</style>
</head><body>
${bodyHtml}
</body></html>`;
}

function renderPinBody(opts: {
  imgSrc: string;
  badge: string;
  cornerLabel: string;
  title: string;
  subtitle: string;
  ctaText: string;
  color: string;
}): string {
  const { imgSrc, badge, cornerLabel, title, subtitle, ctaText, color } = opts;
  return `<div class="pin">
  <div class="img-wrap">
    ${imgSrc ? `<img src="${imgSrc}" alt=""/>` : `<div class="no-img"></div>`}
    <div class="top-bar">
      <span class="cat-tag">${badge}</span>
      <span class="screen-name">${cornerLabel}</span>
    </div>
    <div class="overlay"></div>
  </div>
  <div class="content">
    <div>
      <h2 class="title">${title}</h2>
      <p class="desc">${subtitle}</p>
    </div>
    <div class="bottom">
      <div class="divider">
        <span class="line"></span>
        <svg class="rosette" viewBox="0 0 24 24" fill="none">
          <path d="M12 2 13.61 8.12 19.07 4.93 15.88 10.39 22 12 15.88 13.61 19.07 19.07 13.61 15.88 12 22 10.39 15.88 4.93 19.07 8.12 13.61 2 12 8.12 10.39 4.93 4.93 10.39 8.12Z" fill="${color}" opacity=".9"/>
        </svg>
        <span class="line"></span>
      </div>
      <div class="cta">
        ${ctaText}
        <svg width="36" height="36" viewBox="0 0 14 14" fill="none">
          <path d="M12 7H2M6 3L2 7l4 4" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="footer">
        <div class="p-mark">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="${color}">
            <path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z"/>
          </svg>
          <span>Pin</span>
        </div>
        <div class="brand-mark">
          <span>elhellal.com</span>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="${color}">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
          </svg>
        </div>
      </div>
    </div>
  </div>
</div>`;
}

function buildHTML(article: Article, catLabel: string, color: string, imageBase64: string | null): string {
  const body = renderPinBody({
    imgSrc: imageBase64 || '',
    badge: xe(catLabel),
    cornerLabel: `@${xe(article.screen_name || '')}`,
    title: xe(article.title),
    subtitle: xe((article.tldr || article.preview_text || '').replace(/\n/g, ' ')),
    ctaText: 'اقرأ المقال',
    color,
  });
  return pinDocument(color, body);
}

const COLLECTION_SUBTITLES: Record<CollectionPin['kind'], string> = {
  tag: 'أفضل المقالات حول هذا الموضوع',
  category: 'أفضل المقالات المنتقاة في هذا التصنيف',
  author: 'كل مقالات هذا الكاتب على الهلال',
};

function buildCollectionHTML(pin: CollectionPin, images: (string | null)[]): string {
  // Author handles are LTR strings (@name) — wrap so RTL context doesn't reorder the "@".
  const title = pin.kind === 'author'
    ? `<span style="direction:ltr;display:inline-block">${xe(pin.title)}</span>`
    : xe(pin.title);

  const n = pin.previewArticles.length;
  const thumbSize = n <= 3 ? 210 : 130;
  const rowGap = n <= 3 ? 30 : 16;
  const rowPad = n <= 3 ? 20 : 12;
  const titleSize = n <= 3 ? 30 : 24;

  const rows = pin.previewArticles.map((a, i) => {
    const img = images[i];
    const thumb = img
      ? `<img class="article-thumb" src="${img}" alt="" style="width:${thumbSize}px;height:${thumbSize}px"/>`
      : `<div class="article-thumb" style="width:${thumbSize}px;height:${thumbSize}px"></div>`;
    return `<div class="article-row" style="gap:22px;padding:${rowPad}px">
      ${thumb}
      <span class="article-row-title" style="font-size:${titleSize}px">${xe(a.title)}</span>
    </div>`;
  }).join('\n');

  const body = `<div class="collection-pin">
  <div class="collection-header">
    <div class="collection-top-row">
      <span class="collection-badge">${xe(pin.badge)}</span>
      <span class="collection-count">${xe(`${pin.count} مقالة`)}</span>
    </div>
    <h2 class="collection-title" style="font-size:${pin.kind === 'author' ? 54 : 46}px">${title}</h2>
    <p class="collection-subtitle">${xe(COLLECTION_SUBTITLES[pin.kind])}</p>
  </div>
  <div class="article-list" style="gap:${rowGap}px">
    ${rows}
  </div>
  <div class="collection-footer">
    <div class="divider">
      <span class="line"></span>
      <svg class="rosette" viewBox="0 0 24 24" fill="none">
        <path d="M12 2 13.61 8.12 19.07 4.93 15.88 10.39 22 12 15.88 13.61 19.07 19.07 13.61 15.88 12 22 10.39 15.88 4.93 19.07 8.12 13.61 2 12 8.12 10.39 4.93 4.93 10.39 8.12Z" fill="${pin.color}" opacity=".9"/>
      </svg>
      <span class="line"></span>
    </div>
    <div class="cta">
      تصفح المقالات
      <svg width="36" height="36" viewBox="0 0 14 14" fill="none">
        <path d="M12 7H2M6 3L2 7l4 4" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <div class="footer">
      <div class="p-mark">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="${pin.color}">
          <path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z"/>
        </svg>
        <span>Pin</span>
      </div>
      <div class="brand-mark">
        <span>elhellal.com</span>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="${pin.color}">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      </div>
    </div>
  </div>
</div>`;

  return pinDocument(pin.color, body);
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Feed XML ─────────────────────────────────────────────────────────────────
function parseExistingFeed(xml: string) {
  const guids = new Set<string>();
  const guidRe = /<guid[^>]*>([^<]+)<\/guid>/g;
  let m;
  while ((m = guidRe.exec(xml)) !== null) guids.add(m[1].trim());
  const firstItem = xml.indexOf('<item>');
  const lastItem = xml.lastIndexOf('</item>');
  const existingItems = firstItem !== -1 && lastItem !== -1
    ? xml.slice(firstItem, lastItem + '</item>'.length) : '';
  return { existingGuids: guids, existingItems };
}

function buildItemXml({ article, category, imageFilename }: { article: Article; category: string; imageFilename: string }) {
  const articleUrl = `${BASE_URL}${xe(article.slug)}`;
  const imageUrl = `${IMAGE_BASE}${xe(category)}/${xe(imageFilename)}`;
  const pubDate = article.created_at ? new Date(article.created_at).toUTCString() : new Date().toUTCString();
  const desc = xe((article.preview_text || '').replace(/\n/g, ' ').slice(0, 500));
  return `  <item>
    <title>${xe(article.title)}</title>
    <link>${articleUrl}</link>
    <description>${desc}</description>
    <pubDate>${pubDate}</pubDate>
    <guid isPermaLink="true">${articleUrl}</guid>
    <enclosure url="${imageUrl}" type="image/png" length="0"/>
    <media:content url="${imageUrl}" medium="image" type="image/png"/>
    <media:thumbnail url="${imageUrl}"/>
  </item>`;
}

function buildCollectionItemXml({ pin, imageFilename }: { pin: CollectionPin; imageFilename: string }) {
  const imageUrl = `${IMAGE_BASE}${pin.folder}/${xe(imageFilename)}`;
  const pubDate = new Date().toUTCString();
  return `  <item>
    <title>${xe(pin.title)}</title>
    <link>${pin.targetUrl}</link>
    <description>${xe(`${pin.count} مقالة`)}</description>
    <pubDate>${pubDate}</pubDate>
    <guid isPermaLink="true">${pin.targetUrl}</guid>
    <enclosure url="${imageUrl}" type="image/png" length="0"/>
    <media:content url="${imageUrl}" medium="image" type="image/png"/>
    <media:thumbnail url="${imageUrl}"/>
  </item>`;
}

function assembleFeed(newItemsXml: string, existingItems: string) {
  const now = new Date().toUTCString();
  const all = [newItemsXml, existingItems].filter(Boolean).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:media="http://search.yahoo.com/mrss/"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xe(SITE_TITLE)}</title>
    <link>https://elhellal.com</link>
    <description>${xe(SITE_DESC)}</description>
    <language>ar</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${FEED_URL}" rel="self" type="application/rss+xml"/>
${all}
  </channel>
</rss>`;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📦  Storage backend: ${STORAGE.toUpperCase()}\n`);

  if (STORAGE === 'r2') {
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY || !R2_SECRET_KEY) {
      console.error('❌  R2 credentials missing. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_KEY in env or .env file.');
      process.exit(1);
    }
    await initR2();
  }

  if (!fs.existsSync(ARTICLES_FILE)) {
    console.error(`❌  articles.json not found: ${ARTICLES_FILE}`);
    process.exit(1);
  }

  // 1. Load articles
  const data: ArticlesConfig = JSON.parse(fs.readFileSync(ARTICLES_FILE, 'utf-8'));
  const allArticles: { article: Article; category: string; catLabel: string; color: string }[] = [];

  for (const cat of data.articles) {
    const category = cat.category;
    const catLabel = cat.title; // already Arabic, e.g. "علم النفس"
    const color = accentColor(category);
    for (const article of cat.content) {
      if (!article.slug) article.slug = slugify(article.title || article.id_str || 'article');
      allArticles.push({ article, category, catLabel, color });
    }
  }

  console.log(`📂  ${data.articles.length} categories → ${allArticles.length} articles total`);

  // 2. Read existing feed
  const feedXml = await readFeed();
  const { existingGuids, existingItems } = parseExistingFeed(feedXml);
  console.log(`📄  feed.xml has ${existingGuids.size} existing items\n`);

  // 3. Filter pending
  const pending = allArticles.filter(({ article }) => !existingGuids.has(`${BASE_URL}${article.slug}`));
  const batch = pending.slice(0, BATCH_SIZE);
  if (!pending.length) {
    console.log('✅  All articles already in feed.\n');
  } else {
    console.log(`🚀  ${pending.length} pending → processing ${batch.length} this run (batch: ${BATCH_SIZE})\n`);
  }

  // 4. Aggregate collection pins (tags / categories / authors)
  const tagMap = new Map<string, { label: string; entries: typeof allArticles }>();
  const authorMap = new Map<string, typeof allArticles>();
  for (const entry of allArticles) {
    const { article } = entry;
    (article.keywords || []).forEach((kw) => {
      const tagSlug = slugifyTag(kw);
      if (!tagMap.has(tagSlug)) tagMap.set(tagSlug, { label: normalizeTag(kw), entries: [] });
      tagMap.get(tagSlug)!.entries.push(entry);
    });
    if (article.screen_name) {
      if (!authorMap.has(article.screen_name)) authorMap.set(article.screen_name, []);
      authorMap.get(article.screen_name)!.push(entry);
    }
  }

  const collectionPins: CollectionPin[] = [];

  for (const [tagSlug, { label, entries }] of tagMap) {
    if (entries.length < MIN_TAG_ARTICLES) continue;
    collectionPins.push({
      kind: 'tag', key: tagSlug, folder: 'tags', title: label, badge: 'وسم',
      count: entries.length, color: entries[0].color,
      previewArticles: pickPreviewArticles(entries, MIN_TAG_ARTICLES),
      targetUrl: `https://elhellal.com/tags/${tagSlug}`,
    });
  }

  for (const cat of data.articles) {
    if (cat.content.length < MIN_CATEGORY_ARTICLES) continue;
    collectionPins.push({
      kind: 'category', key: cat.category, folder: 'categories', title: cat.title, badge: 'تصنيف',
      count: cat.content.length, color: accentColor(cat.category),
      previewArticles: pickPreviewArticles(cat.content.map((article: Article) => ({ article })), MIN_CATEGORY_ARTICLES),
      targetUrl: `https://elhellal.com/${cat.category}`,
    });
  }

  for (const [screen_name, entries] of authorMap) {
    if (entries.length < MIN_AUTHOR_ARTICLES) continue;
    collectionPins.push({
      kind: 'author', key: screen_name, folder: 'authors', title: `@${screen_name}`, badge: 'كاتب',
      count: entries.length, color: entries[0].color,
      previewArticles: pickPreviewArticles(entries, MIN_AUTHOR_ARTICLES),
      targetUrl: `https://elhellal.com/authors/${screen_name}`,
    });
  }

  const pendingCollections = collectionPins.filter((pin) => !existingGuids.has(pin.targetUrl));
  console.log(`🏷️  ${collectionPins.length} collection pins qualify (tags≥${MIN_TAG_ARTICLES}, categories≥${MIN_CATEGORY_ARTICLES}, authors≥${MIN_AUTHOR_ARTICLES}) → ${pendingCollections.length} pending\n`);

  if (!batch.length && !pendingCollections.length) {
    console.log('✅  Nothing pending — articles and collection pins are all up to date.');
    return;
  }

  // 5. Puppeteer
  const BROWSER_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--disable-dev-shm-usage'];
  let browser = await puppeteer.launch({ args: BROWSER_ARGS });
  let page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 1500, deviceScaleFactor: 2 });

  async function ensurePage() {
    try {
      await page.evaluate(() => true);
    } catch {
      // Page or browser is dead — restart everything
      try { await browser.close(); } catch {}
      browser = await puppeteer.launch({ args: BROWSER_ARGS });
      page = await browser.newPage();
      await page.setViewport({ width: 1000, height: 1500, deviceScaleFactor: 2 });
    }
  }

  const tmpDir = path.join(tmpdir(), 'elhellal-pinterest-pins-tmp');
  if (STORAGE === 'r2') fs.mkdirSync(tmpDir, { recursive: true });

  async function capturePin(folder: string, filename: string) {
    if (STORAGE === 'local') {
      const dir = path.join(LOCAL_IMAGES, folder);
      fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, filename) as `${string}.png`, clip: { x: 0, y: 0, width: 1000, height: 1500 } });
    } else {
      const tmpPath = path.join(tmpDir, `${folder}-${filename}`);
      await page.screenshot({ path: tmpPath as `${string}.png`, clip: { x: 0, y: 0, width: 1000, height: 1500 } });
      const buffer = fs.readFileSync(tmpPath);
      await saveImage(folder, filename, buffer);
      fs.unlinkSync(tmpPath);
    }
  }

  const newFeedItems: { article: Article; category: string; imageFilename: string }[] = [];
  let success = 0, failed = 0;

  for (let i = 0; i < batch.length; i++) {
    const { article, category, catLabel, color } = batch[i];
    const imgFile = `${article.slug}.png`;
    const label = `[${i + 1}/${batch.length}]`;

    process.stdout.write(`${label} ${(article.title || '').slice(0, 50).padEnd(50)} `);

    const exists = await imageExists(category, imgFile);
    if (exists) {
      console.log('⏭  exists');
      newFeedItems.push({ article, category, imageFilename: imgFile });
      success++; continue;
    }

    try {
      await ensurePage();

      const imgUrl = article.original_img_url || '';
      let imageB64 = imgUrl ? await fetchImageAsBase64(imgUrl) : null;
      if (imageB64 && imageB64.length > 2_000_000) imageB64 = null; // skip oversized images
      if (!imageB64 && imgUrl) process.stdout.write('⚠️img ');

      await page.setContent(buildHTML(article, catLabel, color, imageB64), { waitUntil: 'domcontentloaded' });
      await Promise.race([
        page.evaluate(() => (document as any).fonts.ready),
        new Promise((r) => setTimeout(r, 5000)),
      ]).catch(() => {});

      await capturePin(category, imgFile);

      newFeedItems.push({ article, category, imageFilename: imgFile });
      console.log(`✅  [${color}]`);
      success++;
    } catch (err: any) {
      console.log(`❌  ${err.message}`);
      failed++;
    }
  }

  // 6. Collection pins (tags / categories / authors)
  const newCollectionFeedItems: { pin: CollectionPin; imageFilename: string }[] = [];
  let collectionSuccess = 0, collectionFailed = 0;

  for (let i = 0; i < pendingCollections.length; i++) {
    const pin = pendingCollections[i];
    const imgFile = `${pin.key}.png`;
    const label = `[${i + 1}/${pendingCollections.length}]`;

    process.stdout.write(`${label} [${pin.kind}] ${pin.title.slice(0, 40).padEnd(40)} `);

    const exists = await imageExists(pin.folder, imgFile);
    if (exists) {
      console.log('⏭  exists');
      newCollectionFeedItems.push({ pin, imageFilename: imgFile });
      collectionSuccess++; continue;
    }

    try {
      await ensurePage();

      const images = await Promise.all(
        pin.previewArticles.map(async (a) => {
          if (!a.image) return null;
          let b64 = await fetchImageAsBase64(a.image);
          if (b64 && b64.length > 1_500_000) b64 = null; // smaller cap — several images share one pin
          return b64;
        })
      );
      if (images.some((img, i) => !img && pin.previewArticles[i].image)) process.stdout.write('⚠️img ');

      await page.setContent(buildCollectionHTML(pin, images), { waitUntil: 'domcontentloaded' });
      await Promise.race([
        page.evaluate(() => (document as any).fonts.ready),
        new Promise((r) => setTimeout(r, 5000)),
      ]).catch(() => {});

      await capturePin(pin.folder, imgFile);

      newCollectionFeedItems.push({ pin, imageFilename: imgFile });
      console.log(`✅  [${pin.color}]`);
      collectionSuccess++;
    } catch (err: any) {
      console.log(`❌  ${err.message}`);
      collectionFailed++;
    }
  }

  await browser.close();

  // 7. Update feed.xml
  const newItemsXml = [
    ...newFeedItems.map(buildItemXml),
    ...newCollectionFeedItems.map(buildCollectionItemXml),
  ].join('\n');
  await writeFeedXml(assembleFeed(newItemsXml, existingItems));

  const totalInFeed = existingGuids.size + newFeedItems.length + newCollectionFeedItems.length;
  const remaining = pending.length - batch.length;

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅  ${success} articles generated   ❌  ${failed} failed
✅  ${collectionSuccess} collection pins generated   ❌  ${collectionFailed} failed
📦  Backend : ${STORAGE.toUpperCase()}${STORAGE === 'r2' ? ` → bucket: ${R2_BUCKET}` : `\n📁  Images  → ${LOCAL_IMAGES}`}
📄  feed.xml  now has ${totalInFeed} items
${remaining > 0 ? `⏳  ${remaining} articles still pending — run again to continue` : '🎉  All articles processed!'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

main().catch((err) => { console.error(err); process.exit(1); });
