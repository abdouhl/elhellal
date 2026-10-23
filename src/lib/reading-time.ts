/**
 * Reading time of an article's original post: words / WORDS_PER_MINUTE,
 * rounded up, at least a minute. The importers set it from the full text they
 * summarise (scripts/import-substack.ts, scripts/import-external-blogs.ts);
 * scripts/backfill-reading-time.ts fills older articles from Substack's
 * post API, which reports a word count.
 *
 * Pure code: runs in bun, workerd and the browser.
 */

/** Arabic readers average ~180 words a minute on screen. */
export const WORDS_PER_MINUTE = 180;
/** "قراءة سريعة": the feed filter's and the daily stack's idea of short. */
export const SHORT_READ_MINUTES = 5;

export function minutesForWords(words: number): number | undefined {
    if (!Number.isFinite(words) || words <= 0) return undefined;
    return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

export function countWords(text: string): number {
    return text.split(/\s+/).filter(Boolean).length;
}

/** "3 دقائق", "دقيقة", "دقيقتان", "12 دقيقة" (Western digits, like the rest of the site) */
export function minutesLabel(minutes: number): string {
    if (minutes === 1) return 'دقيقة';
    if (minutes === 2) return 'دقيقتان';
    return minutes <= 10 ? `${minutes} دقائق` : `${minutes} دقيقة`;
}
