/**
 * Registry of REAL, externally-hosted personal blogs to pull into articles.json
 * via RSS/Atom (see scripts/import-external-blogs.ts).
 *
 * This is deliberately separate from src/data/personal-blogs.ts — that file
 * defines your four fixed local personas (omar/layla/youssef/yacine) tied to
 * Astro content collections, which is a different system (locally-authored
 * content, no URL, no feed). Don't merge the two: an external blog has no
 * `collection`/`nameAr`/`bio`/`accent` the rest of your site can render from,
 * and a persona has no URL to scrape.
 *
 * `slug` becomes the `screen_name` on imported articles — keep it stable once
 * set (article dedup is by URL hash regardless, so changing it later just
 * orphans the old screen_name in your UI rather than duplicating posts).
 */

export interface ExternalBlogConfig {
    slug: string;      // used as `screen_name` in articles.json
    name: string;       // author/blog display name, for your own reference/logs
    url: string;        // homepage URL (trailing slash optional)
    feedUrl?: string;   // set this only if feed auto-discovery fails for this blog
}

export const externalBlogs: Record<string, ExternalBlogConfig> = {
    alfarhan: {
        slug: 'alfarhan',
        name: 'الفرهان',
        url: 'https://alfarhan.ws/',
    },
    fatthatmablog: {
        slug: 'fatthatmablog',
        name: 'فتاتها',
        url: 'https://fatthatmablog.wordpress.com',
    },
};
