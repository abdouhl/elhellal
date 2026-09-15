import data from '../data/quotes.json';
import type { QuotesConfig, QuoteAuthor, FlatQuote } from '../types';
import { normalizeTag, slugifyTag } from './tags';

export interface QuoteAuthorEntry {
    slug: string;
    author: string;
    authorImage?: string;
    quotes: FlatQuote[];
}

export interface QuoteBookEntry {
    slug: string;
    book: string;
    cover?: string;
    author: string;
    authorSlug: string;
    quotes: FlatQuote[];
}

export interface QuoteTagEntry {
    slug: string;
    label: string;
    quotes: FlatQuote[];
}

/** Below this many quotes, a book/tag page would be thinner than a single quote — skip it. */
export const MIN_QUOTES_PER_BOOK = 1;
export const MIN_QUOTES_PER_TAG = 3;

export function getAuthors(): QuoteAuthor[] {
    return (data as QuotesConfig).authors;
}

let cachedFlatQuotes: FlatQuote[] | null = null;

/** Flattens the nested author>book>quote storage into one array, inlining author/book context onto each quote. */
export function getQuotes(): FlatQuote[] {
    if (cachedFlatQuotes) return cachedFlatQuotes;

    const out: FlatQuote[] = [];
    for (const author of getAuthors()) {
        for (const q of author.quotes) {
            out.push({
                ...q,
                author: author.name,
                authorSlug: author.slug,
                ...(author.image ? { authorImage: author.image } : {}),
            });
        }
        for (const book of author.books) {
            for (const q of book.quotes) {
                out.push({
                    ...q,
                    author: author.name,
                    authorSlug: author.slug,
                    ...(author.image ? { authorImage: author.image } : {}),
                    book: book.title,
                    bookSlug: book.slug,
                    ...(book.cover ? { bookCover: book.cover } : {}),
                });
            }
        }
    }

    cachedFlatQuotes = out;
    return out;
}

export function getQuoteById(id: string): FlatQuote | undefined {
    return getQuotes().find((q) => q.id === id);
}

let cachedAuthorIndex: Map<string, QuoteAuthorEntry> | null = null;

export function buildQuoteAuthorIndex(): Map<string, QuoteAuthorEntry> {
    if (cachedAuthorIndex) return cachedAuthorIndex;

    const map = new Map<string, QuoteAuthorEntry>();
    for (const author of getAuthors()) {
        map.set(author.slug, {
            slug: author.slug,
            author: author.name,
            ...(author.image ? { authorImage: author.image } : {}),
            quotes: getQuotes().filter((q) => q.authorSlug === author.slug),
        });
    }

    cachedAuthorIndex = map;
    return map;
}

export function getQuoteAuthors(): QuoteAuthorEntry[] {
    return [...buildQuoteAuthorIndex().values()].sort((a, b) => b.quotes.length - a.quotes.length);
}

let cachedBookIndex: Map<string, QuoteBookEntry> | null = null;

export function buildQuoteBookIndex(): Map<string, QuoteBookEntry> {
    if (cachedBookIndex) return cachedBookIndex;

    const map = new Map<string, QuoteBookEntry>();
    for (const author of getAuthors()) {
        for (const book of author.books) {
            map.set(book.slug, {
                slug: book.slug,
                book: book.title,
                ...(book.cover ? { cover: book.cover } : {}),
                author: author.name,
                authorSlug: author.slug,
                quotes: book.quotes.map((q) => ({
                    ...q,
                    author: author.name,
                    authorSlug: author.slug,
                    ...(author.image ? { authorImage: author.image } : {}),
                    book: book.title,
                    bookSlug: book.slug,
                    ...(book.cover ? { bookCover: book.cover } : {}),
                })),
            });
        }
    }

    cachedBookIndex = map;
    return map;
}

export function getQuoteBooks(minQuotes: number = MIN_QUOTES_PER_BOOK): QuoteBookEntry[] {
    return [...buildQuoteBookIndex().values()]
        .filter((b) => b.quotes.length >= minQuotes)
        .sort((a, b) => b.quotes.length - a.quotes.length);
}

export function getQuoteBook(bookSlug: string): QuoteBookEntry | undefined {
    return buildQuoteBookIndex().get(bookSlug);
}

let cachedTagIndex: Map<string, QuoteTagEntry> | null = null;

export function buildQuoteTagIndex(): Map<string, QuoteTagEntry> {
    if (cachedTagIndex) return cachedTagIndex;

    const map = new Map<string, QuoteTagEntry>();
    getQuotes().forEach((quote) => {
        (quote.tags || []).forEach((rawTag) => {
            const label = normalizeTag(rawTag);
            if (!label) return;
            const slug = slugifyTag(rawTag);
            if (!slug) return;
            if (!map.has(slug)) {
                map.set(slug, { slug, label, quotes: [] });
            }
            map.get(slug)!.quotes.push(quote);
        });
    });

    cachedTagIndex = map;
    return map;
}

export function getQuoteTags(minQuotes: number = MIN_QUOTES_PER_TAG): QuoteTagEntry[] {
    return [...buildQuoteTagIndex().values()]
        .filter((t) => t.quotes.length >= minQuotes)
        .sort((a, b) => b.quotes.length - a.quotes.length);
}
