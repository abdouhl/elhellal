/**
 * Fills in `minutes` (reading time, src/lib/reading-time.ts) for catalog
 * articles imported before the importers recorded it.
 *
 * Substack's archive API lists each post with its word count (paywalled ones
 * too), 50 posts a request, so this pages through each author's archive
 * rather than fetching posts one by one, and stops as soon as all of that
 * author's articles are matched. Articles are matched on the /p/<slug> of
 * their url. Saves every SAVE_EVERY authors, so it can be stopped and re-run:
 * articles that already have `minutes` are skipped.
 *
 *   bun run backfill-reading-time            all authors
 *   bun run backfill-reading-time -- 50      only the first 50 authors
 */

import { readArticles, writeArticles } from '../src/lib/articles-store.ts';
import { minutesForWords } from '../src/lib/reading-time.ts';
import type { Article } from '../src/types/index.ts';

const FETCH_HEADERS = {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; elhellal/1.0)',
};
const PAGE_SIZE = 50;
const MAX_PAGES = 60;
const DELAY_MS = 400;
const SAVE_EVERY = 20;

interface ArchiveEntry {
    slug: string;
    wordcount?: number;
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The post slug of a Substack URL (custom domains too): /p/<slug> */
function postSlug(url: string | undefined): string | null {
    if (!url) return null;
    try {
        return new URL(url).pathname.match(/^\/p\/([^/]+)/)?.[1] ?? null;
    } catch {
        return null;
    }
}

/** Word counts for the given post slugs of one author; stops once all are found. */
async function wordCounts(user: string, wanted: Set<string>): Promise<Map<string, number>> {
    const found = new Map<string, number>();
    for (let page = 0; page < MAX_PAGES && found.size < wanted.size; page++) {
        const res = await fetch(
            `https://${user}.substack.com/api/v1/archive?sort=new&offset=${page * PAGE_SIZE}&limit=${PAGE_SIZE}`,
            { headers: FETCH_HEADERS, signal: AbortSignal.timeout(15000) }
        );
        if (res.status === 429) {
            console.log('   ⏳ rate limited, waiting 30s');
            await sleep(30_000);
            page--;
            continue;
        }
        if (!res.ok) throw new Error(`archive ${res.status}`);
        const entries = (await res.json()) as ArchiveEntry[];
        if (entries.length === 0) break;
        for (const e of entries) {
            if (wanted.has(e.slug) && e.wordcount) found.set(e.slug, e.wordcount);
        }
        await sleep(DELAY_MS);
    }
    return found;
}

async function main() {
    const limit = Number(process.argv[2]) || Infinity;
    const data = readArticles();

    const byAuthor = new Map<string, Article[]>();
    for (const cat of data.articles) {
        for (const a of cat.content) {
            if (a.minutes || !a.screen_name || !postSlug(a.url)) continue;
            const list = byAuthor.get(a.screen_name) ?? [];
            list.push(a);
            byAuthor.set(a.screen_name, list);
        }
    }
    const authors = [...byAuthor.keys()].slice(0, limit);
    console.log(`${[...byAuthor.values()].flat().length} articles without a reading time, ${byAuthor.size} authors (${authors.length} this run)`);

    let filled = 0;
    let missed = 0;
    for (const [i, user] of authors.entries()) {
        const articles = byAuthor.get(user)!;
        const wanted = new Set(articles.map((a) => postSlug(a.url)!));
        try {
            const counts = await wordCounts(user, wanted);
            for (const a of articles) {
                const minutes = minutesForWords(counts.get(postSlug(a.url)!) ?? 0);
                if (minutes) {
                    a.minutes = minutes;
                    filled++;
                } else missed++;
            }
            console.log(`${i + 1}/${authors.length} @${user}: ${counts.size}/${wanted.size}`);
        } catch (e) {
            missed += articles.length;
            console.log(`${i + 1}/${authors.length} @${user}: ⚠️ ${(e as Error).message}`);
        }
        if ((i + 1) % SAVE_EVERY === 0) writeArticles(data);
    }
    writeArticles(data);
    console.log(`\n✅ ${filled} filled, ${missed} not found`);
}

main();
