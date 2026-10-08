/**
 * Post-build step (runs after `astro build`): prepares everything the site
 * Worker (workers/site/) needs to serve /articles/<slug>/ pages on demand.
 *
 *  1. Writes every articles.json article as a precomputed ArticleRecord into
 *     dist/_data/articles/<shard>.json (see src/lib/article-page.ts).
 *  2. Moves the article shell (dist/articles/__shell__/index.html) out of
 *     dist/ into .worker-build/, where the Worker bundles it as a string — so
 *     the token-filled template is never served as a page of its own.
 *  3. Writes .worker-build/meta.json with a build id the Worker uses to key
 *     its edge cache, so a deploy never serves pages cached from the last one.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ArticlesConfig, Article } from '../src/types/index.ts';
import {
    ARTICLE_SHELL_SLUG,
    SHARD_COUNT,
    shardOf,
    type ArticleRecord,
    type ArticleShard,
} from '../src/lib/article-page.ts';
import { normalizeTag, slugifyTag, MIN_TAG_ARTICLES } from '../src/utils/tag-slug.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SHARD_DIR = path.join(DIST, '_data', 'articles');
const SHELL_SRC = path.join(DIST, 'articles', ARTICLE_SHELL_SLUG, 'index.html');
const WORKER_BUILD = path.join(ROOT, '.worker-build');

const RELATED_COUNT = 3;

function fnv1a(text: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/** Up to RELATED_COUNT other articles of the category, picked deterministically per slug. */
function pickRelated(articles: Article[], self: Article): Article[] {
    const others = articles.length - 1;
    if (others <= 0) return [];
    const picked = new Set<number>();
    const result: Article[] = [];
    let state = fnv1a(self.slug!) || 1;
    for (let attempts = 0; result.length < Math.min(RELATED_COUNT, others) && attempts < 50; attempts++) {
        state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) >>> 0; // xorshift-multiply step
        const index = state % articles.length;
        const candidate = articles[index]!;
        if (picked.has(index) || candidate === self || !candidate.slug || candidate.slug === self.slug) continue;
        picked.add(index);
        result.push(candidate);
    }
    return result;
}

const MONTHS_AR = [
    'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

/**
 * "8 يونيو 2024" — what Node's toLocaleDateString('ar', { day, month: 'long',
 * year }) produced for the old static pages. Spelled out because ICU output
 * differs between runtimes (bun adds a comma).
 */
function formatDateAr(dateStr: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
    const month = m ? MONTHS_AR[Number(m[2]) - 1] : undefined;
    return m && month ? `${Number(m[3])} ${month} ${m[1]}` : dateStr;
}

function main() {
    if (!fs.existsSync(SHELL_SRC)) {
        throw new Error(`Article shell not found at ${SHELL_SRC} — run \`astro build\` first.`);
    }

    const data: ArticlesConfig = JSON.parse(
        fs.readFileSync(path.join(ROOT, 'src/data/articles.json'), 'utf-8')
    );

    // Same counting as buildTagIndex() in src/utils/tags.ts: a tag gets a page
    // once it has MIN_TAG_ARTICLES keyword occurrences.
    const tagCounts = new Map<string, number>();
    for (const cat of data.articles) {
        for (const article of cat.content) {
            for (const kw of article.keywords || []) {
                if (!normalizeTag(kw)) continue;
                const slug = slugifyTag(kw);
                if (slug) tagCounts.set(slug, (tagCounts.get(slug) || 0) + 1);
            }
        }
    }

    const shards: ArticleShard[] = Array.from({ length: SHARD_COUNT }, () => ({}));
    let count = 0;
    let duplicates = 0;
    const seen = new Set<string>();

    for (const cat of data.articles) {
        for (const a of cat.content) {
            if (!a.slug) continue;
            // First occurrence wins, as with slug-map.json before.
            if (seen.has(a.slug)) {
                duplicates++;
                continue;
            }
            seen.add(a.slug);

            const record: ArticleRecord = {
                slug: a.slug,
                title: a.title,
                preview_text: a.preview_text,
                original_img_url: a.original_img_url,
                profile_image_url_https: a.profile_image_url_https,
                id_str: a.id_str,
                screen_name: a.screen_name,
                created_at: a.created_at,
                url: a.url,
                tag: (a as Article & { tag?: string }).tag,
                tldr: a.tldr,
                whyThisMatters: a.whyThisMatters,
                whoShouldRead: a.whoShouldRead,
                metaDescription: a.metaDescription,
                category: cat.category,
                categoryTitle: cat.title || cat.category.charAt(0).toUpperCase() + cat.category.slice(1),
                dateAr: formatDateAr(a.created_at),
                keywords: a.keywords?.map((kw): [string, string | null] => {
                    const slug = slugifyTag(kw);
                    return [kw, (tagCounts.get(slug) || 0) >= MIN_TAG_ARTICLES ? slug : null];
                }),
                related: pickRelated(cat.content, a).map((r) => [
                    r.slug!,
                    r.title,
                    r.original_img_url,
                    r.screen_name,
                ]),
            };
            shards[shardOf(a.slug)]![a.slug] = record;
            count++;
        }
    }

    fs.rmSync(SHARD_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHARD_DIR, { recursive: true });
    let largest = 0;
    shards.forEach((shard, i) => {
        const json = JSON.stringify(shard);
        largest = Math.max(largest, json.length);
        fs.writeFileSync(path.join(SHARD_DIR, `${i}.json`), json);
    });

    // Island props are JSON inside an attribute, so the shell passes values
    // there as {{jt:x}}. React's server render echoes those props into plain
    // markup too (e.g. BookmarkButton's aria-label), where JSON escaping
    // would show as stray backslashes — downgrade those to {{x}}.
    const shell = fs
        .readFileSync(SHELL_SRC, 'utf-8')
        .split(/(\sprops="[^"]*")/)
        .map((part, i) => (i % 2 === 1 ? part : part.replace(/\{\{jt:/g, '{{')))
        .join('');

    fs.mkdirSync(WORKER_BUILD, { recursive: true });
    fs.writeFileSync(path.join(WORKER_BUILD, 'article-shell.html'), shell);
    fs.rmSync(SHELL_SRC);
    fs.rmSync(path.dirname(SHELL_SRC), { recursive: true, force: true });
    fs.writeFileSync(
        path.join(WORKER_BUILD, 'meta.json'),
        JSON.stringify({ buildId: Date.now().toString(36) })
    );

    const sitemapCount = writeArticleSitemaps(shards);

    console.log(
        `✅ Worker data: ${count} articles in ${SHARD_COUNT} shards ` +
        `(largest ${(largest / 1024).toFixed(0)} KB), ${sitemapCount} article sitemaps` +
        (duplicates ? `, skipped ${duplicates} duplicate slugs` : '')
    );
}

const SITE = 'https://elhellal.com';
/** The protocol allows 50k URLs per sitemap; stay well under it. */
const SITEMAP_CHUNK = 40_000;

function escapeXml(text: string): string {
    return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Worker-rendered articles aren't pages Astro knows about, so @astrojs/sitemap
 * doesn't list them. Writes dist/sitemap-articles-N.xml and adds them to the
 * sitemap-index.xml that @astrojs/sitemap generated.
 */
function writeArticleSitemaps(shards: ArticleShard[]): number {
    const records = shards
        .flatMap((shard) => Object.values(shard))
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.slug.localeCompare(b.slug));

    for (const old of fs.readdirSync(DIST).filter((f) => f.startsWith('sitemap-articles-'))) {
        fs.rmSync(path.join(DIST, old));
    }

    const files: string[] = [];
    for (let i = 0; i < records.length; i += SITEMAP_CHUNK) {
        const urls = records.slice(i, i + SITEMAP_CHUNK).map((r) => {
            const loc = `${SITE}/articles/${encodeURIComponent(r.slug)}/`;
            const lastmod = /^\d{4}-\d{2}-\d{2}$/.test(r.created_at) ? `<lastmod>${r.created_at}</lastmod>` : '';
            return `<url><loc>${escapeXml(loc)}</loc>${lastmod}</url>`;
        });
        const name = `sitemap-articles-${files.length}.xml`;
        fs.writeFileSync(
            path.join(DIST, name),
            `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`
        );
        files.push(name);
    }

    const indexPath = path.join(DIST, 'sitemap-index.xml');
    if (!fs.existsSync(indexPath)) {
        throw new Error('dist/sitemap-index.xml not found — is @astrojs/sitemap still configured?');
    }
    const entries = files.map((f) => `<sitemap><loc>${SITE}/${f}</loc></sitemap>`).join('');
    // Drop entries from a previous run so re-running stays idempotent.
    const index = fs
        .readFileSync(indexPath, 'utf-8')
        .replace(/<sitemap><loc>[^<]*\/sitemap-articles-\d+\.xml<\/loc><\/sitemap>/g, '');
    if (!index.includes('</sitemapindex>')) throw new Error('Unexpected sitemap-index.xml format');
    fs.writeFileSync(indexPath, index.replace('</sitemapindex>', `${entries}</sitemapindex>`));
    return files.length;
}

main();
