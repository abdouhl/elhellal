// iOS launch screens: renders splash.html (which shows icon-512.png from the
// same directory) at each device size. Usage:
//   python3 scripts/pwa-assets/icons.py <dir>      # icons, incl. <dir>/icon-512.png
//   cp scripts/pwa-assets/splash.html <dir> && mkdir <dir>/splash
//   bun scripts/pwa-assets/splash.mjs <dir>        # <dir>/splash/*.png
// then convert to JPEG (quality 82) into public/splash/ and copy the icons
// into public/; Layout.astro lists one apple-touch-startup-image per size.
import puppeteer from 'puppeteer';
const [dir] = process.argv.slice(2);
// [css width, css height, dpr] — portrait iPhones and iPads
const devices = [
  [440, 956, 3], [402, 874, 3], [430, 932, 3], [393, 852, 3], [428, 926, 3], [390, 844, 3],
  [375, 812, 3], [414, 896, 3], [414, 896, 2], [414, 736, 3], [375, 667, 2], [320, 568, 2],
  [768, 1024, 2], [820, 1180, 2], [834, 1194, 2], [1024, 1366, 2],
];
const browser = await puppeteer.launch();
const page = await browser.newPage();
for (const [w, h, d] of devices) {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: d });
  await page.goto(`file://${dir}/splash.html`, { waitUntil: 'load' });
  await page.screenshot({ path: `${dir}/splash/splash-${w * d}x${h * d}.png` });
}
await browser.close();
console.log(JSON.stringify(devices));
