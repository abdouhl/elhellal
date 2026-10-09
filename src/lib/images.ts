/**
 * Resized cover images. Article covers come from many hosts at full size
 * (Substack originals run 200 KB–2 MB); every page that shows one goes
 * through here so the browser only downloads what the layout displays.
 *
 * Pure code: used by the build, the site Worker and the browser.
 */

const SUBSTACK_FETCH = 'https://substackcdn.com/image/fetch/';
const SUBSTACK_YOUTUBE = 'https://substackcdn.com/image/youtube/';
const R2_BASE = 'https://img.xarticl.es';

/** Card covers: one feed column is at most ~400px wide. */
export const CARD_WIDTHS = [400, 800];
export const CARD_SIZES = '(min-width: 1400px) 25vw, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw';
/** Article page cover (the hero). */
export const HERO_WIDTHS = [400, 800, 1600];
export const HERO_SIZES = '(min-width: 769px) 760px, 100vw';
/** Related-article cards on the article page (≥220px columns). */
export const RELATED_WIDTH = 400;
/** Explore tiles are ~92px tall strips, a few hundred px wide. */
export const TILE_WIDTH = 400;

/** Some catalog entries point their "image" at a podcast or video file. */
export function isImageUrl(url: string | undefined): url is string {
    return !!url && !/\.(mp3|m4a|wav|ogg|mp4|mov|webm|pdf)(\?|$)/i.test(url);
}

function isSubstackOriginal(url: string): boolean {
    return /^https:\/\/(substack-post-media|bucketeer-[\w-]+)\.s3\.amazonaws\.com\//.test(url);
}

/** The URL of `url` scaled down to `width` px, or `url` itself when its host can't resize. */
export function resizeImage(url: string, width: number): string {
    // f_webp, not f_auto: Substack's CDN serves f_auto as JPEG/GIF whatever the browser accepts.
    const substack = `w_${width},c_limit,f_webp,q_auto:good`;
    if (url.startsWith(SUBSTACK_FETCH)) {
        // …/fetch/<transforms>/<encoded source>; the "$s_!…!" signature isn't required.
        const rest = url.slice(SUBSTACK_FETCH.length);
        const source = rest.slice(rest.indexOf('/') + 1);
        return `${SUBSTACK_FETCH}${substack}/${source}`;
    }
    if (isSubstackOriginal(url)) return `${SUBSTACK_FETCH}${substack}/${encodeURIComponent(url)}`;
    if (url.startsWith(SUBSTACK_YOUTUBE)) {
        const id = url.slice(url.lastIndexOf('/') + 1);
        return `${SUBSTACK_YOUTUBE}w_${width},c_limit/${id}`;
    }
    if (url.startsWith(`${R2_BASE}/`) && !url.startsWith(`${R2_BASE}/cdn-cgi/`)) {
        return `${R2_BASE}/cdn-cgi/image/width=${width},format=auto,quality=80${url.slice(R2_BASE.length)}`;
    }
    if (url.startsWith('https://images.unsplash.com/')) {
        try {
            const u = new URL(url.replace(/&amp;/g, '&'));
            u.searchParams.set('w', String(width));
            u.searchParams.set('q', '75');
            u.searchParams.set('auto', 'format');
            u.searchParams.delete('fm');
            return u.toString();
        } catch {
            return url;
        }
    }
    return url;
}

export interface ResponsiveImage {
    src: string;
    /** Only set when the host can resize. */
    srcset?: string | undefined;
}

/** src (the smallest width) plus a `w`-descriptor srcset for `widths`. */
export function responsiveImage(url: string, widths: number[]): ResponsiveImage {
    const src = resizeImage(url, widths[0]!);
    if (src === url) return { src };
    return { src, srcset: widths.map((w) => `${resizeImage(url, w)} ${w}w`).join(', ') };
}
