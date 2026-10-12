// The manifest's screenshots (Chrome's richer install sheet) and /app/'s
// gallery: the live site as the installed app looks, on a phone and a desktop.
// Usage (then convert to JPEG, quality 82: sips -s format jpeg -s formatOptions 82):
//   bun scripts/pwa-assets/screenshots.mjs [origin]    # → public/screenshots/*.png
// API calls and ads are blocked, so nothing is counted, and banners are removed.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const origin = process.argv[2] ?? 'https://elhellal.com';
const out = new URL('../../public/screenshots/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const pages = [
    ['home', '/'],
    ['article', '/articles/السلاح-النووي-بين-ازدواجية-المعايير-وخطر-الانتشار/'],
    ['category', '/psychology/'],
];
// [name suffix, css width, css height, dpr]
const sizes = [
    ['', 412, 915, 2],
    ['-wide', 1280, 800, 1],
];
const BLOCKED = /\/api\/|googlesyndication|doubleclick|googletagmanager|google-analytics|fundingchoices|adtrafficquality/;

const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.setRequestInterception(true);
page.on('request', (req) => (BLOCKED.test(req.url()) ? req.abort() : req.continue()));
// Look like the installed app: the app shell keys off display-mode: standalone.
await page.evaluateOnNewDocument(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) => (q.includes('display-mode: standalone') ? { ...real(q), matches: true, media: q } : real(q));
    try {
        localStorage.setItem('elhellal_install', JSON.stringify({ reads: 0, installed: true, notifyDismissedAt: Date.now() }));
    } catch {}
});

for (const [suffix, width, height, dpr] of sizes) {
    await page.setViewport({ width, height, deviceScaleFactor: dpr, isMobile: !suffix, hasTouch: !suffix });
    for (const [name, path] of pages) {
        await page.goto(origin + encodeURI(path), { waitUntil: 'networkidle2', timeout: 60_000 });
        await new Promise((r) => setTimeout(r, 1500));
        // Listings: the shuffled "اكتشف" tab, minus cards without a cover.
        await page.evaluate(() => {
            [...document.querySelectorAll('button, [role="tab"]')].find((b) => b.textContent?.trim() === 'اكتشف')?.click();
        });
        await new Promise((r) => setTimeout(r, 2500));
        await page.evaluate(() => {
            document.querySelectorAll('#pwa-banner, #pwa-sheet, .adsense-slot, .ad-unit, .ad-card, ins.adsbygoogle').forEach((el) => el.remove());
            for (const img of document.querySelectorAll('.link-card img')) {
                if (img.src.includes('placeholder') || !img.complete || img.naturalWidth === 0) img.closest('.link-card')?.remove();
            }
            window.scrollTo(0, 0);
        });
        await new Promise((r) => setTimeout(r, 500));
        await page.screenshot({ path: `${out}${name}${suffix}.png` });
        console.log(`${name}${suffix}.png ${width * dpr}x${height * dpr}`);
    }
}
await browser.close();
