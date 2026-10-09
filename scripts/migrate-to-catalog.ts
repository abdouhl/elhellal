/**
 * One-off: merges what is left in the old monolithic src/data/articles.json
 * into the split catalog (src/data/catalog/, see src/lib/articles-store.ts).
 *
 * Merge-only: an article already in the catalog (by id_str, in any category)
 * is never touched, so edits and moves made in the admin panel survive, and
 * blocklisted articles/authors are skipped. Deletes articles.json afterwards.
 *
 * Run it only while no importer is running — importers hold the whole catalog
 * in memory and their next save would drop the merged articles.
 *
 *   bun run scripts/migrate-to-catalog.ts
 */

import fs from 'fs';
import path from 'path';
import type { ArticlesConfig } from '../src/types/index.ts';
import { readArticles, writeArticles } from '../src/lib/articles-store.ts';
import { blockedAuthors, blockedIds } from './lib/moderation.ts';

const SOURCE = path.join(process.cwd(), 'src/data/articles.json');

if (!fs.existsSync(SOURCE)) {
    console.log('Nothing to do: src/data/articles.json is gone.');
    process.exit(0);
}

const source: ArticlesConfig = JSON.parse(fs.readFileSync(SOURCE, 'utf-8'));
const catalog = readArticles();

// Don't bring back what the admin panel or the moderation script removed.
const ids = blockedIds();
const authors = blockedAuthors();
const seen = new Set(catalog.articles.flatMap((c) => c.content.map((a) => a.id_str)));

let added = 0;
for (const cat of source.articles) {
    const fresh = cat.content.filter((a) => !seen.has(a.id_str) && !ids.has(a.id_str) && !authors.has(a.screen_name));
    if (!fresh.length) continue;
    let target = catalog.articles.find((c) => c.category === cat.category);
    if (!target) {
        target = { ...cat, content: [] };
        catalog.articles.push(target);
    }
    target.content.push(...fresh);
    for (const a of fresh) seen.add(a.id_str);
    added += fresh.length;
}

if (added) writeArticles(catalog);
fs.unlinkSync(SOURCE);
console.log(`✅ merged ${added} articles from articles.json into src/data/catalog/ and deleted articles.json`);
