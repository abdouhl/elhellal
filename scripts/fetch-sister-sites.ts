/**
 * Snapshots the sibling sites' public feeds (quotes/books/biographies/quiz
 * .elhellal.com/app-feed.json — the same ones the Explore tab reads) into
 * src/data/sister-sites.json, which the build uses to cross-link article and
 * tag pages to them (src/lib/sister-sites.ts).
 *
 * Runs at the start of `bun run build`. A site that can't be fetched keeps
 * its previous snapshot, so an offline build still links to something.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SISTER_SITES, type SisterSiteKey, type SisterSnapshot } from '../src/lib/sister-sites.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'src', 'data', 'sister-sites.json');

function readPrevious(): Partial<SisterSnapshot> {
    try {
        return JSON.parse(fs.readFileSync(OUT, 'utf-8'));
    } catch {
        return {};
    }
}

async function fetchFeed(site: SisterSiteKey): Promise<SisterSnapshot[SisterSiteKey] | null> {
    try {
        const res = await fetch(`https://${site}.elhellal.com/app-feed.json`, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const feed = (await res.json()) as { items?: unknown };
        if (!Array.isArray(feed.items) || feed.items.length === 0) throw new Error('no items');
        return feed.items as SisterSnapshot[SisterSiteKey];
    } catch (err) {
        console.warn(`⚠️  ${site}.elhellal.com: ${(err as Error).message} — keeping the previous snapshot`);
        return null;
    }
}

const previous = readPrevious();
const next = {} as SisterSnapshot;
for (const site of SISTER_SITES) {
    next[site] = ((await fetchFeed(site)) ?? previous[site] ?? []) as never;
}
fs.writeFileSync(OUT, JSON.stringify(next, null, 1) + '\n');
console.log(`✅ Sister sites: ${SISTER_SITES.map((s) => `${next[s].length} ${s}`).join(', ')}`);
