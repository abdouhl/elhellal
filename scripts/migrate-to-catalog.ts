/**
 * One-off: moves the monolithic src/data/articles.json into the split
 * catalog (src/data/catalog/, see src/lib/articles-store.ts). Safe to re-run
 * while articles.json is still being written to; delete articles.json once
 * nothing writes it any more.
 *
 *   bun run scripts/migrate-to-catalog.ts
 */

import fs from 'fs';
import path from 'path';
import type { ArticlesConfig } from '../src/types/index.ts';
import { readArticles, writeArticles } from '../src/lib/articles-store.ts';

const SOURCE = path.join(process.cwd(), 'src/data/articles.json');

const source: ArticlesConfig = JSON.parse(fs.readFileSync(SOURCE, 'utf-8'));
const { written, removed } = writeArticles(source);

// Same categories and articles, in title order (equal titles may swap).
const count = (data: ArticlesConfig) => data.articles.reduce((n, c) => n + c.content.length, 0);
const catalog = readArticles();
const fingerprint = (data: ArticlesConfig) =>
    data.articles.map((c) => `${c.category}:${c.title}:${c.content.map((a) => JSON.stringify(a)).sort().join('\n')}`).join('\n\n');
if (fingerprint(source) !== fingerprint(catalog)) {
    throw new Error('Catalog does not match articles.json after writing it');
}
console.log(`✅ ${count(catalog)} articles in ${catalog.articles.length} categories → src/data/catalog/ (${written} files written, ${removed} removed)`);
