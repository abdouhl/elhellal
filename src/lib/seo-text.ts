/**
 * Text helpers for <title> and meta descriptions. Pure code: runs in bun,
 * workerd and browsers.
 */

/** What Layout.astro appends to a page title. */
export const TITLE_SUFFIX = ' | الهلال';
/** Bing flags titles over 70 characters (suffix included). */
export const TITLE_MAX = 70;

/** Cuts `text` to `max` characters at a word boundary, ending in "…". */
function clampAtWord(text: string, max: number): string {
    if (text.length <= max) return text;
    const cut = text.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[،,.:;!؟?\-–—|\s]+$/, '')}…`;
}

/** Cuts a meta description to `max` characters at a word boundary. */
export function clampDescription(text: string, max = 160): string {
    return clampAtWord(text, max);
}

/** A page title short enough that "<title> | الهلال" stays within TITLE_MAX. */
export function clampTitle(title: string): string {
    return clampAtWord(title.trim(), TITLE_MAX - TITLE_SUFFIX.length);
}

const ENTITIES: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»',
    hellip: '…', mdash: '—', ndash: '–', zwnj: '‌', zwj: '‍', rlm: '', lrm: '',
};

/**
 * Plain text from an excerpt that may carry HTML (Blogger and Tumblr imports
 * store markup in preview_text). Text without tags or entities comes back as is.
 */
export function plainText(s: string | undefined | null): string {
    if (!s) return '';
    if (!/[<&]/.test(s)) return s;
    return s
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]*>?/g, ' ')
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
            if (e[0] === '#') {
                const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
                return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
            }
            return ENTITIES[e.toLowerCase()] ?? m;
        })
        .replace(/\s+/g, ' ')
        .trim();
}
