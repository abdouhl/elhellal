/**
 * Data contract between the build (scripts/build-worker-data.ts), which writes
 * dist/_data/push-digest.json, and the push Worker (workers/push/), which
 * fetches it to build each subscriber's daily or weekly notification.
 *
 * Pure code, no Node or Astro imports: it runs in both bun and workerd.
 */

import type { ArticleRecord } from './article-page';
import { isImageUrl, resizeImage } from './images';

/** How far back the digest reaches — longer than the weekly digest's window. */
export const DIGEST_DAYS = 14;
const DIGEST_MAX = 400;
/** Android shows the notification image at up to ~720px wide. */
const DIGEST_IMAGE_WIDTH = 720;
/** Notifications show two or three lines of body; the rest would be cut anyway. */
const DIGEST_PREVIEW_MAX = 140;

export interface DigestArticle {
    /** slug */
    s: string;
    /** title */
    t: string;
    /** category */
    c: string;
    /** created_at (YYYY-MM-DD) */
    d: string;
    /** resized cover image */
    i?: string;
    /** preview text, clipped to DIGEST_PREVIEW_MAX */
    p?: string;
}

export interface PushDigest {
    generatedAt: string;
    categories: Record<string, string>;
    /** Newest first. */
    articles: DigestArticle[];
}

export function buildPushDigest(
    records: Iterable<ArticleRecord>,
    categories: Record<string, string>,
    now = new Date()
): PushDigest {
    const since = new Date(now.getTime() - DIGEST_DAYS * 86_400_000).toISOString().slice(0, 10);
    const today = now.toISOString().slice(0, 10);
    const articles = [...records]
        // Future dates are typos in the data; they'd sit at the top for weeks.
        .filter((r) => r.created_at >= since && r.created_at <= today)
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.slug.localeCompare(b.slug))
        .slice(0, DIGEST_MAX)
        .map((r): DigestArticle => {
            const image = r.original_img_url && isImageUrl(r.original_img_url)
                ? resizeImage(r.original_img_url, DIGEST_IMAGE_WIDTH)
                : undefined;
            const preview = clip(r.preview_text?.replace(/\s+/g, ' ').trim() ?? '', DIGEST_PREVIEW_MAX);
            return {
                s: r.slug,
                t: r.title,
                c: r.category,
                d: r.created_at,
                ...(image ? { i: image } : {}),
                ...(preview ? { p: preview } : {}),
            };
        });
    return { generatedAt: now.toISOString(), categories, articles };
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')}…` : text;
}
