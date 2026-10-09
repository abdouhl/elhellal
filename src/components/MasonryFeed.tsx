import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import Card from './Card';
import AdCard from './AdCard';
import EmptyState, { SearchIcon } from './EmptyState';
import './CardsContainer.css';
import './MasonryFeed.css';
import { seededShuffle } from '../utils/sorting';
import { isRecentlyAdded } from '../utils/dates';
import {
    compareAlpha,
    feedPageCount,
    fetchFeedPage,
    matchesQuery,
    queryTokens,
    type FeedCard,
} from '../lib/feed';

// Imgur-style article feed: sort tabs + a masonry feed whose
// columns are filled in JS (shortest column first) so reading order stays
// right-to-left across rows instead of top-to-bottom per column.
//
// Data comes in one of two ways:
//  - `cards`: the whole (small) list inline — small tag and author pages.
//  - `scope` + `total`: a big feed ("all", a category, or a big tag/author)
//    that lives in static JSON pages (see src/lib/feed.ts); only
//    `initialCards` ship with the page and the rest is fetched as the reader
//    scrolls or searches.
const ITEMS_PER_PAGE = 100;
const AD_INTERVAL = 12;
const NEW_DAYS = 3;
/** Feed files fetched at once while scanning for search matches. */
const SCAN_CONCURRENCY = 4;

// Same breakpoints as .link-card-grid.
const BREAKPOINTS: Array<[number, number]> = [[1400, 4], [1024, 3], [640, 2]];

type FeedSortTab = 'dateNewest' | 'random' | 'nameAsc';
const SORT_TABS: Array<{ key: FeedSortTab; label: string }> = [
    { key: 'dateNewest', label: 'الأحدث' },
    { key: 'random', label: 'اكتشف' },
    { key: 'nameAsc', label: 'أبجدياً' },
];

type FeedItem =
    | { type: 'card'; key: string; order: number; card: FeedCard }
    | { type: 'ad'; key: string; order: number };

// Rough card height in px, only used to pick the shortest column. Mirrors
// Card.css: 16:9 cover, title wraps ~28 chars/line, author line.
function estimateHeight(item: FeedItem): number {
    if (item.type === 'ad') return 260;
    const titleLines = Math.ceil(item.card.title.length / 28);
    return 180 + titleLines * 20 + 50;
}

function useColumnCount(): number {
    const [count, setCount] = useState(3);
    useEffect(() => {
        const update = () => {
            const match = BREAKPOINTS.find(([min]) => window.innerWidth >= min);
            setCount(match ? match[1] : 1);
        };
        update();
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
    }, []);
    return count;
}

/** A run = one combination of sort/search/filter, filled page by page. */
interface Run {
    key: string;
    items: FeedCard[];
    /** Next feed page to read */
    nextPage: number;
    done: boolean;
    loading: boolean;
}

interface MasonryFeedProps {
    /** Big feeds: which static feed to page through ("all", a category, "tag/<slug>", "author/<name>") */
    scope?: string;
    /** Big feeds: number of articles in the scope */
    total?: number;
    /** Big feeds: the first newest-first cards, rendered on the server */
    initialCards?: FeedCard[];
    /** Small feeds: every card, already newest-first */
    cards?: FeedCard[];
    /** category key → display title */
    categoryTitles: Record<string, string>;
}

export default function MasonryFeed({ scope, total = 0, initialCards = [], cards, categoryTitles }: MasonryFeedProps) {
    const [sort, setSort] = useState<FeedSortTab>('dateNewest');
    const [seed, setSeed] = useState(42);
    const [searchQuery, setSearchQuery] = useState('');
    const [filterNew, setFilterNew] = useState(false);
    // Big feeds start with just their server-rendered cards and grow on scroll.
    const [displayedCount, setDisplayedCount] = useState(
        cards === undefined && initialCards.length > 0 ? initialCards.length : ITEMS_PER_PAGE
    );
    const loaderRef = useRef<HTMLDivElement>(null);
    const columnCount = useColumnCount();
    const pageCache = useRef(new Map<string, Promise<FeedCard[]>>());

    useEffect(() => {
        const handleSearch = (e: Event) => {
            const query = (e as CustomEvent<{ query?: string }>).detail?.query;
            if (typeof query !== 'undefined') setSearchQuery(query);
        };
        // The header's 🔥 toggle (Layout.astro) — show only recently added articles.
        const handleFilterNew = (e: Event) => {
            const value = (e as CustomEvent<{ filterNew?: boolean }>).detail?.filterNew;
            if (typeof value !== 'undefined') setFilterNew(value);
        };
        window.addEventListener('tools:search', handleSearch);
        window.addEventListener('tools:filter-new', handleFilterNew);
        return () => {
            window.removeEventListener('tools:search', handleSearch);
            window.removeEventListener('tools:filter-new', handleFilterNew);
        };
    }, []);

    const inline = cards !== undefined;
    const pageCount = inline ? 1 : feedPageCount(total);
    const tokens = useMemo(() => (searchQuery.length >= 2 ? queryTokens(searchQuery) : []), [searchQuery]);
    const searching = tokens.length > 0;

    // Recently-added filtering reads newest-first so it can stop at the first
    // old card; other sorts are then applied to that (small) set.
    const order = filterNew || sort === 'dateNewest' || sort === 'random' ? 'newest' : 'alpha';
    // "اكتشف" reads newest pages in a seeded random order, each page shuffled.
    const pageOrder = useMemo(
        () => (sort === 'random' && !filterNew ? seededShuffle([...Array(pageCount).keys()], seed) : [...Array(pageCount).keys()]),
        [sort, filterNew, pageCount, seed]
    );

    const loadPage = useCallback(
        (index: number): Promise<FeedCard[]> => {
            const key = `${scope}/${order}/${index}`;
            let page = pageCache.current.get(key);
            if (!page) {
                page = fetchFeedPage(scope || 'all', order, index);
                page.catch(() => pageCache.current.delete(key));
                pageCache.current.set(key, page);
            }
            return page;
        },
        [order, scope]
    );

    const runKey = `${order}|${pageOrder.join(',')}|${tokens.join(' ')}|${filterNew}`;
    // The server-rendered first cards are page 0 of the default run, so it
    // starts pre-filled and only fetches when the reader scrolls past them.
    const initialRun = (): Run => {
        const isDefault = order === 'newest' && pageOrder[0] === 0 && !searching && !filterNew;
        if (inline) return { key: runKey, items: [], nextPage: 0, done: false, loading: false };
        return isDefault && initialCards.length > 0
            ? { key: runKey, items: initialCards, nextPage: 0, done: pageCount === 0, loading: false }
            : { key: runKey, items: [], nextPage: 0, done: false, loading: false };
    };
    const [run, setRun] = useState<Run>(initialRun);
    const current = run.key === runKey ? run : initialRun();

    const mounted = useRef(false);
    useEffect(() => {
        if (!mounted.current) {
            mounted.current = true;
            return;
        }
        setDisplayedCount(ITEMS_PER_PAGE);
    }, [runKey, seed, sort]);

    // Inline feeds are filled synchronously so the server render isn't empty.
    const inlineItems = useMemo(() => {
        if (!inline) return null;
        const base = order === 'alpha' ? [...cards].sort(compareAlpha) : cards;
        let list = base.filter((c) => matchesQuery(c, tokens));
        if (filterNew) list = list.filter((c) => isRecentlyAdded(c.date, NEW_DAYS));
        return list;
    }, [inline, cards, order, tokens, filterNew]);

    // Paged feeds: read more feed files until there are enough matches to show.
    useEffect(() => {
        if (inline || current.done || current.loading) return;
        if (current.items.length >= displayedCount) return;

        const key = current.key;
        const batch = pageOrder.slice(current.nextPage, current.nextPage + (searching ? SCAN_CONCURRENCY : 1));
        if (batch.length === 0) {
            setRun({ ...current, done: true });
            return;
        }
        setRun({ ...current, loading: true });

        Promise.all(batch.map(loadPage))
            .then((pages) => {
                setRun((prev) => {
                    if (prev.key !== key) return prev;
                    let items = prev.items;
                    let done = false;
                    pages.forEach((page, i) => {
                        let rows = page;
                        // Page 0 of the default run starts with the initial cards already shown.
                        if (prev.nextPage + i === 0 && prev.items.length > 0) rows = rows.slice(prev.items.length);
                        if (sort === 'random' && !filterNew) rows = seededShuffle(rows, seed + batch[i]!);
                        if (filterNew) {
                            const fresh = rows.filter((c) => isRecentlyAdded(c.date, NEW_DAYS));
                            // Newest-first: once a page has an old card, later pages are older still.
                            if (fresh.length < rows.length) done = true;
                            rows = fresh;
                        }
                        items = items.concat(rows.filter((c) => matchesQuery(c, tokens)));
                    });
                    const nextPage = prev.nextPage + batch.length;
                    return { key, items, nextPage, done: done || nextPage >= pageOrder.length, loading: false };
                });
            })
            .catch(() => {
                setRun((prev) => (prev.key === key ? { ...prev, done: true, loading: false } : prev));
            });
    }, [inline, current, displayedCount, pageOrder, searching, loadPage, sort, filterNew, seed, tokens]);

    const filteredCards = useMemo((): FeedCard[] => {
        const list = inlineItems ?? current.items;
        // A filtered set is small enough to sort here; plain sorts arrive in order.
        if (filterNew && sort === 'nameAsc') return [...list].sort(compareAlpha);
        if (sort === 'random' && (inline || filterNew)) return seededShuffle(list, seed);
        return list;
    }, [inlineItems, current.items, filterNew, sort, inline, seed]);

    const complete = inline || current.done;
    const hasMore = displayedCount < filteredCards.length || !complete;

    useEffect(() => {
        const observer = new IntersectionObserver((entries) => {
            if (entries[0]?.isIntersecting && hasMore && !current.loading) {
                setDisplayedCount((prev) => prev + ITEMS_PER_PAGE);
            }
        }, { rootMargin: '0px 0px 800px 0px' });
        if (loaderRef.current) observer.observe(loaderRef.current);
        return () => observer.disconnect();
    }, [hasMore, current.loading, filteredCards.length]);

    const feedItems = useMemo(() => {
        const items: FeedItem[] = [];
        const displayed = filteredCards.slice(0, displayedCount);
        displayed.forEach((card, i) => {
            items.push({ type: 'card', key: `${card.slug || card.title}-${i}`, order: items.length, card });
            if ((i + 1) % AD_INTERVAL === 0 && i !== displayed.length - 1) {
                items.push({ type: 'ad', key: `ad-${i}`, order: items.length });
            }
        });
        return items;
    }, [filteredCards, displayedCount]);

    const columns = useMemo(() => {
        const cols: FeedItem[][] = Array.from({ length: columnCount }, () => []);
        const heights = new Array(columnCount).fill(0);
        feedItems.forEach((item) => {
            const shortest = heights.indexOf(Math.min(...heights));
            cols[shortest]!.push(item);
            heights[shortest] += estimateHeight(item);
        });
        return cols;
    }, [feedItems, columnCount]);

    const onTabClick = (key: FeedSortTab) => {
        // Clicking "اكتشف" again reshuffles, like Imgur's random feed.
        if (key === 'random' && sort === 'random') setSeed(s => s + 1);
        setSort(key);
    };

    // Unfiltered big feeds know their size up front; filtered ones count what's found so far.
    const countLabel = !inline && !searching && !filterNew
        ? total
        : `${filteredCards.length}${complete ? '' : '+'}`;
    const stillLooking = !complete && filteredCards.length === 0;

    return (
        <section className="masonry-feed">
            <div className="feed-tabs" role="tablist" aria-label="ترتيب المقالات">
                {SORT_TABS.map(tab => (
                    <button
                        key={tab.key}
                        type="button"
                        role="tab"
                        aria-selected={sort === tab.key}
                        className={`feed-tab ${sort === tab.key ? 'is-active' : ''}`}
                        onClick={() => onTabClick(tab.key)}
                    >
                        {tab.label}
                    </button>
                ))}
                <span className="feed-count">{countLabel} مقالة</span>
            </div>

            {filteredCards.length === 0 && !stillLooking ? (
                <EmptyState
                    icon={<SearchIcon />}
                    message={`لا توجد نتائج لـ "${searchQuery}" في هذا التصنيف.`}
                    actionText="ابحث في جميع المقالات"
                    actionHref="/"
                />
            ) : (
                <div className="masonry">
                    {columns.map((col, c) => (
                        <div className="masonry-col" key={c}>
                            {/* Card renders its own <li>; each gets a one-item list whose
                                `order` keeps reading order when columns collapse on mobile. */}
                            {col.map(item => (
                                <ul role="list" className="masonry-cell" key={item.key} style={{ order: item.order }}>
                                    {item.type === 'ad' ? (
                                        <AdCard />
                                    ) : (
                                        <Card
                                            href={item.card.url || ''}
                                            title={item.card.title}
                                            body=""
                                            screen_name={item.card.author}
                                            dateAdded={item.card.date}
                                            slug={item.card.slug}
                                            internalHref={item.card.internalHref}
                                            category={categoryTitles[item.card.category] || item.card.category}
                                            image={item.card.img}
                                            authorHref={item.card.authorHref}
                                            authorLabel={item.card.authorName}
                                            priority={item.order === 0}
                                            eager={item.order < 4}
                                        />
                                    )}
                                </ul>
                            ))}
                        </div>
                    ))}
                </div>
            )}

            {hasMore && (
                <div ref={loaderRef} className="infinite-scroll-loader">
                    {current.loading && <p className="loading-text">جارٍ تحميل المزيد...</p>}
                </div>
            )}
        </section>
    );
}

