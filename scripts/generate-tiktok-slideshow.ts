#!/usr/bin/env bun
/**
 * TikTok "articles to read" slideshow generator (Arabic / RTL) — الهلال
 * -----------------------------------------------------------------------
 * Renders a daily TikTok photo-carousel: a cover slide, one slide per
 * featured article, and a save/follow outro slide — light, paper-textured,
 * serif-on-cream aesthetic (the "reading list" genre: e.g. accounts like
 * @thyvcaerllia, @ningcollective, @kvn.in). Same Puppeteer HTML->PNG
 * pipeline as scripts/generate-pinterest-pin.ts, sized for TikTok's photo
 * post spec (1080x1350) instead of Pinterest's.
 *
 * Usage:
 *   bun run scripts/generate-tiktok-slideshow.ts
 *   bun run scripts/generate-tiktok-slideshow.ts --count 6
 *   bun run scripts/generate-tiktok-slideshow.ts --date 2026-09-18
 *   bun run scripts/generate-tiktok-slideshow.ts --dry-run
 *   bun run scripts/generate-tiktok-slideshow.ts --reset-history
 *
 * Selection: the --count newest articles (across all categories) that
 * haven't appeared in a previous run are picked, so a "daily series" run
 * never repeats an article until every article has been featured once —
 * at which point history wraps around automatically. State lives in
 * tiktok-slides/history.json (a flat list of used slugs); a
 * successful run appends to it, a --dry-run does not.
 *
 * Output (tiktok-slides/<date>/, repo root — never inside public/ or dist/):
 *   01-cover.png, 02-article.png, ... , NN-outro.png   — upload manually,
 *                                                         in this order
 *   caption.txt                                        — ready-to-paste
 *                                                         caption + hashtags
 *   manifest.json                                      — which slugs/files,
 *                                                         for your own records
 *
 * TikTok has no public API for a personal account to post a photo
 * carousel programmatically — this only generates the assets. Upload them
 * via the TikTok app (Post > Photo, add all files in order, paste the
 * caption).
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import type { Article, ArticlesConfig, Category } from '../src/types/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── CLI args ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const COUNT = parseInt(getArg('--count') || '5', 10);
const DRY_RUN = args.includes('--dry-run');
const RESET_HISTORY = args.includes('--reset-history');
const DATE_OVERRIDE = getArg('--date'); // YYYY-MM-DD
const ARTICLES_FILE = getArg('--articles-file') || path.join(__dirname, '../src/data/articles.json');
// Deliberately NOT under public/ — Astro copies everything in public/ verbatim into dist/,
// so slideshow PNGs living there would ship to production and eat back into the Cloudflare
// Workers static-asset budget (see the 20,000-file limit fix elsewhere in this project).
// These images are for manual upload to TikTok only; the site never serves them.
const OUT_ROOT = getArg('--out-dir') || path.join(__dirname, '../tiktok-slides');
const HISTORY_FILE = path.join(OUT_ROOT, 'history.json');

if (!Number.isFinite(COUNT) || COUNT < 1 || COUNT > 12) {
  console.error('❌  --count must be a number between 1 and 12.');
  process.exit(1);
}

// ─── Slide geometry — TikTok photo-post spec ───────────────────────────────
const W = 1080;
const H = 1350; // 4:5 — the ratio this "aesthetic reading list" genre consistently uses

// ─── Helpers ────────────────────────────────────────────────────────────────
function xe(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Same length-tiered auto-sizing idea as the Pinterest pin/quote cards: short titles get a bigger, poster-like treatment. */
function titleSizeTier(text: string): 'xl' | 'lg' | 'md' | 'sm' {
  const len = text.length;
  if (len <= 40) return 'xl';
  if (len <= 80) return 'lg';
  if (len <= 130) return 'md';
  return 'sm';
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.trim().replace(/[.…,،:؛-]+$/, '')}…`;
}

/** Fetches a remote image and inlines it as a data URI so Puppeteer never has to wait on an
 *  in-page network request before screenshotting (same approach as generate-pinterest-pin.ts). */
function fetchImageAsBase64(url: string): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return Promise.resolve(null);
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
const MAX_IMG_DATA_URI_CHARS = 2_000_000; // guards against Puppeteer crashing on an oversized inline image

const ARABIC_WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const ARABIC_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
function formatArabicDate(d: Date): string {
  return `${ARABIC_WEEKDAYS[d.getDay()]} ${d.getDate()} ${ARABIC_MONTHS[d.getMonth()]}`;
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── Data loading ───────────────────────────────────────────────────────────
interface FeaturedArticle {
  article: Article;
  categoryTitle: string;
}

function loadCandidateArticles(): FeaturedArticle[] {
  const data: ArticlesConfig = JSON.parse(fs.readFileSync(ARTICLES_FILE, 'utf-8'));
  const all: FeaturedArticle[] = [];
  (data.articles as Category[]).forEach((cat) => {
    cat.content.forEach((article) => {
      if (!article.slug || !article.title) return;
      all.push({ article, categoryTitle: cat.title });
    });
  });
  all.sort((a, b) => new Date(b.article.created_at).getTime() - new Date(a.article.created_at).getTime());
  return all;
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

function pickFeatured(all: FeaturedArticle[], history: Set<string>, count: number): FeaturedArticle[] {
  let pool = all.filter(({ article }) => !history.has(article.slug!));
  let wrapped = false;
  if (pool.length < count) {
    // Every remaining article has already been featured before — start the cycle over.
    wrapped = true;
    pool = all;
  }
  if (wrapped) console.log('🔁  Fresh article pool exhausted — history wrapped around to the top of the newest list.');
  return pool.slice(0, count);
}

// ─── HTML template (RTL / Arabic, light "reading list" aesthetic) ─────────
function slideDocument(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html dir="rtl" lang="ar"><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Cairo:wght@400;500;600;700;800&display=swap" rel="stylesheet">
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
  /* Subtle paper grain — layered radial dots at two scales, avoids a flat digital look */
  .grain{position:absolute;inset:0;opacity:.5;pointer-events:none;
    background-image:radial-gradient(rgba(60,45,30,.05) 1px, transparent 1px), radial-gradient(rgba(60,45,30,.035) 1.2px, transparent 1.2px);
    background-size:5px 5px, 11px 11px; background-position:0 0, 3px 4px;}

  .pad{position:relative;flex:1;display:flex;flex-direction:column;padding:72px 64px 56px}

  .kicker{display:flex;align-items:center;gap:14px;font-family:"Cairo",sans-serif;font-size:24px;font-weight:700;color:#a85a2c;letter-spacing:.01em}
  .kicker .dot{width:8px;height:8px;border-radius:50%;background:#c8703f}

  /* Row holding the category pill + page counter. In an RTL flex row the first child (the
     pill) lands on the right — where Arabic reading starts — and the counter trails on the
     left; --overlay positions the same row over a photo instead of flowing inside .pad. */
  .topbar{position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between}
  .topbar--overlay{position:absolute;top:40px;left:40px;right:40px}
  .cat-pill{padding:8px 22px;border:1.5px solid rgba(43,33,26,.18);border-radius:40px;color:#6b4a2c;font-size:22px;font-weight:600}
  .cat-pill--photo{background:rgba(255,255,255,.18);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-color:rgba(255,255,255,.45);color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.35)}
  .counter{font-family:"Cairo",sans-serif;font-size:22px;font-weight:600;color:rgba(43,33,26,.4);direction:ltr}
  .counter--photo{color:rgba(255,255,255,.92);text-shadow:0 1px 6px rgba(0,0,0,.5)}

  .article-center{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:flex-end;text-align:right}

  h1.headline{font-family:"Amiri",serif;font-weight:700;color:#2b211a;line-height:1.42;margin-top:34px;
    display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
  h1.headline.xl{font-size:66px;-webkit-line-clamp:5}
  h1.headline.lg{font-size:54px;-webkit-line-clamp:5}
  h1.headline.md{font-size:44px;-webkit-line-clamp:6}
  h1.headline.sm{font-size:36px;-webkit-line-clamp:7}
  /* Photo slides have less vertical room below the image, so each tier runs a notch smaller. */
  .photo-content h1.headline.xl{font-size:52px;-webkit-line-clamp:3}
  .photo-content h1.headline.lg{font-size:44px;-webkit-line-clamp:3}
  .photo-content h1.headline.md{font-size:38px;-webkit-line-clamp:4}
  .photo-content h1.headline.sm{font-size:32px;-webkit-line-clamp:4}

  .accent-bar{width:68px;height:5px;background:#c8703f;border-radius:3px;margin-top:24px}

  .hook{margin-top:26px;font-size:30px;line-height:1.75;color:#5a4c3d;font-weight:400;
    display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;-webkit-line-clamp:3}
  .photo-content .hook{font-size:26px;line-height:1.7;-webkit-line-clamp:2}

  .attribution{display:flex;align-items:center;gap:14px;padding-top:28px;border-top:1.5px solid rgba(43,33,26,.14)}
  .attribution .by{font-size:22px;color:rgba(43,33,26,.55);direction:ltr}

  .footer{position:absolute;bottom:44px;left:64px;right:64px;z-index:2;display:flex;align-items:center;justify-content:space-between}
  .brand{font-family:"Cairo",sans-serif;font-size:24px;font-weight:700;color:#2b211a;direction:ltr;letter-spacing:.02em}
  .brand span{color:#c8703f}

  /* ── Article slide, photo variant: full-bleed cover image fading into the cream panel ── */
  .photo-layout{position:relative;flex:1;display:flex;flex-direction:column}
  .photo-block{position:relative;width:100%;height:742px;flex-shrink:0;overflow:hidden;background:#e5dbc5}
  .photo-block img{width:100%;height:100%;object-fit:cover;object-position:center top;display:block}
  .photo-fade{position:absolute;inset:0;
    background:linear-gradient(180deg, rgba(20,15,10,.10) 0%, rgba(20,15,10,.04) 38%, rgba(244,236,221,.5) 80%, #f4ecdd 100%)}
  .photo-content{position:relative;flex:1;display:flex;flex-direction:column;justify-content:center;align-items:flex-end;text-align:right;padding:8px 64px 52px}

  /* ── Cover slide ── */
  .cover-center{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:flex-end;text-align:right}
  .cover-date{font-size:24px;color:rgba(43,33,26,.5);margin-bottom:18px}
  .cover-title{font-family:"Amiri",serif;font-weight:700;font-size:76px;line-height:1.4;color:#2b211a}
  .cover-title .accent{color:#c8703f}
  .cover-sub{margin-top:26px;font-size:30px;color:#5a4c3d;max-width:820px}
  .cover-strip{display:flex;gap:18px;margin-top:42px}
  .cover-thumb{width:112px;height:150px;border-radius:12px;object-fit:cover;flex-shrink:0;
    box-shadow:0 12px 26px rgba(43,33,26,.28), 0 0 0 5px #f4ecdd}
  .cover-thumb:nth-child(2){transform:rotate(-3deg)}
  .cover-thumb:nth-child(3){transform:rotate(2deg)}
  .cover-thumb:nth-child(4){transform:rotate(-2deg)}
  .cover-thumb:nth-child(5){transform:rotate(3deg)}
  .swipe{position:absolute;bottom:120px;left:64px;z-index:2;display:flex;align-items:center;gap:12px;font-size:24px;font-weight:600;color:#6b4a2c}

  /* ── Outro slide ── */
  .outro-center{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:flex-end;text-align:right}
  .outro-title{font-family:"Amiri",serif;font-weight:700;font-size:70px;line-height:1.4;color:#2b211a}
  .outro-sub{margin-top:24px;font-size:30px;color:#5a4c3d}
  .recap{margin-top:44px;width:100%}
  .recap-row{display:flex;align-items:center;gap:16px;padding:14px 0;border-top:1px solid rgba(43,33,26,.14)}
  .recap-row:first-child{border-top:none}
  .recap-num{font-family:"Cairo",sans-serif;font-weight:700;font-size:24px;color:#c8703f;flex-shrink:0}
  .recap-thumb{width:64px;height:64px;border-radius:10px;object-fit:cover;flex-shrink:0;background:#e5dbc5}
  .recap-title{flex:1;font-size:26px;color:#2b211a;line-height:1.5;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;-webkit-line-clamp:2}
</style>
</head><body>
${bodyHtml}
</body></html>`;
}

function buildCoverSlide(count: number, date: Date, thumbs: string[]): string {
  const strip = thumbs.length
    ? `<div class="cover-strip">${thumbs.slice(0, 5).map((src) => `<img class="cover-thumb" src="${src}" alt=""/>`).join('')}</div>`
    : '';
  return slideDocument(`<div class="slide"><div class="grain"></div><div class="pad">
    <div class="kicker"><span class="dot"></span>سلسلة يومية · قراءات الهلال</div>
    <div class="cover-center">
      <div class="cover-date">${xe(formatArabicDate(date))}</div>
      <h1 class="cover-title">${count} مقالات <span class="accent">تستحق</span><br/>وقتك اليوم</h1>
      <p class="cover-sub">مقالات عربية منتقاة بعناية من مصادر متنوعة على Substack</p>
      ${strip}
    </div>
    <div class="swipe">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="#6b4a2c" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      اسحب لليسار للمزيد
    </div>
    <div class="footer"><span></span><div class="brand">elhellal<span>.com</span></div></div>
  </div></div>`);
}

function buildArticleSlide(item: FeaturedArticle, index: number, total: number, imageDataUri: string | null): string {
  const { article, categoryTitle } = item;
  const tier = titleSizeTier(article.title);
  const hook = truncate(article.tldr || article.preview_text || '', 130);
  const by = article.screen_name ? `<div class="attribution"><span class="by">@${xe(article.screen_name)}</span></div>` : '';

  if (imageDataUri) {
    return slideDocument(`<div class="slide"><div class="grain"></div>
      <div class="photo-layout">
        <div class="photo-block">
          <img src="${imageDataUri}" alt=""/>
          <div class="photo-fade"></div>
          <div class="topbar topbar--overlay">
            <span class="cat-pill cat-pill--photo">${xe(categoryTitle)}</span>
            <span class="counter counter--photo">${index + 1} / ${total}</span>
          </div>
        </div>
        <div class="photo-content">
          <h1 class="headline ${tier}">${xe(article.title)}</h1>
          <div class="accent-bar"></div>
          ${hook ? `<p class="hook">${xe(hook)}</p>` : ''}
          ${by}
        </div>
      </div>
      <div class="footer"><span></span><div class="brand">elhellal<span>.com</span></div></div>
    </div>`);
  }

  return slideDocument(`<div class="slide"><div class="grain"></div><div class="pad">
    <div class="topbar">
      <span class="cat-pill">${xe(categoryTitle)}</span>
      <span class="counter">${index + 1} / ${total}</span>
    </div>
    <div class="article-center">
      <h1 class="headline ${tier}">${xe(article.title)}</h1>
      <div class="accent-bar"></div>
      ${hook ? `<p class="hook">${xe(hook)}</p>` : ''}
    </div>
    ${by}
    <div class="footer"><span></span><div class="brand">elhellal<span>.com</span></div></div>
  </div></div>`);
}

function buildOutroSlide(items: FeaturedArticle[], images: Map<string, string>): string {
  const rows = items.map(({ article }, i) => {
    const thumb = article.slug ? images.get(article.slug) : null;
    return `
    <div class="recap-row">
      <span class="recap-num">${i + 1}</span>
      ${thumb ? `<img class="recap-thumb" src="${thumb}" alt=""/>` : ''}
      <span class="recap-title">${xe(article.title)}</span>
    </div>`;
  }).join('');
  return slideDocument(`<div class="slide"><div class="grain"></div><div class="pad">
    <div class="kicker"><span class="dot"></span>احفظ للاحقاً</div>
    <div class="outro-center">
      <h1 class="outro-title">احفظ هذا المنشور 🔖</h1>
      <p class="outro-sub">المقالات الكاملة على elhellal.com — تابعنا لقراءات يومية جديدة</p>
      <div class="recap">${rows}</div>
    </div>
    <div class="footer"><span></span><div class="brand">elhellal<span>.com</span></div></div>
  </div></div>`);
}

function buildCaption(items: FeaturedArticle[], date: Date): string {
  const list = items.map(({ article }, i) => `${i + 1}. ${article.title}`).join('\n');
  return [
    '📚 قراءات اليوم من الهلال',
    '',
    list,
    '',
    'المقالات الكاملة على elhellal.com (الرابط في البايو) 🔗',
    'احفظ المنشور وارجع له لاحقاً 🔖',
    '',
    '#قراءة #كتب #مقالات #الهلال #اقرأ_معي #ثقافة #ReadingList #ArticlesToRead #ArabicContent #Substack #BookTok',
  ].join('\n');
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const now = DATE_OVERRIDE ? new Date(`${DATE_OVERRIDE}T12:00:00Z`) : new Date();
  const dateKey = DATE_OVERRIDE || isoDate(now);

  const all = loadCandidateArticles();
  const history = loadHistory();
  const featured = pickFeatured(all, history, COUNT);

  if (featured.length === 0) {
    console.error('❌  No articles available to feature.');
    process.exit(1);
  }
  if (featured.length < COUNT) {
    console.warn(`⚠️  Only ${featured.length} articles available (asked for ${COUNT}).`);
  }

  console.log(`\n🎬  Building TikTok slideshow for ${dateKey} — ${featured.length} articles:\n`);
  featured.forEach(({ article }, i) => console.log(`   ${i + 1}. ${article.title}`));
  console.log('');

  if (DRY_RUN) {
    console.log('🧪  --dry-run: no files written, history not updated.');
    return;
  }

  const outDir = path.join(OUT_ROOT, dateKey);
  fs.mkdirSync(outDir, { recursive: true });

  process.stdout.write('🖼  Fetching cover images… ');
  const images = new Map<string, string>();
  await Promise.all(featured.map(async ({ article }) => {
    if (!article.slug || !article.original_img_url) return;
    const dataUri = await fetchImageAsBase64(article.original_img_url);
    if (dataUri && dataUri.length <= MAX_IMG_DATA_URI_CHARS) images.set(article.slug, dataUri);
  }));
  console.log(`${images.size}/${featured.length} fetched\n`);

  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

  async function renderSlide(html: string, filename: string) {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await Promise.race([
      page.evaluate(() => (document as any).fonts.ready),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    // No `clip` here — in this environment page.screenshot({ clip }) reliably returns a black
    // image even on a correctly-rendered page (a Puppeteer/Chromium quirk), while a plain
    // screenshot at a viewport already sized exactly to W×H captures correctly with no crop needed.
    await page.screenshot({ path: path.join(outDir, filename) as `${string}.png` });
    console.log(`   🖼  ${filename}`);
  }

  const slideFiles: string[] = [];

  const coverFile = '01-cover.png';
  await renderSlide(buildCoverSlide(featured.length, now, [...images.values()]), coverFile);
  slideFiles.push(coverFile);

  for (let i = 0; i < featured.length; i++) {
    const filename = `${String(i + 2).padStart(2, '0')}-article-${featured[i].article.slug}.png`;
    const imageDataUri = featured[i].article.slug ? images.get(featured[i].article.slug!) || null : null;
    await renderSlide(buildArticleSlide(featured[i], i, featured.length, imageDataUri), filename);
    slideFiles.push(filename);
  }

  const outroFile = `${String(featured.length + 2).padStart(2, '0')}-outro.png`;
  await renderSlide(buildOutroSlide(featured, images), outroFile);
  slideFiles.push(outroFile);

  await browser.close();

  const caption = buildCaption(featured, now);
  fs.writeFileSync(path.join(outDir, 'caption.txt'), caption, 'utf-8');

  const manifest = {
    date: dateKey,
    generatedAt: new Date().toISOString(),
    slides: slideFiles,
    articles: featured.map(({ article, categoryTitle }) => ({ slug: article.slug, title: article.title, category: categoryTitle })),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  featured.forEach(({ article }) => history.add(article.slug!));
  fs.writeFileSync(HISTORY_FILE, JSON.stringify([...history], null, 2), 'utf-8');

  console.log(`\n✅  Done — ${slideFiles.length} slides in ${path.relative(process.cwd(), outDir)}/`);
  console.log('📋  Caption saved to caption.txt — upload the PNGs in numeric order via the TikTok app (Post > Photo).');
}

main().catch((err) => {
  console.error('❌  Failed:', err);
  process.exit(1);
});
