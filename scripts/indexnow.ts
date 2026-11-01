/**
 * Tells IndexNow (Bing, Yandex, Seznam, Naver…) about new and changed pages.
 * Run after `wrangler deploy` (the admin's Deploy steps do): it reads the
 * sitemaps in dist/, submits every URL that's new or whose <lastmod> moved
 * since the last run, and remembers what it sent in .cache/indexnow.json.
 *
 * The key is public/<32 hex>.txt (served at the site root, which is how
 * IndexNow verifies ownership). With no state file yet, only pages from the
 * last FIRST_RUN_DAYS days are sent and the rest are just recorded, so a fresh
 * checkout never re-submits the whole site.
 *
 *   bun run indexnow            submit
 *   bun run indexnow --dry-run  list what would be sent
 */
import fs from 'node:fs';
import path from 'node:path';

const SITE = 'https://elhellal.com';
const HOST = new URL(SITE).host;
const DIST = path.join(process.cwd(), 'dist');
const PUBLIC = path.join(process.cwd(), 'public');
const STATE_FILE = path.join(process.cwd(), '.cache/indexnow.json');
const ENDPOINT = 'https://api.indexnow.org/indexnow';
/** The protocol's limit per POST. */
const BATCH = 10_000;
const FIRST_RUN_DAYS = 7;
const dryRun = process.argv.includes('--dry-run');

type State = Record<string, string>; // url → lastmod ('' when the sitemap has none)

function findKey(): string {
    const file = fs.readdirSync(PUBLIC).find((f) => /^[a-f0-9]{32}\.txt$/.test(f));
    if (!file) throw new Error('No IndexNow key file (public/<32 hex chars>.txt)');
    const key = fs.readFileSync(path.join(PUBLIC, file), 'utf-8').trim();
    if (`${key}.txt` !== file) throw new Error(`public/${file} must contain exactly its own name`);
    return key;
}

/** Every <url> in dist/sitemap-*.xml (the index itself skipped). */
function readSitemaps(): State {
    const files = fs.readdirSync(DIST).filter((f) => /^sitemap-.+\.xml$/.test(f) && f !== 'sitemap-index.xml');
    if (!files.length) throw new Error('No sitemaps in dist/ — build first');
    const urls: State = {};
    for (const f of files) {
        const xml = fs.readFileSync(path.join(DIST, f), 'utf-8');
        for (const [, body] of xml.matchAll(/<url>(.*?)<\/url>/gs)) {
            const loc = /<loc>([^<]+)<\/loc>/.exec(body!)?.[1];
            if (!loc) continue;
            urls[loc.replace(/&amp;/g, '&')] = /<lastmod>([^<]+)<\/lastmod>/.exec(body!)?.[1] ?? '';
        }
    }
    return urls;
}

function readState(): State | null {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as State;
    } catch {
        return null;
    }
}

async function submit(key: string, urlList: string[]) {
    const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host: HOST, key, keyLocation: `${SITE}/${key}.txt`, urlList }),
    });
    // 200 OK, 202 Accepted (key validation pending) are both success.
    if (res.status !== 200 && res.status !== 202) {
        throw new Error(`IndexNow answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return res.status;
}

async function main() {
    const key = findKey();
    const current = readSitemaps();
    const previous = readState();

    let toSend: string[];
    if (previous) {
        toSend = Object.keys(current).filter((u) => previous[u] !== current[u]);
    } else {
        const since = new Date(Date.now() - FIRST_RUN_DAYS * 86_400_000).toISOString().slice(0, 10);
        toSend = Object.keys(current).filter((u) => current[u]! >= since);
        console.log(`First run: sending pages from ${since} on, recording the other ${Object.keys(current).length - toSend.length}`);
    }

    if (!toSend.length) {
        console.log('IndexNow: nothing new');
    } else if (dryRun) {
        console.log(`IndexNow (dry run): would send ${toSend.length} URLs`);
        for (const u of toSend.slice(0, 20)) console.log(`  ${decodeURI(u)}`);
        if (toSend.length > 20) console.log(`  … and ${toSend.length - 20} more`);
        return;
    } else {
        // The key file must be live before IndexNow fetches it.
        const live = await fetch(`${SITE}/${key}.txt`).then((r) => (r.ok ? r.text() : ''), () => '');
        if (live.trim() !== key) throw new Error(`${SITE}/${key}.txt isn't live yet — deploy first`);
        for (let i = 0; i < toSend.length; i += BATCH) {
            const batch = toSend.slice(i, i + BATCH);
            const status = await submit(key, batch);
            console.log(`IndexNow: sent ${batch.length} URLs (HTTP ${status})`);
        }
    }

    if (dryRun) return;
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(current));
}

main().catch((err) => {
    console.error(`❌ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
});
