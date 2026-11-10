/**
 * Image cards for X posts — الهلال
 * --------------------------------
 * Posts with an image reach more people on X than bare link posts, so article,
 * quote, biography and quiz posts get a 1080×1350 (4:5) card in the same cream
 * "paper" look as the book/lesson cards (../elhellal-quotes/scripts/generate-book-tweet.ts).
 *
 * Cards are written to x-posts/cards/<name>.jpg; the snippet attaches them from the
 * picked x-posts folder (or the one-click runner hands them over directly).
 */
import puppeteer, { type Browser } from 'puppeteer';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const W = 1080;
const H = 1350;

export type Card =
    | { kind: 'article'; kicker: string; title: string; hook: string; author?: string }
    | { kind: 'quote'; text: string; author: string; book?: string }
    | { kind: 'bio'; kicker: string; name: string; years: string; tagline: string; photo?: string }
    | { kind: 'quiz'; kicker: string; question: string; options: string[] };

const xe = (s: unknown) =>
    String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Font size class by length, so short lines fill the card and long ones still fit. */
const tier = (s: string, steps: number[]) => ['xl', 'lg', 'md', 'sm', 'xs'][steps.findIndex((n) => s.length <= n) < 0 ? steps.length : steps.findIndex((n) => s.length <= n)];

function doc(body: string, site = 'elhellal.com'): string {
    const [name, tld] = site.split(/\.(?=[^.]+$)/);
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:${W}px;height:${H}px;font-family:"Cairo",sans-serif;overflow:hidden}
.slide{position:relative;width:${W}px;height:${H}px;overflow:hidden;background:#f4ecdd;display:flex;flex-direction:column;
  background-image:radial-gradient(circle at 15% 8%,rgba(200,112,63,.10),transparent 42%),radial-gradient(circle at 90% 95%,rgba(200,112,63,.08),transparent 45%)}
.grain{position:absolute;inset:0;opacity:.5;background-image:radial-gradient(rgba(60,45,30,.05) 1px,transparent 1px),radial-gradient(rgba(60,45,30,.035) 1.2px,transparent 1.2px);background-size:5px 5px,11px 11px;background-position:0 0,3px 4px}
.pad{position:relative;flex:1;display:flex;flex-direction:column;padding:80px 80px 130px}
.kicker{display:flex;align-items:center;gap:14px;font-size:30px;font-weight:700;color:#a85a2c}
.kicker .dot{width:11px;height:11px;border-radius:50%;background:#c8703f}
.center{flex:1;display:flex;flex-direction:column;justify-content:center}
.footer{position:absolute;bottom:52px;left:80px;right:80px;display:flex;align-items:center;justify-content:space-between}
.brand{font-size:26px;font-weight:700;color:#2b211a;direction:ltr;letter-spacing:.02em}.brand span{color:#c8703f}
.by{font-size:28px;font-weight:600;color:#6b4a2c}
.bar{width:84px;height:7px;background:#c8703f;border-radius:4px;margin:44px 0 34px}
.title{font-family:"Amiri",serif;font-weight:700;color:#2b211a;line-height:1.45}
.title.xl{font-size:92px}.title.lg{font-size:78px}.title.md{font-size:66px}.title.sm{font-size:56px}.title.xs{font-size:48px}
.hook{font-size:36px;line-height:1.75;color:#4a3b2d;font-weight:600}
.hook.sm{font-size:32px}
.qmark{font-family:"Amiri",serif;font-size:200px;line-height:1;color:#c8703f;opacity:.85;height:90px}
.quote{font-family:"Amiri",serif;font-weight:700;color:#2b211a}
.quote.xl{font-size:84px;line-height:1.55}.quote.lg{font-size:70px;line-height:1.6}.quote.md{font-size:58px;line-height:1.65}.quote.sm{font-size:48px;line-height:1.7}.quote.xs{font-size:41px;line-height:1.75}
.source{font-size:32px;color:#5a4c3d}.source b{color:#2b211a}
.photo{width:300px;height:300px;border-radius:50%;object-fit:cover;box-shadow:0 24px 50px rgba(43,33,26,.3);margin-bottom:56px;filter:sepia(.25)}
.years{font-size:40px;font-weight:700;color:#a85a2c;margin-top:18px;direction:ltr;text-align:right}
.opts{display:flex;flex-direction:column;gap:22px;margin-top:56px}
.opt{display:flex;align-items:center;gap:26px;background:rgba(255,255,255,.55);border:2px solid rgba(168,90,44,.25);border-radius:22px;padding:22px 30px;font-size:40px;font-weight:700;color:#2b211a}
.opt b{flex:none;width:64px;height:64px;border-radius:50%;background:#c8703f;color:#fff;display:flex;align-items:center;justify-content:center;font-size:34px}
.opts.small .opt{font-size:34px;padding:16px 26px}
</style></head><body><div class="slide"><div class="grain"></div><div class="pad">${body}</div>
<div class="footer"><span class="by" id="by"></span><div class="brand">${xe(name)}<span>.${xe(tld)}</span></div></div></div></body></html>`;
}

const kicker = (s: string) => `<div class="kicker"><span class="dot"></span>${xe(s)}</div>`;
const LETTERS = ['أ', 'ب', 'ج', 'د', 'هـ', 'و'];

export function cardHtml(c: Card): string {
    switch (c.kind) {
        case 'article':
            return doc(`${kicker(c.kicker)}<div class="center">
  <h1 class="title ${tier(c.title, [28, 48, 75, 110])}">${xe(c.title)}</h1>
  <div class="bar"></div>
  <p class="hook ${c.hook.length > 170 ? 'sm' : ''}">${xe(c.hook)}</p>
  ${c.author ? `<p class="source" style="margin-top:36px">✍️ <b>${xe(c.author)}</b></p>` : ''}
</div>`);
        case 'quote':
            return doc(`${kicker('اقتباس')}<div class="center">
  <div class="qmark">”</div>
  <p class="quote ${tier(c.text, [60, 110, 170, 250])}">${xe(c.text)}</p>
  <div class="bar"></div>
  <p class="source"><b>${xe(c.author)}</b>${c.book ? ` · ${xe(c.book)}` : ''}</p>
</div>`, 'quotes.elhellal.com');
        case 'bio':
            return doc(`${kicker(c.kicker)}<div class="center" style="align-items:center;text-align:center">
  ${c.photo ? `<img class="photo" src="${xe(c.photo)}" alt="">` : ''}
  <h1 class="title ${tier(c.name, [14, 24, 36, 50])}">${xe(c.name)}</h1>
  <div class="years" style="text-align:center">${xe(c.years)}</div>
  <div class="bar" style="margin-inline:auto"></div>
  <p class="hook">${xe(c.tagline)}</p>
</div>`, 'biographies.elhellal.com');
        case 'quiz': {
            const long = c.options.some((o) => o.length > 28);
            return doc(`${kicker(c.kicker)}<div class="center">
  <h1 class="title ${tier(c.question, [30, 55, 90, 140])}">${xe(c.question)}</h1>
  ${c.options.length ? `<div class="opts ${long || c.options.length > 4 ? 'small' : ''}">${c.options.map((o, i) => `<div class="opt"><b>${LETTERS[i]}</b>${xe(o)}</div>`).join('')}</div>` : ''}
  <p class="source" style="margin-top:48px">جاوب في الردود 👇</p>
</div>`, 'quiz.elhellal.com');
        }
    }
}

/** Renders the cards that don't exist yet; returns the paths of those that do afterwards. */
export async function renderCards(outDir: string, cards: { name: string; card: Card }[]): Promise<Set<string>> {
    mkdirSync(outDir, { recursive: true });
    const todo = cards.filter((c) => !existsSync(join(outDir, `${c.name}.jpg`)));
    let browser: Browser | null = null;
    try {
        if (todo.length) {
            browser = await puppeteer.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });
            const page = await browser.newPage();
            await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
            for (const [i, { name, card }] of todo.entries()) {
                try {
                    // networkidle0 hangs on a reused page; wait for load, then fonts and images ourselves.
                    await page.setContent(cardHtml(card), { waitUntil: 'load', timeout: 30_000 });
                    await page.evaluate(async () => {
                        await document.fonts.ready;
                        await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
                    });
                    await page.screenshot({ path: join(outDir, `${name}.jpg`) as `${string}.jpeg`, type: 'jpeg', quality: 88 });
                    if ((i + 1) % 10 === 0 || i === todo.length - 1) console.log(`  cards ${i + 1}/${todo.length}`);
                } catch (e) {
                    console.warn(`  card ${name} failed: ${(e as Error).message}`);
                }
            }
        }
    } finally {
        await browser?.close();
    }
    return new Set(cards.filter((c) => existsSync(join(outDir, `${c.name}.jpg`))).map((c) => c.name));
}
