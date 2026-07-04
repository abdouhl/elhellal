import { getCollection } from 'astro:content';
import data from '../data/articles.json';
import type { Article, Category } from '../types';
import { personalBlogs } from '../data/personal-blogs';

export interface AuthorArticle extends Article {
    category: string;
}

export interface AuthorEntry {
    screen_name: string;
    profileImage?: string;
    /** Set for personal-blog writers (Layla/Omar/Youssef) instead of an X/Substack handle */
    displayName?: string;
    tagline?: string;
    accent?: string;
    isPersonal?: boolean;
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

async function getPersonalAuthorEntries(): Promise<AuthorEntry[]> {
    const entries = await Promise.all(
        Object.values(personalBlogs).map(async (person): Promise<AuthorEntry> => {
            const posts = await getCollection(person.collection);
            return {
                screen_name: person.slug,
                displayName: person.nameAr,
                tagline: person.tagline,
                accent: person.accent,
                isPersonal: true,
                articles: posts.map((post): AuthorArticle => ({
                    id_str: post.slug,
                    screen_name: person.slug,
                    title: post.data.title,
                    preview_text: post.data.description,
                    created_at: post.data.pubDate.toISOString().slice(0, 10),
                    slug: post.slug,
                    original_img_url: post.data.large || post.data.thumb,
                    category: person.tagline,
                })),
            };
        })
    );
    return entries;
}

export async function getAuthors(): Promise<AuthorEntry[]> {
    const substackAuthors = [...buildAuthorIndex().values()];
    const personalAuthors = await getPersonalAuthorEntries();
    return [...substackAuthors, ...personalAuthors].sort((a, b) => b.articles.length - a.articles.length);
}

export function getAuthorSlugSet(): Set<string> {
    return new Set(buildAuthorIndex().keys());
}
