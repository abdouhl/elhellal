/**
 * Post-build step (runs after `astro build`): prepares everything the site
 * Worker (workers/site/) needs to serve article, tag and author pages on
 * demand.
 *
 *  1. Writes every catalog article as a precomputed ArticleRecord into
 *     dist/_data/articles/<shard>.json (see src/lib/article-page.ts).
 *  2. Writes every tag and catalog author as a ListingRecord into
 *     dist/_data/listings/<shard>.json, and the feed pages of the big ones
 *     into dist/_data/feeds/<shard>.json (see src/lib/listing-page.ts).
 *  3. Moves the page shells (dist/{articles,tags,authors}/__shell__/) out of
 *     dist/ into .worker-build/, where the Worker bundles them as strings — so
 *     the token-filled templates are never served as pages of their own.
 *  4. Writes .worker-build/meta.json with a build id the Worker uses to key
 *     its edge cache, so a deploy never serves pages cached from the last one.
 *  5. Lists the Worker-rendered pages in sitemaps, since Astro doesn't know them.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Article } from '../src/types/index.ts';
import {
    ARTICLE_SHELL_SLUG,
    SHARD_COUNT,
    shardOf,
    type ArticleRecord,
    type ArticleShard,
} from '../src/lib/article-page.ts';
import {
    LISTING_INITIAL,
    LISTING_SHARDS,
    LISTING_SHELL_SLUG,
    LISTING_TILES,
    listingKey,
    listingName,
    listingShardOf,
    type AuthorRecord,
    type ListingRecord,
    type ListingShard,
} from '../src/lib/listing-page.ts';
import {
    FEED_PAGE_SIZE,
    LISTING_FEED_SHARDS,
    compareAlpha,
    listingFeedKey,
    listingFeedShardOf,
    toFeedCard,
    type FeedCard,
    type FeedSort,
} from '../src/lib/feed.ts';
import { fnv1a } from '../src/lib/hash.ts';
import { loadArticles } from '../src/lib/articles-data.ts';
import { slugifyTag } from '../src/utils/tag-slug.ts';
import { getQualifyingTags, getQualifyingTagSlugSet } from '../src/utils/tags.ts';
import { categoryTiles, tagTiles } from '../src/utils/exploreTiles.ts';
import { buildAuthorIndex } from '../src/utils/author-index.ts';
import { personalBlogs } from '../src/data/personal-blogs.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const DATA_DIR = path.join(DIST, '_data');
const WORKER_BUILD = path.join(ROOT, '.worker-build');

/** Prerendered shells: dist/<section>/__shell__/index.html → .worker-build/<name> */
const SHELLS = [
    { section: 'articles', slug: ARTICLE_SHELL_SLUG, out: 'article-shell.html' },
    { section: 'tags', slug: LISTING_SHELL_SLUG, out: 'tag-shell.html' },
    { section: 'authors', slug: LISTING_SHELL_SLUG, out: 'author-shell.html' },
].map((s) => ({ ...s, src: path.join(DIST, s.section, s.slug, 'index.html') }));

const RELATED_COUNT = 3;

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

function writeShards(dir: string, shards: object[]): number {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    let largest = 0;
    shards.forEach((shard, i) => {
        const json = JSON.stringify(shard);
        largest = Math.max(largest, json.length);
        fs.writeFileSync(path.join(dir, `${i}.json`), json);
    });
    return largest;
}

function buildArticleShards(categoryTitles: Record<string, string>) {
    const data = loadArticles();
    // A tag gets a page once it has MIN_TAG_ARTICLES keyword occurrences.
    const tagPages = getQualifyingTagSlugSet();

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
                categoryTitle: categoryTitles[cat.category]!,
                dateAr: formatDateAr(a.created_at),
                keywords: a.keywords?.map((kw): [string, string | null] => {
                    const slug = slugifyTag(kw);
                    return [kw, tagPages.has(slug) ? slug : null];
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
    return { shards, count, duplicates };
}

/** Newest first, like the static listing pages sorted (stable for equal dates). */
function byNewest<T extends { created_at: string }>(a: T, b: T): number {
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
}

function buildListingShards(categoryTitles: Record<string, string>) {
    const listings: ListingShard[] = Array.from({ length: LISTING_SHARDS }, () => ({}));
    const feeds: Array<Record<string, FeedCard[]>> = Array.from({ length: LISTING_FEED_SHARDS }, () => ({}));
    let tagCount = 0;
    let authorCount = 0;
    let pagedCount = 0;

    const add = (record: ListingRecord, cards: FeedCard[]) => {
        const key = listingKey(record.kind, listingName(record));
        listings[listingShardOf(key)]![key] = record;
        if (cards.length <= LISTING_INITIAL) return;
        // Big listings page through the rest (see fetchFeedPage in src/lib/feed.ts).
        pagedCount++;
        const sorts: Array<[FeedSort, FeedCard[]]> = [
            ['newest', cards],
            ['alpha', [...cards].sort(compareAlpha)],
        ];
        for (const [sort, list] of sorts) {
            for (let page = 0; page * FEED_PAGE_SIZE < list.length; page++) {
                const feedKey = listingFeedKey(key, sort, page);
                feeds[listingFeedShardOf(feedKey)]![feedKey] = list.slice(page * FEED_PAGE_SIZE, (page + 1) * FEED_PAGE_SIZE);
            }
        }
    };

    for (const tag of getQualifyingTags()) {
        // An article listing the same keyword twice is indexed twice; show it once.
        const seen = new Set<string>();
        const cards = [...tag.articles]
            .sort(byNewest)
            .filter((a) => a.slug && !seen.has(a.slug) && !!seen.add(a.slug))
            .map((a) => toFeedCard(a, a.category));
        add(
            {
                kind: 'tag',
                slug: tag.slug,
                label: tag.label,
                total: cards.length,
                cards: cards.slice(0, LISTING_INITIAL),
                // Tags that show up alongside this one
                tiles: tagTiles(tag.articles, [tag.slug], LISTING_TILES),
            },
            cards
        );
        tagCount++;
    }

    // Personal-blog writers keep their prerendered pages.
    const personal = new Set(Object.values(personalBlogs).map((p) => p.slug as string));
    for (const author of buildAuthorIndex().values()) {
        if (personal.has(author.screen_name)) continue;
        const sorted = [...author.articles].sort(byNewest);
        const cards = sorted.map((a) => toFeedCard(a, a.category));

        const categoryCounts = new Map<string, number>();
        for (const a of author.articles) {
            const label = categoryTitles[a.category] || a.category;
            categoryCounts.set(label, (categoryCounts.get(label) || 0) + 1);
        }

        // External profile link: their Substack, else the source site, else X.
        let source: URL | undefined;
        try {
            const firstUrl = author.articles.find((a) => a.url)?.url;
            source = firstUrl ? new URL(firstUrl) : undefined;
        } catch {
            // Malformed URL: fall back to X.
        }
        const sourceHost = source?.hostname.replace(/^www\./, '');
        const isSubstack = !!sourceHost && sourceHost.endsWith('substack.com');

        const record: AuthorRecord = {
            kind: 'author',
            screen_name: author.screen_name,
            displayName: author.displayName,
            profileImage: author.profileImage,
            latestDateAr: sorted[0] ? formatDateAr(sorted[0].created_at) : undefined,
            profileUrl: isSubstack
                ? `https://${author.screen_name}.substack.com`
                : source?.origin ?? `https://x.com/${author.screen_name}`,
            profileLinkLabel: isSubstack ? 'Substack' : (sourceHost ?? 'عرض على X'),
            topCategories: [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
            total: cards.length,
            cards: cards.slice(0, LISTING_INITIAL),
            tiles: categoryTiles(author.articles, LISTING_TILES),
        };
        add(record, cards);
        authorCount++;
    }

    return { listings, feeds, tagCount, authorCount, pagedCount };
}

/**
 * The listing shells' MasonryFeed island is rendered by the Worker per page:
 * swap its serialized props and server-rendered HTML for raw tokens.
 */
function tokenizeFeedIsland(html: string, name: string): string {
    const island = /(<astro-island\b[^>]*component-url="[^"]*\/MasonryFeed\.[^"]*"[^>]*>)([\s\S]*?)(<\/astro-island>)/g;
    let count = 0;
    const result = html.replace(island, (_, open: string, inner: string, end: string) => {
        count++;
        const withProps = open.replace(/\sprops="[^"]*"/, ' props="{{{feedProps}}}"');
        if (withProps === open) throw new Error(`${name}: MasonryFeed island has no props attribute`);
        // Islands with await-children hydrate once this marker has been parsed.
        const endMarker = inner.endsWith('<!--astro:end-->') ? '<!--astro:end-->' : '';
        return `${withProps}{{{feedHtml}}}${endMarker}${end}`;
    });
    if (count !== 1) throw new Error(`${name}: expected 1 MasonryFeed island, found ${count}`);
    return result;
}

function moveShells() {
    fs.mkdirSync(WORKER_BUILD, { recursive: true });
    for (const shell of SHELLS) {
        let html = fs.readFileSync(shell.src, 'utf-8');
        if (shell.section === 'articles') {
            // Island props are JSON inside an attribute, so the shell passes values
            // there as {{jt:x}}. React's server render echoes those props into plain
            // markup too (e.g. BookmarkButton's aria-label), where JSON escaping
            // would show as stray backslashes — downgrade those to {{x}}.
            html = html
                .split(/(\sprops="[^"]*")/)
                .map((part, i) => (i % 2 === 1 ? part : part.replace(/\{\{jt:/g, '{{')))
                .join('');
        } else {
            html = tokenizeFeedIsland(html, shell.out);
        }
        fs.writeFileSync(path.join(WORKER_BUILD, shell.out), html);
        fs.rmSync(path.dirname(shell.src), { recursive: true, force: true });
    }
}

function main() {
    for (const shell of SHELLS) {
        if (!fs.existsSync(shell.src)) {
            throw new Error(`Shell not found at ${shell.src} — run \`astro build\` first.`);
        }
    }

    const categoryTitles: Record<string, string> = {};
    for (const cat of loadArticles().articles) {
        categoryTitles[cat.category] = cat.title || cat.category.charAt(0).toUpperCase() + cat.category.slice(1);
    }

    const articles = buildArticleShards(categoryTitles);
    const largestArticles = writeShards(path.join(DATA_DIR, 'articles'), articles.shards);

    const listings = buildListingShards(categoryTitles);
    const largestListings = writeShards(path.join(DATA_DIR, 'listings'), listings.listings);
    const largestFeeds = writeShards(path.join(DATA_DIR, 'feeds'), listings.feeds);

    moveShells();
    fs.writeFileSync(
        path.join(WORKER_BUILD, 'meta.json'),
        JSON.stringify({ buildId: Date.now().toString(36), categoryTitles })
    );

    const articlePaths = articles.shards
        .flatMap((shard) => Object.values(shard))
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.slug.localeCompare(b.slug))
        .map((r) => ({ path: `/articles/${encodeURIComponent(r.slug)}/`, lastmod: r.created_at }));
    const listingPaths = listings.listings
        .flatMap((shard) => Object.values(shard))
        .map((r) => `/${r.kind === 'tag' ? 'tags' : 'authors'}/${encodeURIComponent(listingName(r))}/`)
        .sort()
        .map((p) => ({ path: p }));
    const sitemapCount = writeSitemaps('articles', articlePaths) + writeSitemaps('listings', listingPaths);

    const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
    console.log(
        `✅ Worker data: ${articles.count} articles in ${SHARD_COUNT} shards (largest ${kb(largestArticles)})` +
        (articles.duplicates ? `, skipped ${articles.duplicates} duplicate slugs` : '')
    );
    console.log(
        `✅ Listings: ${listings.tagCount} tags + ${listings.authorCount} authors in ${LISTING_SHARDS} shards ` +
        `(largest ${kb(largestListings)}); ${listings.pagedCount} paged feeds in ${LISTING_FEED_SHARDS} shards ` +
        `(largest ${kb(largestFeeds)}); ${sitemapCount} sitemaps`
    );
}

const SITE = 'https://elhellal.com';
/** The protocol allows 50k URLs per sitemap; stay well under it. */
const SITEMAP_CHUNK = 40_000;

function escapeXml(text: string): string {
    return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Worker-rendered pages aren't pages Astro knows about, so @astrojs/sitemap
 * doesn't list them. Writes dist/sitemap-<name>-N.xml and adds them to the
 * sitemap-index.xml that @astrojs/sitemap generated.
 */
function writeSitemaps(name: string, pages: Array<{ path: string; lastmod?: string }>): number {
    const prefix = `sitemap-${name}-`;
    for (const old of fs.readdirSync(DIST).filter((f) => f.startsWith(prefix))) {
        fs.rmSync(path.join(DIST, old));
    }

    const files: string[] = [];
    for (let i = 0; i < pages.length; i += SITEMAP_CHUNK) {
        const urls = pages.slice(i, i + SITEMAP_CHUNK).map((p) => {
            const lastmod = p.lastmod && /^\d{4}-\d{2}-\d{2}$/.test(p.lastmod) ? `<lastmod>${p.lastmod}</lastmod>` : '';
            return `<url><loc>${escapeXml(SITE + p.path)}</loc>${lastmod}</url>`;
        });
        const file = `${prefix}${files.length}.xml`;
        fs.writeFileSync(
            path.join(DIST, file),
            `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`
        );
        files.push(file);
    }

    const indexPath = path.join(DIST, 'sitemap-index.xml');
    if (!fs.existsSync(indexPath)) {
        throw new Error('dist/sitemap-index.xml not found — is @astrojs/sitemap still configured?');
    }
    const entries = files.map((f) => `<sitemap><loc>${SITE}/${f}</loc></sitemap>`).join('');
    // Drop entries from a previous run so re-running stays idempotent.
    const index = fs
        .readFileSync(indexPath, 'utf-8')
        .replace(new RegExp(`<sitemap><loc>[^<]*/${prefix}\\d+\\.xml</loc></sitemap>`, 'g'), '');
    if (!index.includes('</sitemapindex>')) throw new Error('Unexpected sitemap-index.xml format');
    fs.writeFileSync(indexPath, index.replace('</sitemapindex>', `${entries}</sitemapindex>`));
    return files.length;
}

main();
