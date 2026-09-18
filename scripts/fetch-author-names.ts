#!/usr/bin/env bun
/**
 * Backfills src/data/author-names.json for every Substack author already in
 * articles.json. New authors get their name scraped automatically going
 * forward by import-substack2.ts — this script is for one-off backfills or
 * retrying authors that failed earlier (dead feed, timeout, etc).
 *
 * Usage:
 *   bun run fetch-author-names            # fill in any missing authors
 *   bun run fetch-author-names --refresh  # re-fetch everyone, ignoring cache
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ArticlesConfig } from '../src/types/index.ts';
import { personalBlogs } from '../src/data/personal-blogs.ts';
import { fetchAuthorName, loadAuthorNames, saveAuthorNames } from './lib/author-names.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARTICLES_PATH = path.join(__dirname, '../src/data/articles.json');
const CONCURRENCY_LIMIT = 15;

const LOCAL_BLOG_SCREEN_NAME = 'abdou_hll';
const NON_SUBSTACK_SCREEN_NAMES = new Set([
    LOCAL_BLOG_SCREEN_NAME,
    ...Object.values(personalBlogs).map((p) => p.slug),
]);

const refresh = process.argv.includes('--refresh');

function getAllSubstackScreenNames(): string[] {
    const data: ArticlesConfig = JSON.parse(fs.readFileSync(ARTICLES_PATH, 'utf-8'));
    const names = new Set<string>();
    data.articles.forEach((cat) => {
        cat.content.forEach((a) => {
            if (a.screen_name && !NON_SUBSTACK_SCREEN_NAMES.has(a.screen_name)) {
                names.add(a.screen_name);
            }
        });
    });
    return [...names];
}

async function main() {
    const allScreenNames = getAllSubstackScreenNames();
    const cache = refresh ? {} : loadAuthorNames();

    const pending = allScreenNames.filter((name) => !(name in cache));
    console.log(
        `👥 ${allScreenNames.length} Substack author(s) total, ` +
        `${allScreenNames.length - pending.length} already cached, ` +
        `${pending.length} to fetch (concurrency: ${CONCURRENCY_LIMIT})\n`
    );

    let fetched = 0;
    let failed = 0;

    for (let i = 0; i < pending.length; i += CONCURRENCY_LIMIT) {
        const chunk = pending.slice(i, i + CONCURRENCY_LIMIT);
        await Promise.all(
            chunk.map(async (screenName) => {
                const name = await fetchAuthorName(screenName);
                if (name) {
                    cache[screenName] = name;
                    fetched++;
                } else {
                    failed++;
                }
            })
        );

        saveAuthorNames(cache);
        process.stdout.write(
            `\rProgress: ${Math.min(i + CONCURRENCY_LIMIT, pending.length)}/${pending.length} | Fetched: ${fetched} | Failed: ${failed}`
        );
    }

    console.log(`\n\n✨ Done. ${Object.keys(cache).length} author names cached total.`);
    console.log(`💾 Saved to src/data/author-names.json`);
    if (failed > 0) {
        console.log(`⚠️  ${failed} author(s) had no reachable feed / title — they'll fall back to @handle. Re-run this script later to retry them.`);
    }
}

main().catch((err) => {
    console.error('\n❌', err.message);
    process.exit(1);
});
