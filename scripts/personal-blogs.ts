/**
 * Registry of personal/independent blogs to pull into articles.json.
 * Unlike Substack authors (identified by a username), these need a full URL
 * since they can live on any platform or custom domain.
 *
 * `slug` becomes the `screen_name` on imported articles — keep it stable once
 * set, since changing it later will make the importer treat existing posts
 * as belonging to a "new" author in your UI (article IDs themselves are still
 * deduped by URL hash, so you won't get duplicates, just an orphaned author).
 */

export interface PersonalBlogConfig {
    slug: string;      // used as `screen_name` in articles.json
    name: string;      // author/blog display name
    url: string;       // homepage URL (trailing slash optional)
    feedUrl?: string;  // set this only if feed auto-discovery fails for this blog
}

export const personalBlogs: Record<string, PersonalBlogConfig> = {
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
