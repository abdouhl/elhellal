import { loadArticles } from '../lib/articles-data';
import type { Article, Category } from '../types';
import authorNames from '../data/author-names.json';

// The catalog side of utils/authors.ts, without its astro:content
// imports, so build scripts (scripts/build-worker-data.ts) can use it too.

export interface AuthorArticle extends Article {
    category: string;
}

export interface AuthorEntry {
    screen_name: string;
    profileImage?: string;
    /** Set for personal-blog writers (Layla/Omar/Youssef) instead of an X/Substack handle */
    displayName?: string;
    tagline?: string;
    bio?: string;
    accent?: string;
    isPersonal?: boolean;
    articles: AuthorArticle[];
}

let cachedIndex: Map<string, AuthorEntry> | null = null;

export function buildAuthorIndex(): Map<string, AuthorEntry> {
    if (cachedIndex) return cachedIndex;

    const map = new Map<string, AuthorEntry>();
    (loadArticles().articles as Category[]).forEach((cat) => {
        cat.content.forEach((article) => {
            if (!article.screen_name) return;
            if (!map.has(article.screen_name)) {
                map.set(article.screen_name, {
                    screen_name: article.screen_name,
                    displayName: (authorNames as Record<string, string>)[article.screen_name],
                    articles: [],
                });
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
