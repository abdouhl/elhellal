/**
 * "Written on elhellal": articles whose full text lives on this site, as
 * opposed to curated links to Substack and other blogs. They are counted
 * together and shown first (for a while) in feeds.
 *
 *  - write:    a reader submitted it on /write/
 *  - persona:  a house writer drafted with AI and reviewed by an editor
 *  - personal: the original personal blogs (omar, layla, …), also AI-assisted
 *
 * Pure code: no Node or Astro imports.
 */

export type Origin = 'write' | 'persona' | 'personal' | 'substack' | 'blogs' | 'other';

export const NATIVE_ORIGINS: readonly Origin[] = ['write', 'persona', 'personal'];

export function isNative(origin: Origin | undefined): boolean {
    return !!origin && NATIVE_ORIGINS.includes(origin);
}

/** Origins written by the house team with AI help (never shown as readers). */
export function isAiAssisted(origin: Origin | undefined): boolean {
    return origin === 'persona' || origin === 'personal';
}

export const NATIVE_BADGE = 'مكتوب على الهلال';
export const HOUSE_LABEL = 'كاتب من فريق الهلال · بمساعدة الذكاء الاصطناعي';
export const HOUSE_NOTE =
    'كُتب هذا المقال بمساعدة الذكاء الاصطناعي ضمن فريق تحرير الهلال، وراجعه محرّر قبل النشر.';
export const HOUSE_AUTHOR_NOTE = 'قلم تحريري من فريق الهلال يكتب بمساعدة الذكاء الاصطناعي.';

/** Native posts newer than this sort ahead of everything in "newest" feeds. */
export const NATIVE_BOOST_DAYS = 30;

/** Arabic count phrase: "١ مقال", "٥ مقالات", "٢٠ مقالاً". */
export function articlesCountAr(n: number): string {
    if (n === 1) return 'مقال واحد';
    if (n === 2) return 'مقالان';
    if (n >= 3 && n <= 10) return `${n} مقالات`;
    return `${n} مقالاً`;
}
