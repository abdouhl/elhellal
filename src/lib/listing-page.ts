/**
 * Data contract for tag and author pages, which the site Worker renders like
 * article pages (see src/lib/article-page.ts): scripts/build-worker-data.ts
 * writes one ListingRecord per tag / catalog author into hashed static
 * shards under dist/_data/listings/, and the Worker fills the page's shell
 * (src/pages/tags/[tag].astro or src/pages/authors/[author].astro, rendered
 * with the param = LISTING_SHELL_SLUG) from one record.
 *
 * Big feeds only carry their first LISTING_INITIAL cards here; the rest are
 * paged from dist/_data/feeds/ shards (src/lib/feed.ts).
 *
 * Pure code, no Node or Astro imports: it runs in bun, workerd and browsers.
 */

import type { TemplateData } from './shell-template';
import type { FeedCard } from './feed';
import { tileLoading } from '../utils/tileLoading';
import { fnv1a } from './hash';
import { jsonForScript } from './article-page';
import { sisterTiles, type SisterLink } from './sister-sites';

export const LISTING_SHELL_SLUG = '__shell__';

/** ~3 records per shard today (5.5k tags + 850 authors); ~20 at 100k articles. */
export const LISTING_SHARDS = 2048;

/** Cards server-rendered on a listing page (and stored in its record). */
export const LISTING_INITIAL = 30;

/** Explore tiles stored per record. */
export const LISTING_TILES = 30;

export type ListingKind = 'tag' | 'author';

/** "tag/<slug>" or "author/<screen_name>": shard key, and the feed scope of big listings. */
export function listingKey(kind: ListingKind, name: string): string {
    return `${kind}/${name}`;
}

export function listingShardOf(key: string): number {
    return fnv1a(key) % LISTING_SHARDS;
}

export interface ListingTile {
    href: string;
    label: string;
    count: number;
    image?: string | undefined;
}

interface ListingBase {
    /** Articles in the listing's feed */
    total: number;
    /** Newest first: all of them when total <= LISTING_INITIAL, else the first LISTING_INITIAL */
    cards: FeedCard[];
    tiles: ListingTile[];
}

export interface TagRecord extends ListingBase {
    kind: 'tag';
    slug: string;
    label: string;
    /** Distinct authors of the tag's articles */
    writerCount?: number;
    /** [screen_name, display name] of the authors with the most articles here */
    writers?: Array<[string, string]>;
    /** [category slug, category title] the tag's articles fall into most */
    categories?: Array<[string, string]>;
    /** Newest article's date, formatted like ArticleRecord.dateAr */
    latestDateAr?: string;
    /** Sibling-site pages about the person or book the tag names */
    sister?: SisterLink[];
}

export interface AuthorRecord extends ListingBase {
    kind: 'author';
    screen_name: string;
    displayName?: string | undefined;
    profileImage?: string | undefined;
    /** Newest article's date, formatted like ArticleRecord.dateAr */
    latestDateAr?: string | undefined;
    profileUrl: string;
    profileLinkLabel: string;
    /** [category title, article count], biggest first */
    topCategories: Array<[string, number]>;
}

export type ListingRecord = TagRecord | AuthorRecord;
export type ListingShard = Record<string, ListingRecord>;

export function listingName(r: ListingRecord): string {
    return r.kind === 'tag' ? r.slug : r.screen_name;
}

/** MasonryFeed props: the whole list inline when it's small, else paged from feed shards. */
export function listingFeedProps(r: ListingRecord, categoryTitles: Record<string, string>) {
    if (r.total <= r.cards.length) return { cards: r.cards, categoryTitles };
    return {
        scope: listingKey(r.kind, listingName(r)),
        total: r.total,
        initialCards: r.cards,
        categoryTitles,
    };
}

const SITE = 'https://elhellal.com';

function breadcrumbLd(items: Array<{ name: string; url?: string }>) {
    // Same shape as components/schema/BreadcrumbSchema.astro.
    return {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: items.map((item, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            name: item.name,
            ...(item.url && index < items.length - 1 ? { item: item.url } : {}),
        })),
    };
}

function itemListLd(r: ListingRecord, listName: string) {
    // components/schema/ItemListSchema.astro, minus descriptions (records
    // don't carry preview text) and over the server-rendered cards only.
    return {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: listName,
        numberOfItems: r.total,
        itemListElement: r.cards
            .filter((card) => card.slug)
            .map((card, index) => ({
                '@type': 'ListItem',
                position: index + 1,
                item: {
                    '@type': 'Article',
                    name: card.title,
                    url: `${SITE}/articles/${encodeURIComponent(card.slug!)}/`,
                    ...(card.date ? { datePublished: card.date } : {}),
                    ...(card.author ? { author: { '@type': 'Person', name: `@${card.author}` } } : {}),
                },
            })),
    };
}

/**
 * Everything the listing shells' {{tokens}} need, except the feed island
 * (feedProps / feedHtml), which the Worker renders. Mirrors the derivations
 * in the two .astro pages — keep them in sync.
 */
export function listingTemplateData(r: ListingRecord): TemplateData {
    const common = {
        total: r.total,
        tiles: r.tiles.map((tile, i) => ({ ...tile, ...tileLoading(i) })),
        manyTiles: r.tiles.length > 2,
    };

    if (r.kind === 'tag') {
        const writers = (r.writers ?? []).map(([screenName, name], i, all) => ({
            href: `/authors/${encodeURIComponent(screenName)}/`,
            name,
            sep: i === 0 ? '' : i === all.length - 1 ? ' و' : '، ',
        }));
        const categories = (r.categories ?? []).map(([category, title], i, all) => ({
            href: `/${category}/`,
            title,
            sep: i === 0 ? '' : i === all.length - 1 ? ' و' : '، ',
        }));
        return {
            ...common,
            label: r.label,
            articlesPhrase: articlesPhrase(r.total),
            writersPhrase: writersPhrase(r.writerCount ?? 0),
            latestDateAr: r.latestDateAr,
            writers,
            categories,
            categoriesLead: categories.length === 1 ? 'وتجد أغلبها في قسم' : 'وتجد أغلبها في أقسام',
            sister: sisterTiles(r.sister),
            canonicalUrl: `${SITE}/tags/${encodeURIComponent(r.slug)}/`,
            itemListLd: jsonForScript(itemListLd(r, `${r.label} Articles`)),
            breadcrumbLd: jsonForScript(
                breadcrumbLd([
                    { name: 'الرئيسية', url: SITE },
                    { name: 'الوسوم', url: `${SITE}/tags/` },
                    { name: r.label },
                ])
            ),
        };
    }

    const authorLabel = r.displayName || `@${r.screen_name}`;
    const canonicalUrl = `${SITE}/authors/${encodeURIComponent(r.screen_name)}/`;
    const avatar = r.profileImage || `https://unavatar.io/twitter/${r.screen_name}`;
    return {
        ...common,
        authorLabel,
        nameDir: r.displayName ? 'rtl' : 'ltr',
        canonicalUrl,
        avatar,
        latestDateAr: r.latestDateAr,
        profileUrl: r.profileUrl,
        profileLinkLabel: r.profileLinkLabel,
        topCategories: r.topCategories.map(([label, count]) => ({ label, count })),
        personLd: jsonForScript({
            '@context': 'https://schema.org',
            '@type': 'Person',
            name: authorLabel,
            url: canonicalUrl,
            image: avatar,
            sameAs: [r.profileUrl],
        }),
        itemListLd: jsonForScript(itemListLd(r, `@${r.screen_name} Articles`)),
        breadcrumbLd: jsonForScript(
            breadcrumbLd([
                { name: 'الرئيسية', url: SITE },
                { name: 'الكتّاب', url: `${SITE}/authors/` },
                { name: authorLabel },
            ])
        ),
    };
}

/** "مقالة واحدة" / "مقالتين" / "7 مقالات" / "25 مقالة" */
function articlesPhrase(count: number): string {
    if (count === 1) return 'مقالة واحدة';
    if (count === 2) return 'مقالتين';
    return count <= 10 ? `${count} مقالات` : `${count} مقالة`;
}

/** "بقلم كاتب واحد" / "بقلم كاتبَين" / "بأقلام 7 كتّاب" / "بأقلام 25 كاتبًا" */
function writersPhrase(count: number): string {
    if (count <= 0) return '';
    if (count === 1) return 'بقلم كاتب واحد';
    if (count === 2) return 'بقلم كاتبَين';
    return count <= 10 ? `بأقلام ${count} كتّاب` : `بأقلام ${count} كاتبًا`;
}
