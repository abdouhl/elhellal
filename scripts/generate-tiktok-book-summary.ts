#!/usr/bin/env bun
/**
 * TikTok "book summary" slideshow generator (Arabic / RTL) — الهلال
 * ------------------------------------------------------------------
 * Renders a TikTok photo-carousel that summarises ONE book from books.elhellal.com:
 * a cover slide (the book cover), a "what is it about" slide, one slide per key idea,
 * a "who should read it" slide, and a call-to-action slide that shows the cover again.
 * Same Puppeteer HTML->PNG pipeline and cream "paper" look as
 * scripts/generate-tiktok-quotes.ts, sized 1080x1350 (4:5).
 *
 * Usage:
 *   bun run scripts/generate-tiktok-book-summary.ts                    # next unused book
 *   bun run scripts/generate-tiktok-book-summary.ts --count 3          # 3 slideshows in one go
 *   bun run scripts/generate-tiktok-book-summary.ts --book عزازيل      # a specific book (by slug)
 *   bun run scripts/generate-tiktok-book-summary.ts --cta-image ./cta.png   # custom image on the CTA slide
 *   bun run scripts/generate-tiktok-book-summary.ts --books-file path/to/books.json
 *   bun run scripts/generate-tiktok-book-summary.ts --date 2026-09-20
 *   bun run scripts/generate-tiktok-book-summary.ts --dry-run
 *   bun run scripts/generate-tiktok-book-summary.ts --reset-history
 *
 * Source: ../elhellal-books/src/data/books.json (the sibling books.elhellal.com repo).
 * Selection: books run in file order, skipping any already used, so a book never repeats
 * until all have been used (history then wraps around). State lives in
 * tiktok-slides/book-summaries/history.json; --dry-run and --book do not touch it.
 *
 * Output (tiktok-slides/book-summaries/<date>/<NN>-<slug>/, repo root — never inside public/):
 *   01-cover.png, 02-about.png, 03-idea.png ... NN-who.png, NN-cta.png   — upload in this order
 *   caption.txt                                                          — caption + hashtags
 *   manifest.json                                                        — what was picked
 *
 * TikTok has no public API for a personal account to post a photo carousel —
 * this only generates the assets. Upload via the TikTok app (Post > Photo, add
 * all files in order, paste the caption).
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── CLI args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const COUNT = parseInt(getArg('--count') || '1', 10);
const BOOK_OVERRIDE = getArg('--book');
const CTA_IMAGE = getArg('--cta-image'); // local file or URL; defaults to the book cover
const DRY_RUN = args.includes('--dry-run');
const RESET_HISTORY = args.includes('--reset-history');
const DATE_OVERRIDE = getArg('--date'); // YYYY-MM-DD
const BOOKS_FILE = getArg('--books-file') || path.join(__dirname, '../../elhellal-books/src/data/books.json');
// Deliberately NOT under public/ — Astro copies everything in public/ into dist/, and these
// images are for manual upload to TikTok only; the site never serves them.
const OUT_ROOT = getArg('--out-dir') || path.join(__dirname, '../tiktok-slides/book-summaries');
const HISTORY_FILE = path.join(OUT_ROOT, 'history.json');

if (!Number.isFinite(COUNT) || COUNT < 1 || COUNT > 20) {
  console.error('❌  --count must be a number between 1 and 20.');
  process.exit(1);
}
if (!fs.existsSync(BOOKS_FILE)) {
  console.error(`❌  Books file not found: ${BOOKS_FILE}\n    Pass --books-file, or clone elhellal-books next to this repo.`);
  process.exit(1);
}
if (CTA_IMAGE && !/^https?:\/\//i.test(CTA_IMAGE) && !fs.existsSync(CTA_IMAGE)) {
  console.error(`❌  --cta-image not found: ${CTA_IMAGE}`);
  process.exit(1);
}

// ─── Geometry ───────────────────────────────────────────────────────────────
const W = 1080;
const H = 1350; // 4:5 — same ratio as the other TikTok/X scripts

// Goodreads covers are user-supplied: some are thumbnails, some landscape scans. Outside these
// bounds a cover looks broken at 600px tall, so that book is skipped.
const MIN_COVER_WIDTH = 180;
const MIN_COVER_RATIO = 0.55; // width / height
const MAX_COVER_RATIO = 0.85;

// ─── Helpers ────────────────────────────────────────────────────────────────
function xe(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function textSizeTier(text: string, tiers: [number, string][], fallback: string): string {
  for (const [max, name] of tiers) if (text.length <= max) return name;
  return fallback;
}

const MAX_IMG_DATA_URI_CHARS = 4_000_000;

/** Inlines a remote image as a data URI so Puppeteer never waits on an in-page request before screenshotting. */
function fetchImageAsBase64(url: string, hops = 0): Promise<string | null> {
  if (!/^https?:\/\//i.test(url) || hops > 4) return Promise.resolve(null);
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 12000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchImageAsBase64(new URL(res.headers.location, url).toString(), hops + 1).then(resolve);
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const mime = res.headers['content-type'] || 'image/jpeg';
        const uri = `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`;
        resolve(uri.length <= MAX_IMG_DATA_URI_CHARS ? uri : null);
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const MIME_BY_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

/** Remote URL or local file → data URI. */
async function loadImage(src: string): Promise<string | null> {
  if (/^https?:\/\//i.test(src)) return fetchImageAsBase64(src);
  const mime = MIME_BY_EXT[path.extname(src).toLowerCase()];
  if (!mime) return null;
  return `data:${mime};base64,${fs.readFileSync(src).toString('base64')}`;
}

// ─── Data loading ───────────────────────────────────────────────────────────
interface Book {
  slug: string;
  title: string;
  author: string;
  cover: string;
  year?: number;
  genre?: string;
  award?: string;
  summary: string;
  keyIdeas: string[];
  whoShouldRead: string;
}

function loadBooks(): Book[] {
  const books: Book[] = JSON.parse(fs.readFileSync(BOOKS_FILE, 'utf-8'));
  return books.filter((b) => b.cover && b.summary && b.keyIdeas?.length && b.whoShouldRead);
}

function loadHistory(): Set<string> {
  if (RESET_HISTORY) return new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

// ─── HTML templates (RTL / Arabic, cream "paper" look shared with the other slides) ─
function slideDocument(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html dir="rtl" lang="ar"><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:${W}px;height:${H}px;font-family:"Cairo",sans-serif;overflow:hidden}
  .slide{
    position:relative;width:${W}px;height:${H}px;overflow:hidden;direction:rtl;
    background:#f4ecdd;
    background-image:
      radial-gradient(circle at 15% 8%, rgba(200,112,63,0.10), transparent 42%),
      radial-gradient(circle at 90% 95%, rgba(200,112,63,0.08), transparent 45%);
    display:flex;flex-direction:column;
  }
  .grain{position:absolute;inset:0;opacity:.5;pointer-events:none;
    background-image:radial-gradient(rgba(60,45,30,.05) 1px, transparent 1px), radial-gradient(rgba(60,45,30,.035) 1.2px, transparent 1.2px);
    background-size:5px 5px, 11px 11px; background-position:0 0, 3px 4px;}
  .pad{position:relative;flex:1;display:flex;flex-direction:column;padding:72px 72px 56px}

  .topbar{display:flex;align-items:center;justify-content:space-between}
  .kicker{display:flex;align-items:center;gap:14px;font-size:28px;font-weight:700;color:#a85a2c}
  .kicker .dot{width:10px;height:10px;border-radius:50%;background:#c8703f}
  .counter{font-size:26px;font-weight:600;color:rgba(43,33,26,.4);direction:ltr}

  .footer{position:absolute;bottom:44px;left:72px;right:72px;z-index:2;display:flex;align-items:center;justify-content:space-between}
  .brand{font-size:24px;font-weight:700;color:#2b211a;direction:ltr;letter-spacing:.02em}
  .brand span{color:#c8703f}
  .swipe{display:flex;align-items:center;gap:12px;font-size:24px;font-weight:600;color:#6b4a2c}

  /* ── Cover slide ── */
  .cover-center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding-bottom:70px}
  .cover-img{height:600px;width:auto;max-width:520px;object-fit:contain;border-radius:6px;display:block;
    box-shadow:0 34px 60px rgba(43,33,26,.34), 0 10px 20px rgba(43,33,26,.22), inset 0 0 0 1px rgba(0,0,0,.08)}
  .cover-headline{font-family:"Amiri",serif;font-weight:700;color:#2b211a;line-height:1.4;margin-top:50px;font-size:62px}
  .cover-headline .accent{color:#c8703f}
  .cover-title{font-family:"Amiri",serif;font-weight:700;color:#a85a2c;line-height:1.35;margin-top:10px}
  .cover-title.lg{font-size:54px}
  .cover-title.md{font-size:46px}
  .cover-title.sm{font-size:38px}
  .cover-by{margin-top:12px;font-size:28px;font-weight:600;color:#6b4a2c}

  /* ── Text slides (about / idea / who) ── */
  .text-center{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;text-align:right;padding-bottom:40px}
  .label{display:inline-block;padding:10px 28px;border-radius:50px;background:#c8703f;color:#fff;font-size:30px;font-weight:700}
  .big-num{font-family:"Amiri",serif;font-size:220px;line-height:.9;color:#c8703f;opacity:.85;margin-top:10px}
  .body{font-family:"Amiri",serif;font-weight:700;color:#2b211a;margin-top:44px}
  .body.xl{font-size:74px;line-height:1.55}
  .body.lg{font-size:60px;line-height:1.6}
  .body.md{font-size:50px;line-height:1.7}
  .body.sm{font-size:42px;line-height:1.75}
  .accent-bar{width:76px;height:6px;background:#c8703f;border-radius:3px;margin-top:44px}
  .meta{margin-top:26px;font-size:30px;line-height:1.6;color:#5a4c3d}
  .meta b{color:#2b211a;font-weight:700}

  /* ── CTA slide ── */
  .cta-center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding-bottom:60px}
  .cta-thumb{height:340px;width:auto;max-width:520px;object-fit:contain;border-radius:5px;display:block;
    box-shadow:0 22px 40px rgba(43,33,26,.3), 0 6px 14px rgba(43,33,26,.2), inset 0 0 0 1px rgba(0,0,0,.08)}
  .cta-title{font-family:"Amiri",serif;font-weight:700;font-size:80px;line-height:1.35;color:#2b211a;margin-top:44px}
  .cta-title .accent{color:#c8703f}
  .cta-sub{margin-top:22px;font-size:32px;line-height:1.7;color:#5a4c3d;max-width:820px}
  .cta-actions{display:flex;gap:18px;margin-top:44px}
  .pill{padding:16px 34px;border-radius:50px;font-size:30px;font-weight:700}
  .pill.solid{background:#c8703f;color:#fff}
  .pill.line{border:2px solid rgba(43,33,26,.28);color:#2b211a}
  .cta-url{margin-top:38px;font-size:34px;font-weight:800;color:#2b211a;direction:ltr;letter-spacing:.02em}
  .cta-url span{color:#c8703f}
</style>
</head><body>
${bodyHtml}
</body></html>`;
}

const footerHtml = `<div class="footer"><span></span><div class="brand">elhellal<span>.com</span></div></div>`;

function topbar(b: Book, index?: number, total?: number): string {
  return `<div class="topbar">
      <div class="kicker"><span class="dot"></span>${xe(b.title)}</div>
      ${index !== undefined ? `<span class="counter">${index} / ${total}</span>` : ''}
    </div>`;
}

function buildCoverSlide(b: Book, imageUri: string): string {
  const titleTier = textSizeTier(b.title, [[18, 'lg'], [34, 'md']], 'sm');
  return slideDocument(`<div class="slide"><div class="grain"></div><div class="pad">
    <div class="topbar"><div class="kicker"><span class="dot"></span>ملخصات الكتب</div></div>
    <div class="cover-center">
      <img class="cover-img" src="${imageUri}" alt=""/>
      <h1 class="cover-headline">ملخص كتاب <span class="accent">في دقيقة</span></h1>
      <div class="cover-title ${titleTier}">${xe(b.title)}</div>
      <div class="cover-by">${xe(b.author)}</div>
    </div>
    <div class="footer">
      <div class="swipe">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="#6b4a2c" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        اسحب لليسار
      </div>
      <div class="brand">elhellal<span>.com</span></div>
    </div>
  </div></div>`);
}

function buildAboutSlide(b: Book, index: number, total: number): string {
  const tier = textSizeTier(b.summary, [[140, 'xl'], [220, 'lg'], [300, 'md']], 'sm');
  const meta = [b.genre, b.year].filter(Boolean).join(' · ');
  return slideDocument(`<div class="slide"><div class="grain"></div><div class="pad">
    ${topbar(b, index, total)}
    <div class="text-center">
      <span class="label">عن ماذا يتحدث الكتاب؟</span>
      <p class="body ${tier}">${xe(b.summary)}</p>
      <div class="accent-bar"></div>
      <p class="meta"><b>${xe(b.author)}</b>${meta ? ` · ${xe(meta)}` : ''}</p>
    </div>
    ${footerHtml}
  </div></div>`);
}

function buildIdeaSlide(b: Book, idea: string, n: number, index: number, total: number): string {
  const tier = textSizeTier(idea, [[50, 'xl'], [80, 'lg']], 'md');
  return slideDocument(`<div class="slide"><div class="grain"></div><div class="pad">
    ${topbar(b, index, total)}
    <div class="text-center">
      <span class="label">فكرة رئيسية</span>
      <div class="big-num">${n}</div>
      <p class="body ${tier}" style="margin-top:20px">${xe(idea)}</p>
    </div>
    ${footerHtml}
  </div></div>`);
}

function buildWhoSlide(b: Book, index: number, total: number): string {
  const tier = textSizeTier(b.whoShouldRead, [[80, 'xl'], [130, 'lg']], 'md');
  return slideDocument(`<div class="slide"><div class="grain"></div><div class="pad">
    ${topbar(b, index, total)}
    <div class="text-center">
      <span class="label">لمن هذا الكتاب؟</span>
      <p class="body ${tier}">${xe(b.whoShouldRead)}</p>
      <div class="accent-bar"></div>
      ${b.award ? `<p class="meta">🏆 ${xe(b.award)}</p>` : ''}
    </div>
    ${footerHtml}
  </div></div>`);
}

function buildCtaSlide(b: Book, imageUri: string): string {
  return slideDocument(`<div class="slide"><div class="grain"></div><div class="pad">
    <div class="topbar"><div class="kicker"><span class="dot"></span>المزيد على الهلال</div></div>
    <div class="cta-center">
      <img class="cta-thumb" src="${imageUri}" alt=""/>
      <h1 class="cta-title"><span class="accent">احفظ</span> المنشور<br/>وتابعنا للمزيد</h1>
      <p class="cta-sub">ملخصات كتب واقتباسات ومقالات عربية مختارة على الموقع</p>
      <div class="cta-actions"><span class="pill solid">تابع الحساب</span><span class="pill line">الرابط في البايو</span></div>
      <div class="cta-url">elhellal<span>.com</span></div>
    </div>
  </div></div>`);
}

// ─── Caption ────────────────────────────────────────────────────────────────
function hashtagify(s: string): string {
  return '#' + s.replace(/[^ء-يa-zA-Z0-9\s]/g, '').trim().split(/\s+/).join('_');
}

function buildCaption(b: Book): string {
  const tags = [
    hashtagify(b.title), hashtagify(b.author),
    ...(b.genre ? [hashtagify(b.genre)] : []),
    '#ملخص_كتاب', '#ملخصات_كتب', '#كتب', '#قراءة', '#الهلال', '#BookTok', '#كتاب_عربي',
  ];
  return [
    `📚 ملخص «${b.title}» — ${b.author}`,
    '',
    b.summary,
    '',
    'احفظ المنشور وارجع له قبل ما تقرر تقرأ الكتاب 🔖',
    'المزيد من الملخصات على elhellal.com (الرابط في البايو) 🔗',
    '',
    [...new Set(tags)].join(' '),
  ].join('\n');
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const now = DATE_OVERRIDE ? new Date(`${DATE_OVERRIDE}T12:00:00Z`) : new Date();
  const dateKey = DATE_OVERRIDE || isoDate(now);

  const all = loadBooks();
  let pool: Book[];
  if (BOOK_OVERRIDE) {
    pool = all.filter((b) => b.slug === BOOK_OVERRIDE);
    if (pool.length === 0) {
      console.error(`❌  No usable book with slug "${BOOK_OVERRIDE}" (needs a cover, summary, keyIdeas and whoShouldRead).`);
      process.exit(1);
    }
  } else {
    const history = loadHistory();
    pool = all.filter((b) => !history.has(b.slug));
    if (pool.length < COUNT) {
      console.log('🔁  Every book has been used — history wrapped around to the start of the list.');
      pool = all;
    }
  }

  console.log(`\n🎬  Building ${Math.min(COUNT, pool.length)} TikTok book-summary slideshow(s) for ${dateKey}\n`);

  if (DRY_RUN) {
    pool.slice(0, COUNT).forEach((b, i) => {
      console.log(`   ${i + 1}. ${b.title} — ${b.author}  (${b.keyIdeas.length} ideas, ${b.keyIdeas.length + 4} slides)`);
    });
    console.log('\n🧪  --dry-run: no files written, history not updated.');
    return;
  }

  const customCta = CTA_IMAGE ? await loadImage(CTA_IMAGE) : null;
  if (CTA_IMAGE && !customCta) {
    console.error(`❌  Could not read --cta-image ${CTA_IMAGE} (supported: png, jpg, webp, svg or a reachable URL).`);
    process.exit(1);
  }

  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

  async function renderSlide(html: string, file: string) {
    // 'load' (not 'domcontentloaded') so the Google Fonts stylesheet has applied before we ask
    // for faces: otherwise fonts.load()/fonts.ready see no faces, resolve instantly, and the
    // screenshot silently falls back to Cairo for the Amiri headings.
    await page.setContent(html, { waitUntil: 'load', timeout: 20000 }).catch(() => {
      console.warn('   ⚠️  Fonts did not finish loading in time — this image may use a fallback font.');
    });
    await Promise.race([
      page.evaluate(async () => {
        const fonts = (document as any).fonts;
        // The sample text matters: without it only the Latin subset of each face is fetched.
        const ar = 'أبتثجحخدذرزسشصضطظعغفقكلمنهوية';
        await Promise.all([
          fonts.load('700 48px "Amiri"', ar), fonts.load('600 24px "Cairo"', ar),
          fonts.load('700 24px "Cairo"', ar), fonts.load('800 24px "Cairo"', ar),
        ]);
        await fonts.ready;
      }),
      new Promise((r) => setTimeout(r, 10000)),
    ]);
    // No `clip` — page.screenshot({ clip }) returns a black image in this environment; a plain
    // screenshot at a viewport sized exactly W×H captures correctly.
    await page.screenshot({ path: file as `${string}.png` });
  }

  const history = loadHistory();
  const made: Book[] = [];
  const dayDir = path.join(OUT_ROOT, dateKey);

  // Walk the pool until enough slideshows are built — a book whose cover can't be used is skipped.
  for (const b of pool) {
    if (made.length >= COUNT) break;
    const coverUri = await fetchImageAsBase64(b.cover);
    if (!coverUri) { console.warn(`   ⚠️  Cover fetch failed for «${b.title}» — skipping.`); continue; }

    const dir = path.join(dayDir, `${String(made.length + 1).padStart(2, '0')}-${b.slug}`);
    fs.mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    const nn = (n: number) => String(n).padStart(2, '0');
    // cover + about + ideas + who + cta
    const total = b.keyIdeas.length + 4;

    // Cover first: it doubles as the image-quality check (natural size is only known once rendered).
    const coverFile = `${nn(1)}-cover.png`;
    await renderSlide(buildCoverSlide(b, coverUri), path.join(dir, coverFile));
    const { w, h } = await page.evaluate(() => {
      const img = document.querySelector('.cover-img') as HTMLImageElement | null;
      return { w: img?.naturalWidth ?? 0, h: img?.naturalHeight ?? 0 };
    });
    const ratio = h ? w / h : 0;
    if (w < MIN_COVER_WIDTH || ratio < MIN_COVER_RATIO || ratio > MAX_COVER_RATIO) {
      console.warn(`   ⚠️  Cover for «${b.title}» is unusable (${w}×${h}) — skipping.`);
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }
    files.push(coverFile);

    let n = 2;
    const aboutFile = `${nn(n)}-about.png`;
    await renderSlide(buildAboutSlide(b, n - 1, total - 2), path.join(dir, aboutFile));
    files.push(aboutFile); n++;

    for (let i = 0; i < b.keyIdeas.length; i++, n++) {
      const f = `${nn(n)}-idea.png`;
      await renderSlide(buildIdeaSlide(b, b.keyIdeas[i], i + 1, n - 1, total - 2), path.join(dir, f));
      files.push(f);
    }

    const whoFile = `${nn(n)}-who.png`;
    await renderSlide(buildWhoSlide(b, n - 1, total - 2), path.join(dir, whoFile));
    files.push(whoFile); n++;

    const ctaFile = `${nn(n)}-cta.png`;
    await renderSlide(buildCtaSlide(b, customCta ?? coverUri), path.join(dir, ctaFile));
    files.push(ctaFile);

    fs.writeFileSync(path.join(dir, 'caption.txt'), buildCaption(b), 'utf-8');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      date: dateKey, generatedAt: new Date().toISOString(), slug: b.slug, title: b.title, author: b.author,
      ctaImage: CTA_IMAGE ?? 'book cover', slides: files,
    }, null, 2), 'utf-8');

    console.log(`   ✅  ${path.relative(process.cwd(), dir)}/  — ${files.length} slides · ${b.title}`);
    made.push(b);
    if (!BOOK_OVERRIDE) history.add(b.slug);
  }

  await browser.close();

  if (made.length === 0) {
    console.error('❌  Nothing was generated.');
    process.exit(1);
  }
  if (!BOOK_OVERRIDE) {
    fs.mkdirSync(OUT_ROOT, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([...history], null, 2), 'utf-8');
  }

  console.log(`\n🎉  Done — ${made.length} slideshow(s) in ${path.relative(process.cwd(), dayDir)}/`);
  console.log('📋  Per folder: upload the PNGs in numeric order via the TikTok app (Post > Photo), paste caption.txt.');
}

main().catch((err) => {
  console.error('❌  Failed:', err);
  process.exit(1);
});
