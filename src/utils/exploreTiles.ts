import { loadArticles } from '../lib/articles-data';
import { isImageUrl, resizeImage, TILE_WIDTH } from '../lib/images';
import type { Category } from '../types';
import { buildTagIndex, MIN_TAG_ARTICLES, normalizeTag, slugifyTag, type TaggedArticle } from './tags';

const data = loadArticles();

// Tiles for the Imgur-style "explore" block on listing pages.
export interface ExploreTile {
    href: string;
    label: string;
    count: number;
    image?: string | undefined;
}

const categories = data.articles as Category[];

/** Tags that just repeat a category name ("علم النفس" on the psychology page) add nothing. */
const categoryTitles = new Set(categories.map((c) => normalizeTag(c.title)));

/** Picks a (resized) cover per tile, avoiding images already used by earlier tiles. */
function coverPicker() {
    const used = new Set<string>();
    return (urls: Array<string | undefined>): string | undefined => {
        const images = urls.filter(isImageUrl);
        const image = images.find((url) => !used.has(url)) ?? images[0];
        if (!image) return undefined;
        used.add(image);
        return resizeImage(image, TILE_WIDTH);
    };
}

/** Every category, biggest first (or only those the given articles fall into). */
export function categoryTiles(articles?: Array<{ category: string }>, limit = 48): ExploreTile[] {
    const pick = coverPicker();
    const counts = new Map<string, number>();
    articles?.forEach((a) => counts.set(a.category, (counts.get(a.category) || 0) + 1));

    return categories
        .map((cat) => ({ cat, count: articles ? counts.get(cat.category) || 0 : cat.content.length }))
        .filter(({ count }) => count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, limit)
        .map(({ cat, count }) => ({
            href: `/${cat.category}/`,
            label: cat.title,
            count,
            image: pick(cat.content.slice(0, 20).map((a) => a.original_img_url)),
        }));
}

/**
 * Tags that occur most among `articles`, linking to their tag page.
 * Counts are the tag's total (what the tag page will show).
 */
export function tagTiles(articles: TaggedArticle[], exclude: string[] = [], limit = 40): ExploreTile[] {
    const index = buildTagIndex();
    const skip = new Set(exclude);
    // One pass: how often each tag occurs here, plus a few candidate covers.
    const freq = new Map<string, { count: number; images: string[] }>();

    articles.forEach((article) => {
        new Set(keywordSlugs(article)).forEach((slug) => {
            if (skip.has(slug) || !index.has(slug)) return;
            const entry = freq.get(slug) ?? { count: 0, images: [] };
            entry.count += 1;
            if (article.original_img_url && entry.images.length < 12) entry.images.push(article.original_img_url);
            freq.set(slug, entry);
        });
    });

    const pick = coverPicker();
    return [...freq.entries()]
        .filter(([slug]) => index.get(slug)!.articles.length >= MIN_TAG_ARTICLES)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, limit)
        .map(([slug, { images }]) => {
            const tag = index.get(slug)!;
            return {
                href: `/tags/${encodeURIComponent(slug)}/`,
                label: tag.label,
                count: tag.articles.length,
                image: pick(images),
            };
        });
}

// Keyword slugs per article (minus ones that just name a category), cached
// because every tag page re-scans overlapping article sets at build time.
const slugCache = new Map<string, string[]>();
function keywordSlugs(article: TaggedArticle): string[] {
    const key = `${article.category}:${article.id_str}`;
    let slugs = slugCache.get(key);
    if (!slugs) {
        slugs = (article.keywords || [])
            .filter((kw) => !categoryTitles.has(normalizeTag(kw)))
            .map(slugifyTag)
            .filter(Boolean);
        slugCache.set(key, slugs);
    }
    return slugs;
}

/** Articles of a category in the shape tagTiles expects. */
export function categoryArticles(category: string): TaggedArticle[] {
    const cat = categories.find((c) => c.category === category);
    return (cat?.content || []).map((a) => ({ ...a, category }));
}
