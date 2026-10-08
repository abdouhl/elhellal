/**
 * Data contract between the build (scripts/build-worker-data.ts), which
 * writes article records into static JSON shards under dist/_data/articles/,
 * and the site Worker (workers/site/), which reads one shard per request and
 * fills the article shell page (src/pages/articles/[slug].astro, rendered
 * with slug = ARTICLE_SHELL_SLUG).
 *
 * Pure code, no Node or Astro imports: it runs in both bun and workerd.
 */

import type { TemplateData } from './shell-template';

export const ARTICLE_SHELL_SLUG = '__shell__';

/**
 * Fixed shard count: ~7 articles per shard today, ~50 (~150KB) at 100k
 * articles. Changing it re-buckets every article, which is fine — shards are
 * rebuilt from scratch on every build.
 */
export const SHARD_COUNT = 2048;

/** FNV-1a over UTF-16 code units — identical in bun and workerd. */
export function shardOf(slug: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < slug.length; i++) {
        hash ^= slug.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) % SHARD_COUNT;
}

export interface ArticleRecord {
    slug: string;
    title: string;
    preview_text: string;
    original_img_url?: string;
    profile_image_url_https?: string;
    id_str: string;
    screen_name: string;
    created_at: string;
    url?: string;
    tag?: string;
    tldr?: string;
    whyThisMatters?: string;
    whoShouldRead?: string;
    metaDescription?: string;
    // Precomputed at build time so the Worker does no Intl work or lookups:
    category: string;
    categoryTitle: string;
    /** created_at formatted as toLocaleDateString('ar', { day, month: 'long', year }) */
    dateAr: string;
    /** [keyword, tag slug] — slug is null when the tag has no page */
    keywords?: Array<[string, string | null]>;
    /** [slug, title, image, screen_name] of up to 3 articles from the same category */
    related: Array<[string, string, string | undefined, string | undefined]>;
}

export type ArticleShard = Record<string, ArticleRecord>;

const SITE = 'https://elhellal.com';
const DEFAULT_OG_IMAGE = `${SITE}/og-image.jpg`;

/**
 * Everything the article shell's {{tokens}} need. Mirrors the derivations in
 * [slug].astro — keep the two in sync.
 */
export function articleTemplateData(r: ArticleRecord): TemplateData {
    const canonicalUrl = `${SITE}/articles/${encodeURIComponent(r.slug)}/`;
    const tweetUrl = `https://x.com/${r.screen_name}/status/${r.id_str}`;
    const readUrl = r.url || tweetUrl;
    let sourceHost: string | null = null;
    let sourceOrigin: string | null = null;
    if (r.url) {
        try {
            const parsed = new URL(r.url);
            sourceHost = parsed.hostname.replace(/^www\./, '');
            sourceOrigin = parsed.origin;
        } catch {
            // Malformed URL: still link to it, just without host-derived labels.
        }
    }
    const isSubstack = !!sourceHost && sourceHost.endsWith('substack.com');
    const authorDisplayName = `@${r.screen_name}`;
    const authorUrl = isSubstack
        ? `https://${r.screen_name}.substack.com`
        : sourceOrigin ?? `https://x.com/${r.screen_name}`;
    const categoryHref = `/${r.category}/`;

    const encodedShareText = encodeURIComponent(
        `اكتشف "${r.title}" — مقالة رائعة وجدتها على الهلال! ${canonicalUrl}`
    );
    const encodedCanonicalUrl = encodeURIComponent(canonicalUrl);

    const whoItems = (r.whoShouldRead || '')
        .split('\n')
        .map((line) => line.replace(/^-\s*/, '').trim())
        .filter((line) => line.length > 0)
        .map((text) => ({ text }));

    const articleLd: Record<string, unknown> = {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: r.title,
        description: r.preview_text,
        mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
    };
    if (r.original_img_url) articleLd.image = r.original_img_url;
    if (r.created_at) articleLd.datePublished = r.created_at;
    articleLd.author = { '@type': 'Person', name: authorDisplayName, url: authorUrl };

    const breadcrumbLd = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'الرئيسية', item: SITE },
            { '@type': 'ListItem', position: 2, name: r.categoryTitle, item: `${SITE}${categoryHref}` },
            { '@type': 'ListItem', position: 3, name: r.title },
        ],
    };

    return {
        seoTitle: r.title,
        seoDescription: r.preview_text || r.metaDescription || '',
        canonicalUrl,
        ogImage: r.original_img_url || DEFAULT_OG_IMAGE,
        defaultOgImage: !r.original_img_url,
        twitterCreator: r.screen_name ? `@${r.screen_name}` : '@abdou_hll',
        keywordsString: (r.keywords || []).map(([kw]) => kw).join(', '),
        articleLd: jsonForScript(articleLd),
        breadcrumbLd: jsonForScript(breadcrumbLd),

        slug: r.slug,
        title: r.title,
        preview_text: r.preview_text,
        original_img_url: r.original_img_url,
        screen_name: r.screen_name,
        created_at: r.created_at,
        dateAr: r.dateAr,
        categoryHref,
        categoryTitle: r.categoryTitle,
        fallbackPath: r.category === 'all' ? '/' : categoryHref,
        authorHref: `/authors/${r.screen_name}/`,
        authorDisplayName,
        authorUrl,
        authorSubLabel: isSubstack ? 'Substack' : (sourceHost ?? 'عرض على X'),
        avatar: r.profile_image_url_https || `https://unavatar.io/twitter/${r.screen_name}`,
        readUrl,
        isSubstack,
        tag: r.tag,
        tldr: r.tldr,
        whyThisMatters: r.whyThisMatters,
        whoItems,
        hasCore: !!(r.tldr || r.whyThisMatters || r.whoShouldRead),
        keywords: (r.keywords || []).map(([label, tagSlug]) => ({
            label,
            href: tagSlug ? `/tags/${encodeURIComponent(tagSlug)}/` : '',
        })),
        xShareUrl: `https://x.com/intent/post?text=${encodedShareText}&url=${encodedCanonicalUrl}&via=${r.screen_name}`,
        linkedinShareUrl: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedCanonicalUrl}`,
        redditShareUrl: `https://www.reddit.com/submit?url=${encodedCanonicalUrl}&title=${encodedShareText}`,
        related: r.related.map(([slug, title, image, screenName]) => ({
            href: `/articles/${encodeURIComponent(slug)}/`,
            image: image || `/favicons/${slug}.png`,
            title,
            author: screenName ? `@${screenName}` : '',
        })),
    };
}

/** JSON for an inline <script>: "<" escaped so a value can't close the tag. */
function jsonForScript(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}
