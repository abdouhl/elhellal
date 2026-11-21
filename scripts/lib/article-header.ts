/**
 * Header (cover) images for house-persona articles — الهلال
 * ----------------------------------------------------------
 * The admin panel's Personas tab draws one for each generated draft
 * (.drafts/house/<draft>.webp) and, on Approve, moves it to
 * public/thumbs/<slug>.webp, which the post's `thumb:` frontmatter points at.
 *
 * 1600×840 (≈1.91:1, the OG size). Pages crop the cover to 16:7 and cards to
 * 16:9, so everything that matters sits inside the middle 1440×640.
 */
import puppeteer, { type Browser } from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const W = 1600;
const H = 840;

export interface HeaderInput {
    title: string;
    /** Persona display name (Arabic). */
    author: string;
    /** Small label above the title: the persona's tagline or the draft's topic. */
    kicker?: string | undefined;
    /** #rrggbb */
    accent?: string | undefined;
}

const xe = (s: unknown) =>
    String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const hex = (c: string | undefined) => (/^#[0-9a-f]{6}$/i.test(c ?? '') ? c! : '#c8703f');

/** Title size by length, so short titles fill the image and long ones still fit in three lines. */
function titleSize(t: string) {
    const n = t.length;
    return n <= 30 ? 92 : n <= 50 ? 80 : n <= 75 ? 68 : n <= 100 ? 58 : 50;
}

export function headerHtml(h: HeaderInput): string {
    const accent = hex(h.accent);
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Amiri:wght@700&family=Cairo:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:${W}px;height:${H}px;overflow:hidden;font-family:"Cairo",sans-serif;background:#101114}
.bg{position:absolute;inset:0;
  background:
    radial-gradient(ellipse 70% 90% at 12% 50%, ${accent}55, transparent 62%),
    radial-gradient(ellipse 50% 60% at 95% 0%, ${accent}26, transparent 70%),
    linear-gradient(135deg,#15171c 0%,#0d0e11 100%)}
.grain{position:absolute;inset:0;opacity:.35;background-image:radial-gradient(rgba(255,255,255,.05) 1px,transparent 1px);background-size:6px 6px}
.moon{position:absolute;left:150px;top:50%;width:420px;height:420px;transform:translateY(-50%);border-radius:50%;
  box-shadow:inset -58px 0 0 0 ${accent};opacity:.9;filter:drop-shadow(0 0 60px ${accent}88)}
.lines{position:absolute;left:0;top:0;bottom:0;width:46%;opacity:.12;
  background-image:repeating-linear-gradient(90deg,#fff 0 1px,transparent 1px 48px)}
.pad{position:absolute;top:120px;bottom:120px;right:140px;width:880px;display:flex;flex-direction:column;justify-content:center}
.kicker{display:flex;align-items:center;gap:14px;font-size:30px;font-weight:700;color:#fff;opacity:.92;margin-bottom:30px}
.kicker .dot{width:14px;height:14px;border-radius:50%;background:${accent};box-shadow:0 0 18px ${accent}}
.title{font-family:"Amiri",serif;font-weight:700;color:#f4f1ec;line-height:1.42;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.bar{width:96px;height:7px;border-radius:4px;background:${accent};margin:34px 0 26px}
.by{font-size:32px;font-weight:600;color:#d9d5ce}
.brand{position:absolute;left:150px;bottom:128px;font-size:28px;font-weight:700;color:rgba(255,255,255,.75);direction:ltr;letter-spacing:.02em}
.brand span{color:${accent}}
</style></head><body>
<div class="bg"></div><div class="lines"></div><div class="grain"></div><div class="moon"></div>
<div class="pad">
  ${h.kicker ? `<div class="kicker"><span class="dot"></span>${xe(h.kicker)}</div>` : ''}
  <h1 class="title" style="font-size:${titleSize(h.title)}px">${xe(h.title)}</h1>
  <div class="bar"></div>
  <div class="by">${xe(h.author)}</div>
</div>
<div class="brand">elhellal<span>.com</span></div>
</body></html>`;
}

/** Renders each header to its `out` path (.webp). Returns the paths that failed. */
export async function renderHeaders(jobs: { out: string; header: HeaderInput }[]): Promise<string[]> {
    const failed: string[] = [];
    if (!jobs.length) return failed;
    let browser: Browser | null = null;
    try {
        browser = await puppeteer.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });
        const page = await browser.newPage();
        await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
        for (const { out, header } of jobs) {
            try {
                await page.setContent(headerHtml(header), { waitUntil: 'load', timeout: 30_000 });
                await page.evaluate(() => document.fonts.ready);
                fs.mkdirSync(path.dirname(out), { recursive: true });
                await page.screenshot({ path: out as `${string}.webp`, type: 'webp', quality: 86 });
            } catch (e) {
                console.warn(`header ${out} failed: ${(e as Error).message}`);
                failed.push(out);
            }
        }
    } finally {
        await browser?.close();
    }
    return failed;
}
