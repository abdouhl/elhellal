/**
 * Cross-links to the sibling sites (quotes / books / biographies / quiz
 * .elhellal.com). scripts/fetch-sister-sites.ts snapshots their app feeds
 * into src/data/sister-sites.json; at build time scripts/build-worker-data.ts
 * uses this to give every article page a "من عالم الهلال" strip and matching
 * tag pages a card, and writes dist/sister-links.json — which elhellal
 * articles mention each sibling page — for the siblings to link back.
 *
 * Pure code, no Node or Astro imports: it runs in bun, workerd and browsers.
 */

import { fnv1a } from './hash';

export const SISTER_SITES = ['biographies', 'books', 'quotes', 'quiz'] as const;
export type SisterSiteKey = (typeof SISTER_SITES)[number];

/** Item shapes of each site's /app-feed.json (see src/pages/app-feed.json.ts in each repo). */
interface FeedItem {
    title: string;
    meta?: string;
    text?: string;
    image?: string;
    url: string;
}
interface QuizItem {
    title: string;
    options: string[];
    answer: number;
    url: string;
}
export interface SisterSnapshot {
    biographies: FeedItem[];
    books: FeedItem[];
    quotes: FeedItem[];
    quiz: QuizItem[];
}

/** [site, title, meta, image, url] — compact, since every article record carries a few. */
export type SisterLink = [SisterSiteKey, string, string, string | undefined, string];

/** Tiles on an article page's strip. */
export const SISTER_STRIP = 3;

/** What the tile says it is, by site. */
export const SISTER_KIND_LABELS: Record<SisterSiteKey, string> = {
    biographies: 'سيرة',
    books: 'ملخص كتاب',
    quotes: 'اقتباس',
    quiz: 'اختبر معلوماتك',
};

/**
 * Loose Arabic matching key: no diacritics or tatweel, one alef/yaa/haa form,
 * no quotes or punctuation — "«أحلام مستغانمى»" and "احلام مستغانمي" agree.
 */
export function matchKey(text: string): string {
    return text
        .normalize('NFKC')
        .replace(/[ً-ٰٟـ]/g, '')
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')}…` : text;
}

function toLink(site: Exclude<SisterSiteKey, 'quiz'>, item: FeedItem): SisterLink {
    if (site === 'quotes') return [site, `«${clip(item.text ?? item.title, 140)}»`, item.title, item.image, item.url];
    return [site, item.title, item.meta ?? '', item.image, item.url];
}

function quizLink(item: QuizItem): SisterLink {
    return ['quiz', item.title, item.options.join(' · '), undefined, item.url];
}

export interface SisterIndex {
    /** matchKey(name) → links about that person or book, biography first */
    byName: Map<string, SisterLink[]>;
    /** Multi-word names, longest first, worth looking for inside a title */
    titleNames: string[];
    snapshot: SisterSnapshot;
}

export function buildSisterIndex(snapshot: SisterSnapshot): SisterIndex {
    const byName = new Map<string, SisterLink[]>();
    const add = (name: string | undefined, link: SisterLink) => {
        const key = name ? matchKey(name) : '';
        if (key.length < 3) return;
        const list = byName.get(key) ?? [];
        if (!list.some((l) => l[4] === link[4])) list.push(link);
        byName.set(key, list);
    };

    for (const bio of snapshot.biographies) add(bio.title, toLink('biographies', bio));
    for (const book of snapshot.books) {
        const link = toLink('books', book);
        add(book.title, link);
        add(book.meta, link); // the author: "articles about X" → X's books too
    }
    // A quote only stands in for its author when nothing else covers them.
    for (const quote of snapshot.quotes) {
        const key = matchKey(quote.title);
        if (!byName.has(key)) add(quote.title, toLink('quotes', quote));
    }

    const order: Record<SisterSiteKey, number> = { biographies: 0, books: 1, quotes: 2, quiz: 3 };
    for (const list of byName.values()) list.sort((a, b) => order[a[0]] - order[b[0]]);

    // Single words ("يوتوبيا", "الهول") hit unrelated titles; keywords still match them exactly.
    const titleNames = [...byName.keys()].filter((k) => k.includes(' ') && k.length >= 8).sort((a, b) => b.length - a.length);
    return { byName, titleNames, snapshot };
}

/** Sibling pages about the people and books an article's keywords (or title) name. */
export function matchSisterLinks(index: SisterIndex, keywords: string[] | undefined, title: string): SisterLink[] {
    const result: SisterLink[] = [];
    const push = (links: SisterLink[] | undefined) => {
        for (const link of links ?? []) if (!result.some((l) => l[4] === link[4])) result.push(link);
    };
    for (const kw of keywords ?? []) push(index.byName.get(matchKey(kw)));
    const titleKey = ` ${matchKey(title)} `;
    for (const name of index.titleNames) if (titleKey.includes(` ${name} `)) push(index.byName.get(name));
    return result;
}

/**
 * An article page's strip: what it matched, then one deterministic pick per
 * site it doesn't have yet (book, quote, quiz question), so every article
 * sends readers somewhere in the family.
 */
export function sisterStrip(index: SisterIndex, matched: SisterLink[], slug: string): SisterLink[] {
    const strip = matched.slice(0, SISTER_STRIP);
    const fillers: Array<() => SisterLink | undefined> = [
        () => pick(index.snapshot.books, slug, 'books', (b) => toLink('books', b)),
        () => pick(index.snapshot.quotes, slug, 'quotes', (q) => toLink('quotes', q)),
        () => pick(index.snapshot.quiz, slug, 'quiz', quizLink),
    ];
    for (const filler of fillers) {
        if (strip.length >= SISTER_STRIP) break;
        const link = filler();
        if (link && !strip.some((l) => l[0] === link[0])) strip.push(link);
    }
    return strip;
}

function pick<T>(items: T[], slug: string, salt: string, map: (item: T) => SisterLink): SisterLink | undefined {
    if (items.length === 0) return undefined;
    return map(items[fnv1a(`${salt}:${slug}`) % items.length]!);
}

/** Template data for a strip of links (article shell and tag shell share the markup). */
export function sisterTiles(links: SisterLink[] | undefined) {
    return (links ?? []).map(([site, title, meta, image, url]) => ({
        kind: SISTER_KIND_LABELS[site],
        site,
        title,
        meta,
        image: image ?? '',
        url,
    }));
}
