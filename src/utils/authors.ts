import data from '../data/articles.json';
import type { Article, Category } from '../types';

export interface AuthorArticle extends Article {
    category: string;
}

export interface AuthorEntry {
    screen_name: string;
    profileImage?: string;
    articles: AuthorArticle[];
}

let cachedIndex: Map<string, AuthorEntry> | null = null;

export function buildAuthorIndex(): Map<string, AuthorEntry> {
    if (cachedIndex) return cachedIndex;

    const map = new Map<string, AuthorEntry>();
    (data.articles as Category[]).forEach((cat) => {
        cat.content.forEach((article) => {
            if (!article.screen_name) return;
            if (!map.has(article.screen_name)) {
                map.set(article.screen_name, { screen_name: article.screen_name, articles: [] });
            }
            const entry = map.get(article.screen_name)!;
            entry.articles.push({ ...article, category: cat.category });
            if (!entry.profileImage && article.profile_image_url_https) {
                entry.profileImage = article.profile_image_url_https;
            }
        });
    });

    cachedIndex = map;
    return map;
}

export function getAuthors(): AuthorEntry[] {
    return [...buildAuthorIndex().values()].sort((a, b) => b.articles.length - a.articles.length);
}

export function getAuthorSlugSet(): Set<string> {
    return new Set(buildAuthorIndex().keys());
}
