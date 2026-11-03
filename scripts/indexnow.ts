/**
 * Tells IndexNow (Bing, Yandex, Seznam, Naver…) about new and changed pages on
 * elhellal.com and its subdomains (quotes, books, biographies, quiz, abderahmane).
 * Run after a deploy (the admin's Deploy steps do, for this site and each
 * sibling): it reads the sitemaps, submits every URL that's new or whose
 * <lastmod> moved since the last run, and remembers what it sent in
 * .cache/indexnow.json.
 *
 * elhellal.com's sitemaps come from dist/; the subdomains' are fetched live, so
 * what gets sent is what's actually deployed. Their sitemaps have no <lastmod>,
 * so for them only brand-new URLs count.
 *
 * The key is public/<32 hex>.txt here, and the same file must be in each
 * subdomain's public/ (IndexNow verifies ownership per host). A host whose key
 * isn't live yet is skipped and its new pages stay pending for the next run.
 * The first time a host is seen, only pages from the last FIRST_RUN_DAYS days
 * are sent (none, without <lastmod>) and the rest are just recorded, so nothing
 * re-submits a whole site.
 *
 * URLs go out in priority order (articles newest first, then categories and
 * other pages, then tags, then authors) and at most PER_RUN per host; the rest
 * stay pending for the next run, so a big backlog never spends the day's quota
 * on author pages before articles. Thin tag/author pages aren't in the
 * sitemaps at all (isThinListing in src/lib/listing-page.ts).
 *
 *   bun run indexnow                   submit, every site
 *   bun run indexnow --only quiz       just quiz.elhellal.com (a host or its first label)
 *   bun run indexnow --dry-run         list what would be sent
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const PUBLIC = path.join(ROOT, 'public');
const STATE_FILE = path.join(ROOT, '.cache/indexnow.json');
const ENDPOINT = 'https://api.indexnow.org/indexnow';
/** The protocol's limit per POST. */
const BATCH = 10_000;
const FIRST_RUN_DAYS = 7;
/** Bing's daily IndexNow allowance per host is around 10k URLs. */
const PER_RUN = 10_000;
const MAIN = 'https://elhellal.com';
const SUBDOMAINS = ['quotes', 'books', 'biographies', 'quiz', 'abderahmane'].map((s) => `https://${s}.elhellal.com`);

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined;

type State = Record<string, string>; // url → lastmod ('' when the sitemap has none)

function findKey(): string {
    const file = fs.readdirSync(PUBLIC).find((f) => /^[a-f0-9]{32}\.txt$/.test(f));
    if (!file) throw new Error('No IndexNow key file (public/<32 hex chars>.txt)');
    const key = fs.readFileSync(path.join(PUBLIC, file), 'utf-8').trim();
    if (`${key}.txt` !== file) throw new Error(`public/${file} must contain exactly its own name`);
    return key;
}

function parseUrlset(xml: string, into: State) {
    for (const [, body] of xml.matchAll(/<url>(.*?)<\/url>/gs)) {
        const loc = /<loc>([^<]+)<\/loc>/.exec(body!)?.[1];
        if (!loc) continue;
        into[loc.replace(/&amp;/g, '&')] = /<lastmod>([^<]+)<\/lastmod>/.exec(body!)?.[1] ?? '';
    }
}

/** Every <url> in dist/sitemap-*.xml (the index itself skipped). */
function readLocalSitemaps(): State {
    const files = fs.readdirSync(DIST).filter((f) => /^sitemap-.+\.xml$/.test(f) && f !== 'sitemap-index.xml');
    if (!files.length) throw new Error('No sitemaps in dist/ — build first');
    const urls: State = {};
    for (const f of files) parseUrlset(fs.readFileSync(path.join(DIST, f), 'utf-8'), urls);
    return urls;
}

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.text();
}

/** Every <url> in the live sitemap-index.xml's sitemaps. */
async function readLiveSitemaps(site: string): Promise<State> {
    const index = await fetchText(`${site}/sitemap-index.xml`);
    const maps = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
    const urls: State = {};
    for (const m of maps) parseUrlset(await fetchText(m), urls);
    if (!Object.keys(urls).length) throw new Error(`${site}: empty sitemaps`);
    return urls;
}

function readState(): State {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as State;
    } catch {
        return {};
    }
}

const hostOf = (u: string) => {
    try {
        return new URL(u).host;
    } catch {
        return '';
    }
};

/** Lower goes first: articles, then everything else, then tags, then authors. */
function rank(url: string): number {
    const p = new URL(url).pathname;
    if (p.startsWith('/articles/')) return 0;
    if (p.startsWith('/tags/')) return 2;
    if (p.startsWith('/authors/')) return 3;
    return 1;
}

function byPriority(lastmods: State) {
    return (a: string, b: string) =>
        rank(a) - rank(b) || (lastmods[b] ?? '').localeCompare(lastmods[a] ?? '') || (a < b ? -1 : a > b ? 1 : 0);
}

async function submit(site: string, key: string, urlList: string[]) {
    const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host: new URL(site).host, key, keyLocation: `${site}/${key}.txt`, urlList }),
    });
    // 200 OK, 202 Accepted (key validation pending) are both success.
    if (res.status !== 200 && res.status !== 202) {
        throw new Error(`IndexNow answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return res.status;
}

/** Submits one site's new pages; returns its state to record (null = keep the old one). */
async function runSite(site: string, key: string, state: State): Promise<State | null> {
    const host = new URL(site).host;
    const current = site === MAIN ? readLocalSitemaps() : await readLiveSitemaps(site);
    const previous = Object.fromEntries(Object.entries(state).filter(([u]) => hostOf(u) === host));

    let toSend: string[];
    if (Object.keys(previous).length) {
        toSend = Object.keys(current).filter((u) => previous[u] !== current[u]);
    } else {
        const since = new Date(Date.now() - FIRST_RUN_DAYS * 86_400_000).toISOString().slice(0, 10);
        toSend = Object.keys(current).filter((u) => current[u] && current[u]! >= since);
        console.log(`${host}: first run, sending pages from ${since} on, recording the other ${Object.keys(current).length - toSend.length}`);
    }

    if (!toSend.length) {
        console.log(`${host}: nothing new`);
        return current;
    }
    toSend.sort(byPriority(current));
    // Past the per-run cap: keep their old state so they count as new next run.
    const deferred = toSend.slice(PER_RUN);
    toSend = toSend.slice(0, PER_RUN);
    const next: State = { ...current };
    for (const u of deferred) {
        if (u in previous) next[u] = previous[u]!;
        else delete next[u];
    }
    if (deferred.length) console.log(`${host}: ${deferred.length} lower-priority URLs deferred to the next run`);
    if (dryRun) {
        console.log(`${host} (dry run): would send ${toSend.length} URLs`);
        for (const u of toSend.slice(0, 20)) console.log(`  ${decodeURI(u)}`);
        if (toSend.length > 20) console.log(`  … and ${toSend.length - 20} more`);
        return null;
    }
    // The key file must be live on that host before IndexNow fetches it.
    const live = await fetch(`${site}/${key}.txt`).then((r) => (r.ok ? r.text() : ''), () => '');
    if (live.trim() !== key) {
        console.warn(`⚠️  ${host}: ${site}/${key}.txt isn't live — copy public/${key}.txt into that site and deploy; ${toSend.length} URLs kept for next run`);
        return null;
    }
    for (let i = 0; i < toSend.length; i += BATCH) {
        const batch = toSend.slice(i, i + BATCH);
        const status = await submit(site, key, batch);
        console.log(`${host}: sent ${batch.length} URLs (HTTP ${status})`);
    }
    return next;
}

async function main() {
    const key = findKey();
    const sites = [MAIN, ...SUBDOMAINS].filter((s) => !only || new URL(s).host === only || new URL(s).host.startsWith(`${only}.`));
    if (!sites.length) throw new Error(`No site matches --only ${only}`);
    const state = readState();
    let failed = false;

    for (const site of sites) {
        const host = new URL(site).host;
        try {
            const next = await runSite(site, key, state);
            if (!next) continue;
            for (const u of Object.keys(state)) if (hostOf(u) === host) delete state[u];
            Object.assign(state, next);
        } catch (err) {
            failed = true;
            console.error(`❌ ${host}: ${err instanceof Error ? err.message : err}`);
        }
    }

    if (!dryRun) {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    }
    if (failed) process.exit(1);
}

main().catch((err) => {
    console.error(`❌ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
});
