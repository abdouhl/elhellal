import data from '../data/articles.json';
import type { Article, Category } from '../types';

export interface TaggedArticle extends Article {
    category: string;
}

export interface TagEntry {
    slug: string;
    label: string;
    articles: TaggedArticle[];
}

/** Below this many articles, a tag page would be thinner than the article itself — skip it. */
export const MIN_TAG_ARTICLES = 3;

export function normalizeTag(raw: string): string {
    return raw.trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
}

export function slugifyTag(raw: string): string {
    return normalizeTag(raw).replace(/\s+/g, '-');
}

let cachedIndex: Map<string, TagEntry> | null = null;

export function buildTagIndex(): Map<string, TagEntry> {
    if (cachedIndex) return cachedIndex;

    const map = new Map<string, TagEntry>();
    (data.articles as Category[]).forEach((cat) => {
        cat.content.forEach((article) => {
            (article.keywords || []).forEach((kw) => {
                const label = normalizeTag(kw);
                if (!label) return;
                const slug = slugifyTag(kw);
                if (!map.has(slug)) {
                    map.set(slug, { slug, label, articles: [] });
                }
                map.get(slug)!.articles.push({ ...article, category: cat.category });
            });
        });
    });

    cachedIndex = map;
    return map;
}

export function getQualifyingTags(minArticles: number = MIN_TAG_ARTICLES): TagEntry[] {
    return [...buildTagIndex().values()]
        .filter((t) => t.articles.length >= minArticles)
        .sort((a, b) => b.articles.length - a.articles.length);
}

export function getQualifyingTagSlugSet(minArticles: number = MIN_TAG_ARTICLES): Set<string> {
    return new Set(getQualifyingTags(minArticles).map((t) => t.slug));
}
