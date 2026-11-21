#!/usr/bin/env bun
/**
 * X runner — schedules the latest x-schedule batch in one click, then checks X's scheduled list.
 * ----------------------------------------------------------------------------------------------
 *   bun run x-run              opens a Chrome window (its own profile in .x-schedule/chrome-profile —
 *                              log into X there once, it stays logged in), runs .x-schedule/snippet.js
 *                              on x.com, hands it the images straight from x-posts/ (no folder to pick),
 *                              saves its report to .x-schedule/reports/, then runs --verify
 *   bun run x-run --verify     reads x.com/compose/post/unsent/scheduled and compares it with
 *                              .x-schedule/log.json: lists posts we think are queued but X doesn't
 *                              have (and posts X has that we didn't queue)
 *   bun run x-run --verify --fix
 *                              also puts those missing posts back in the pool for the next x-schedule
 *
 * Keep the window open until it says done; it may sit in the background.
 */
import puppeteer, { type Page } from 'puppeteer';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const DIR = join(ROOT, '.x-schedule');
const PROFILE = join(DIR, 'chrome-profile');
const SNIPPET = join(DIR, 'snippet.js');
const REPORTS = join(DIR, 'reports');
const LOG_FILE = join(DIR, 'log.json');
const STATE_FILE = join(DIR, 'posted.json');
const X_POSTS = join(ROOT, 'x-posts');

const argv = process.argv.slice(2);
const verifyOnly = argv.includes('--verify');
const fix = argv.includes('--fix');

mkdirSync(REPORTS, { recursive: true });
if (!verifyOnly && !existsSync(SNIPPET)) throw new Error('No .x-schedule/snippet.js — run `bun run x-schedule --day` (or --month) first');

const launch = (channel?: 'chrome') =>
    puppeteer.launch({
        headless: false,
        ...(channel ? { channel } : {}),
        userDataDir: PROFILE,
        defaultViewport: null,
        protocolTimeout: 0, // a month of posts takes a while; never time the snippet out
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
            '--disable-blink-features=AutomationControlled',
            // keep working when the window is behind others
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows',
            '--window-size=1200,900',
        ],
    });
const browser = await launch('chrome').catch(() => launch());
const page = (await browser.pages())[0] ?? (await browser.newPage());

try {
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
    await waitForLogin(page);
    if (!verifyOnly) await runSnippet(page);
    await verify(page);
} finally {
    await browser.close();
}

async function waitForLogin(page: Page) {
    const ok = () => page.$('a[href="/compose/post"]');
    if (await page.waitForSelector('a[href="/compose/post"]', { timeout: 15_000 }).catch(() => null)) return;
    console.log('Log into X in the Chrome window that just opened (first time only) — waiting up to 10 minutes…');
    const end = Date.now() + 10 * 60_000;
    while (Date.now() < end) {
        if (await ok()) return console.log('Logged in ✓');
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('Not logged into X — run again after logging in');
}

async function runSnippet(page: Page) {
    const snippet = readFileSync(SNIPPET, 'utf8');
    const batch = /elhellal-x:([^"]+)"/.exec(snippet)?.[1];
    page.on('console', (m) => {
        const t = m.text();
        if (/^[✓✗…]|done —|elhellal → X|skip/.test(t.replace(/^%c/, ''))) console.log(t.replace(/%c/g, ''));
    });
    // Images go straight from disk to the page, only from inside x-posts/.
    await page.exposeFunction('__elhellalFile', (rel: string) => {
        const file = resolve(X_POSTS, rel);
        if (!file.startsWith(X_POSTS + sep) || !existsSync(file)) throw new Error(`image ${rel} not found in x-posts/`);
        const type = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[extname(file).toLowerCase()] ?? 'application/octet-stream';
        return { b64: readFileSync(file).toString('base64'), type };
    });
    await page.exposeFunction('__elhellalReport', (json: string) => {
        const data = JSON.parse(json) as { batch: string; done: string[] };
        if (data.batch !== batch) throw new Error('report for another batch');
        writeFileSync(join(REPORTS, `elhellal-x-${batch}-${Date.now()}.json`), json);
        console.log(`Report saved: ${data.done.length} scheduled (next x-schedule run reads it).`);
    });
    console.log(`Scheduling batch ${batch}…`);
    // X sometimes reloads the page under the snippet; it keeps its progress in localStorage, so start it again.
    for (let attempt = 1; ; attempt++) {
        await new Promise((r) => setTimeout(r, 3000)); // let x.com finish its own redirects first
        try {
            const result = await page.evaluate(snippet);
            if (result !== 'done') console.log('The snippet stopped early — run `bun run x-run` again to resume where it left off.');
            return;
        } catch (e) {
            if (attempt >= 5 || !/context was destroyed|detached|Target closed/i.test(String(e))) throw e;
            console.log(`(x.com reloaded the page — resuming, try ${attempt + 1}/5)`);
            await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {});
            await waitForLogin(page);
        }
    }
}

async function verify(page: Page) {
    console.log('\nChecking x.com/compose/post/unsent/scheduled…');
    await page.goto('https://x.com/compose/post/unsent/scheduled', { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => console.warn('(scheduled list slow to load — reading what is there)'));
    // 2026 UI: no test ids; each entry has a "Will send on …" line.
    const sendLines = () =>
        page.evaluate(() =>
            [...document.querySelectorAll('span')].filter((e) => !e.children.length && /^Will send on /.test(e.textContent ?? '')).map((e) => e.textContent ?? ''),
        );
    await page.waitForFunction(() => [...document.querySelectorAll('span')].some((e) => /^Will send on /.test(e.textContent ?? '')), { timeout: 30_000 }).catch(() => null);
    // Scroll the list's container until no more entries load, then read every "Will send on …" line
    // (a list, not a set: two posts can share a minute).
    let seen: string[] = [];
    for (let idle = 0, last = -1; idle < 4; ) {
        seen = await sendLines();
        idle = seen.length === last ? idle + 1 : 0;
        last = seen.length;
        await page.evaluate(() => {
            const el = [...document.querySelectorAll('span')].find((e) => /^Will send on /.test(e.textContent ?? ''));
            let p = el?.parentElement;
            while (p && p.scrollHeight <= p.clientHeight + 4) p = p.parentElement;
            (p ?? document.scrollingElement)!.scrollBy(0, 1500);
        });
        await new Promise((r) => setTimeout(r, 900));
    }
    // "Will send on Tue, Nov 10, 2026 at 9:00 AM" → "2026-11-10T09:00" (this Mac's clock, like log.json)
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const onX = new Map<string, number>();
    let unparsed = 0;
    for (const l of seen) {
        const m = /(\w{3})\w* (\d{1,2}), (\d{4}) at (\d{1,2}):(\d{2})\s*([AP]M)/.exec(l.replace(/[  ]/g, ' '));
        if (!m) {
            unparsed++;
            continue;
        }
        const h = (Number(m[4]) % 12) + (m[6] === 'PM' ? 12 : 0);
        const at = `${m[3]}-${String(MONTHS.indexOf(m[1]!) + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}T${String(h).padStart(2, '0')}:${m[5]}`;
        onX.set(at, (onX.get(at) ?? 0) + 1);
    }
    if (unparsed) console.warn(`(${unparsed} entries not understood — is X set to English? Settings → Accessibility, display and languages)`);
    if (!onX.size) {
        console.warn('No scheduled posts found on X (or the page did not load) — nothing compared.');
        return;
    }

    const log: Record<string, { at: string; kind: string; text: string }> = existsSync(LOG_FILE) ? JSON.parse(readFileSync(LOG_FILE, 'utf8')) : {};
    const soon = Date.now() + 10 * 60_000;
    const expected = Object.entries(log).filter(([, e]) => new Date(e.at).getTime() > soon);
    const left = new Map(onX);
    const missing: [string, { at: string; kind: string; text: string }][] = [];
    for (const [id, e] of expected) {
        const n = left.get(e.at) ?? 0;
        if (n > 0) left.set(e.at, n - 1);
        else missing.push([id, e]);
    }
    const extra = [...left].filter(([, n]) => n > 0);
    console.log(`X has ${[...onX.values()].reduce((a, b) => a + b, 0)} scheduled posts; log.json expects ${expected.length} from now on.`);
    if (!missing.length) console.log('✓ Every queued post is on X.');
    else {
        console.log(`✗ ${missing.length} queued posts are not on X:`);
        for (const [, e] of missing.slice(0, 30)) console.log(`   ${e.at.replace('T', ' ')}  ${e.kind.padEnd(7)} ${e.text.split('\n')[0]!.slice(0, 60)}`);
    }
    if (extra.length) console.log(`(${extra.reduce((a, [, n]) => a + n, 0)} posts on X weren't queued by x-schedule — scheduled by hand or an older run.)`);
    if (missing.length && fix) {
        const posted: Record<string, string> = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
        for (const [id] of missing) {
            delete posted[id];
            delete log[id];
        }
        writeFileSync(STATE_FILE, JSON.stringify(posted, null, 2));
        writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
        console.log(`--fix: ${missing.length} posts back in the pool; the next x-schedule run can pick them again.`);
    } else if (missing.length) console.log('Run `bun run x-run --verify --fix` to put them back in the pool.');
}
