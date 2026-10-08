/**
 * Feed data shared by the listing pages (build) and MasonryFeed (browser).
 *
 * Listing feeds used to import the whole dataset into the client bundle
 * (18MB+ of JS on every listing page). Instead, each feed scope ("all" or a
 * category) is prerendered as static JSON pages of compact cards by
 * src/pages/feed/[scope]/[sort]/[page].json.ts, and MasonryFeed fetches them
 * as the reader scrolls (or searches).
 *
 * Pure code: no Node or Astro imports.
 */

export type FeedSort = 'newest' | 'alpha';

/** Cards per static feed file. Search scans whole files, so keep them big-ish. */
export const FEED_PAGE_SIZE = 500;
/** Cards server-rendered into the page (and passed as island props). */
export const FEED_INITIAL = 100;

/** The fields a Card actually renders — nothing else ships to the browser. */
export interface FeedCard {
    slug?: string | undefined;
    title: string;
    img?: string | undefined;
    author?: string | undefined;
    date: string;
    category: string;
    /** External link, only for entries without a slug (no article page) */
    url?: string | undefined;
    // Personal-blog posts link to their own author page and show a real name.
    authorHref?: string | undefined;
    authorName?: string | undefined;
    internalHref?: string | undefined;
}

interface CardSource {
    slug?: string | undefined;
    title: string;
    original_img_url?: string | undefined;
    screen_name?: string | undefined;
    created_at: string;
    url?: string | undefined;
    id_str?: string | undefined;
    authorHref?: string | undefined;
    authorName?: string | undefined;
    internalHref?: string | undefined;
}

export function toFeedCard(a: CardSource, category: string): FeedCard {
    const card: FeedCard = { title: a.title, date: a.created_at, category };
    if (a.slug) card.slug = a.slug;
    else card.url = a.url || (a.screen_name && a.id_str ? `https://x.com/${a.screen_name}/status/${a.id_str}` : undefined);
    if (a.original_img_url) card.img = a.original_img_url;
    if (a.screen_name) card.author = a.screen_name;
    if (a.authorHref) card.authorHref = a.authorHref;
    if (a.authorName) card.authorName = a.authorName;
    if (a.internalHref) card.internalHref = a.internalHref;
    return card;
}

export function feedPageUrl(scope: string, sort: FeedSort, page: number): string {
    return `/feed/${encodeURIComponent(scope)}/${sort}/${page}.json`;
}

export function feedPageCount(total: number): number {
    return Math.max(1, Math.ceil(total / FEED_PAGE_SIZE));
}

/** Same ordering as the old client-side comparators (utils/sorting.ts). */
export function compareNewest(a: FeedCard, b: FeedCard): number {
    return new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
}

export function compareAlpha(a: FeedCard, b: FeedCard): number {
    return a.title.localeCompare(b.title);
}

/**
 * Folds the spelling variants Arabic readers type interchangeably, so
 * "اسلام" finds "الإسلام" and "مدرسه" finds "مدرسة": strips tashkeel and
 * tatweel, unifies alef/hamza forms, ya/alef maqsura and ta marbuta/ha.
 */
export function normalizeArabic(text: string): string {
    return text
        .toLowerCase()
        .replace(/[ً-ٰٟـ]/g, '')
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/ؤ/g, 'و')
        .replace(/ئ/g, 'ي');
}

export function queryTokens(query: string): string[] {
    return normalizeArabic(query).split(/\s+/).filter((t) => t.length > 0);
}

/** Every token must appear in the title or author name. */
export function matchesQuery(card: FeedCard, tokens: string[]): boolean {
    if (tokens.length === 0) return true;
    const haystack = normalizeArabic(`${card.title} ${card.authorName || card.author || ''}`);
    return tokens.every((t) => haystack.includes(t));
}
