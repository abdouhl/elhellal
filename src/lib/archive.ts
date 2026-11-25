/**
 * Category archives (/<category>/archive/…): plain, prerendered lists of every
 * indexable article of a category by month. Category and listing pages only
 * render their first cards in HTML (the rest load in the browser), so without
 * these most articles had no crawlable link pointing at them and Google left
 * them "Discovered – currently not indexed".
 *
 * Month pages hold an archive's articles of one created_at month; a month with
 * more than ARCHIVE_PAGE_SIZE spills onto /<YYYY-MM>/2/, /3/… Old months never
 * change, so their URLs and contents stay stable for crawlers.
 *
 * Node-only (reads the catalog through loadArticles).
 */

import type { Article } from '../types';
import { loadArticles } from './articles-data';
import { isThinArticle } from './article-page';

export const ARCHIVE_PAGE_SIZE = 200;
export const UNDATED = 'undated';

const MONTHS_AR = [
    'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

export interface ArchiveMonth {
    /** "2026-10", or UNDATED */
    key: string;
    /** "أكتوبر 2026" */
    label: string;
    /** Newest first */
    articles: Article[];
    pages: number;
}

export interface CategoryArchive {
    category: string;
    title: string;
    /** Newest month first, UNDATED last */
    months: ArchiveMonth[];
    total: number;
}

export function monthLabel(key: string): string {
    if (key === UNDATED) return 'غير مؤرّخة';
    const [year, month] = key.split('-');
    return `${MONTHS_AR[Number(month) - 1] ?? month} ${year}`;
}

export function archiveHref(category: string, month?: string, page = 1): string {
    if (!month) return `/${category}/archive/`;
    return page > 1 ? `/${category}/archive/${month}/${page}/` : `/${category}/archive/${month}/`;
}

let cached: CategoryArchive[] | undefined;

/**
 * Every category's archive. An article whose slug already appeared earlier in
 * the catalog is skipped, as the site Worker serves the first occurrence.
 */
export function categoryArchives(): CategoryArchive[] {
    if (cached) return cached;
    const seen = new Set<string>();
    cached = loadArticles().articles.map((cat) => {
        const byMonth = new Map<string, Article[]>();
        for (const a of cat.content) {
            if (!a.slug || seen.has(a.slug)) continue;
            seen.add(a.slug);
            if (isThinArticle(a)) continue;
            const key = /^\d{4}-\d{2}/.exec(a.created_at ?? '')?.[0] ?? UNDATED;
            const list = byMonth.get(key) ?? [];
            list.push(a);
            byMonth.set(key, list);
        }
        const months = [...byMonth.entries()]
            .sort(([a], [b]) => (a === UNDATED ? 1 : b === UNDATED ? -1 : b.localeCompare(a)))
            .map(([key, list]): ArchiveMonth => {
                list.sort((x, y) => y.created_at.localeCompare(x.created_at) || x.title.localeCompare(y.title, 'ar'));
                return { key, label: monthLabel(key), articles: list, pages: Math.ceil(list.length / ARCHIVE_PAGE_SIZE) };
            });
        return {
            category: cat.category,
            title: cat.title || cat.category,
            months,
            total: months.reduce((n, m) => n + m.articles.length, 0),
        };
    });
    return cached;
}
