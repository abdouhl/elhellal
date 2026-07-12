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
    bio?: string;
    accent?: string;
    isPersonal?: boolean;
    articles: AuthorArticle[];
}

// Dev-only bridge to the local write.elhellal (WriteFreely) instance — see
// elhellal-write's README. Add a blog's alias here once you've created it
// locally to have its posts show up under /authors while developing.
// Deliberately NOT fetched in production builds: write.elhellal isn't
// deployed anywhere yet, so `astro build` would either fail or hang trying
// to reach localhost. `import.meta.env.DEV` is a build-time constant, so
// this whole branch is dead-code-eliminated from the production bundle.
const WRITEFREELY_BASE_URL = import.meta.env.WRITEFREELY_URL || 'http://localhost:8080';
const WRITEFREELY_ALIASES = ['abdou'];

interface WriteFreelyPost {
    id: string;
    slug: string;
    title: string;
    body: string;
    created: string;
    language: string;
    rtl: boolean;
}

interface WriteFreelyCollectionResponse {
    code: number;
    data: {
        alias: string;
        title: string;
        description: string;
        url: string;
        posts: WriteFreelyPost[];
    };
}

/** Strips common Markdown syntax down to plain text, for card titles/previews. */
function stripMarkdown(text: string): string {
    return text
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt text
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> link text
        .replace(/^#{1,6}\s*/gm, '') // headers
        .replace(/^>\s?/gm, '') // blockquotes
        .replace(/^[-*+]\s+/gm, '') // bullet lists
        .replace(/^\d+\.\s+/gm, '') // numbered lists
        .replace(/`{1,3}([^`]*)`{1,3}/g, '$1') // inline/code fences
        .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
        .replace(/(\*|_)(.*?)\1/g, '$2') // italic
        .trim();
}

/** Truncates to maxLen at a word boundary, appending an ellipsis if cut. */
function truncateAtWord(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    const cut = text.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/** Body without its first line — used when the title was derived from that line. */
function bodyMinusFirstLine(body: string): string {
    const lines = body.split('\n');
    const firstNonEmpty = lines.findIndex((line) => line.trim().length > 0);
    return lines.slice(firstNonEmpty + 1).join(' ');
}

function derivePostTitle(post: WriteFreelyPost): string {
    if (post.title.trim()) return truncateAtWord(stripMarkdown(post.title.trim()), 90);
    const firstLine = post.body.split('\n').find((line) => line.trim().length > 0) ?? '';
    const cleaned = truncateAtWord(stripMarkdown(firstLine), 70);
    return cleaned || 'منشور بدون عنوان';
}

function derivePreview(post: WriteFreelyPost): string {
    const source = post.title.trim() ? post.body : bodyMinusFirstLine(post.body);
    const cleaned = stripMarkdown(source).replace(/\s+/g, ' ').trim();
    return truncateAtWord(cleaned, 160) || 'بلا مقتطف نصي.';
}

async function getWriteFreelyAuthorEntries(): Promise<AuthorEntry[]> {
    if (!import.meta.env.DEV) return [];

    const entries = await Promise.all(
        WRITEFREELY_ALIASES.map(async (alias): Promise<AuthorEntry | null> => {
            try {
                const res = await fetch(`${WRITEFREELY_BASE_URL}/api/collections/${alias}/posts`);
                if (!res.ok) return null;
                const json = (await res.json()) as WriteFreelyCollectionResponse;
                const { data: coll } = json;

                return {
                    screen_name: coll.alias,
                    displayName: coll.title || coll.alias,
                    tagline: coll.description || 'مدونة شخصية (وضع التطوير فقط)',
                    accent: '#0f766e',
                    isPersonal: true,
                    articles: coll.posts.map((post): AuthorArticle => ({
                        id_str: post.id,
                        screen_name: coll.alias,
                        title: derivePostTitle(post),
                        preview_text: derivePreview(post),
                        created_at: post.created.slice(0, 10),
                        slug: post.slug,
                        url: `${WRITEFREELY_BASE_URL}/${coll.alias}/${post.slug}`,
                        internalHref: `${WRITEFREELY_BASE_URL}/${coll.alias}/${post.slug}`,
                        category: 'write.elhellal (تجريبي)',
                    })),
                };
            } catch {
                // write.elhellal isn't running locally right now — skip it silently
                // rather than breaking `bun run dev`.
                return null;
            }
        })
    );

    return entries.filter((entry): entry is AuthorEntry => entry !== null);
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
                bio: person.bio,
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
    const writeFreelyAuthors = await getWriteFreelyAuthorEntries();
    return [...substackAuthors, ...personalAuthors, ...writeFreelyAuthors].sort(
        (a, b) => b.articles.length - a.articles.length
    );
}

export function getAuthorSlugSet(): Set<string> {
    return new Set(buildAuthorIndex().keys());
}
