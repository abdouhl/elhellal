import fs from 'node:fs';
import path from 'node:path';
import type { Article, ArticlesConfig } from '../types';

/**
 * The article catalog — the source of truth for every articles.json-style
 * article — split into many small files so no single file outgrows GitHub's
 * 100MB limit (one articles.json would pass it around 35k articles):
 *
 *   src/data/catalog/categories.json             [{ category, title }] in display order
 *   src/data/catalog/<category>/<YYYY-MM>.json    that category's articles by created_at
 *                                                 month, sorted by title
 *   src/data/catalog/<category>/undated.json      ones without a YYYY-MM created_at
 *
 * Month buckets keep diffs local: new articles land in recent files and old
 * files never change. Code works with the whole catalog through
 * readArticles() / writeArticles(), in the old articles.json shape — never
 * read or write the files directly.
 *
 * Node-only. Paths resolve from the working directory (the repo root for
 * `bun run …` scripts and the Astro build).
 */

export const CATALOG_DIR = path.join(process.cwd(), 'src/data/catalog');
const CATEGORIES_FILE = 'categories.json';
const UNDATED = 'undated';

interface CategoryEntry {
    category: string;
    title: string;
}

/** Same order as String.prototype.localeCompare with no locale (add-slugs, check-data). */
const byTitle = new Intl.Collator().compare;
const compareTitles = (a: Article, b: Article) => byTitle(a.title, b.title);

/** The bucket (file name without .json) an article belongs in. */
export function bucketOf(article: Pick<Article, 'created_at'>): string {
    const month = /^(\d{4}-\d{2})/.exec(article.created_at || '');
    return month ? month[1]! : UNDATED;
}

function readJson<T>(file: string): T {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

function formatJson(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

/** Bucket files of a category, oldest month first (undated last). */
export function bucketFiles(category: string): string[] {
    const dir = path.join(CATALOG_DIR, category);
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => path.join(dir, f));
}

/** The whole catalog, each category's articles sorted by title. */
export function readArticles(): ArticlesConfig {
    const categories = readJson<CategoryEntry[]>(path.join(CATALOG_DIR, CATEGORIES_FILE));
    return {
        articles: categories.map(({ category, title }) => ({
            category,
            title,
            // Stable sort: equal titles keep month order.
            content: bucketFiles(category)
                .flatMap((file) => readJson<Article[]>(file))
                .sort(compareTitles),
        })),
    };
}

/**
 * Replaces the catalog with `data`. Only files whose content changed are
 * rewritten; buckets and categories that no longer exist are removed.
 */
export function writeArticles(data: ArticlesConfig): { written: number; removed: number } {
    let written = 0;
    let removed = 0;
    const writeIfChanged = (file: string, content: string) => {
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8') === content) return;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
        written++;
    };

    const keepDirs = new Set<string>();
    for (const cat of data.articles) {
        if (!cat.category || cat.category.includes('/') || cat.category.startsWith('.')) {
            throw new Error(`Invalid category key: ${JSON.stringify(cat.category)}`);
        }
        keepDirs.add(cat.category);

        const buckets = new Map<string, Article[]>();
        for (const article of cat.content) {
            const bucket = bucketOf(article);
            if (!buckets.has(bucket)) buckets.set(bucket, []);
            buckets.get(bucket)!.push(article);
        }

        const dir = path.join(CATALOG_DIR, cat.category);
        const keepFiles = new Set<string>();
        for (const [bucket, articles] of buckets) {
            const file = path.join(dir, `${bucket}.json`);
            keepFiles.add(file);
            writeIfChanged(file, formatJson([...articles].sort(compareTitles)));
        }
        for (const file of bucketFiles(cat.category)) {
            if (!keepFiles.has(file)) {
                fs.rmSync(file);
                removed++;
            }
        }
    }

    for (const entry of fs.existsSync(CATALOG_DIR) ? fs.readdirSync(CATALOG_DIR, { withFileTypes: true }) : []) {
        if (entry.isDirectory() && !keepDirs.has(entry.name)) {
            removed += bucketFiles(entry.name).length;
            fs.rmSync(path.join(CATALOG_DIR, entry.name), { recursive: true });
        }
    }

    writeIfChanged(
        path.join(CATALOG_DIR, CATEGORIES_FILE),
        formatJson(data.articles.map(({ category, title }): CategoryEntry => ({ category, title })))
    );
    return { written, removed };
}
