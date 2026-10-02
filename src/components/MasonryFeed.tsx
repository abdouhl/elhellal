import { useMemo, useState, useEffect, useRef } from 'react';
import Fuse from 'fuse.js';
import Card from './Card';
import AdCard from './AdCard';
import EmptyState, { SearchIcon } from './EmptyState';
import './CardsContainer.css';
import './MasonryFeed.css';
import data from '../data/articles.client.json';
import type { Category, ArticleWithCategory } from '../types';
import { toolComparators, seededShuffle } from '../utils/sorting';
import { isRecentlyAdded } from '../utils/dates';

// Imgur-style article feed: sort tabs + a masonry feed whose
// columns are filled in JS (shortest column first) so reading order stays
// right-to-left across rows instead of top-to-bottom per column.
const ITEMS_PER_PAGE = 100;
const AD_INTERVAL = 12;

// Same breakpoints as .link-card-grid.
const BREAKPOINTS: Array<[number, number]> = [[1400, 4], [1024, 3], [640, 2]];

type FeedSort = 'dateNewest' | 'random' | 'nameAsc';
const SORT_TABS: Array<{ key: FeedSort; label: string }> = [
    { key: 'dateNewest', label: 'الأحدث' },
    { key: 'random', label: 'اكتشف' },
    { key: 'nameAsc', label: 'أبجدياً' },
];

type FeedItem =
    | { type: 'card'; key: string; order: number; card: ArticleWithCategory }
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

interface MasonryFeedProps {
    /** Category to show, or 'all' */
    filter?: string;
    extraArticles?: ArticleWithCategory[];
    /** Restrict the feed to these article slugs (tag pages) */
    slugs?: string[];
    /** Use exactly these articles instead of the site-wide data (author pages) */
    articles?: ArticleWithCategory[];
}

export default function MasonryFeed({ filter = 'all', extraArticles = [], slugs, articles }: MasonryFeedProps) {
    const [sort, setSort] = useState<FeedSort>('dateNewest');
    const [seed, setSeed] = useState(42);
    const [searchQuery, setSearchQuery] = useState('');
    const [filterNew, setFilterNew] = useState(false);
    const [displayedCount, setDisplayedCount] = useState(ITEMS_PER_PAGE);
    const [isLoading, setIsLoading] = useState(false);
    const loaderRef = useRef<HTMLDivElement>(null);
    const columnCount = useColumnCount();

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

    const categoryTitleMap = useMemo(() => {
        const map: Record<string, string> = {};
        (data.articles as Category[]).forEach(c => { map[c.category] = c.title; });
        return map;
    }, []);

    const allFlatTools = useMemo((): ArticleWithCategory[] => {
        if (articles) return articles;
        const base = (data.articles as Category[]).flatMap((item) =>
            item.content.map((tool) => ({ ...tool, category: item.category }))
        );
        const all = [...base, ...extraArticles];
        if (!slugs) return all;
        const allowed = new Set(slugs);
        return all.filter((a) => a.slug && allowed.has(a.slug));
    }, [extraArticles, slugs, articles]);

    const fuse = useMemo(() => new Fuse(allFlatTools, {
        keys: ['title', 'preview_text'],
        threshold: 0.3,
        minMatchCharLength: 2,
        ignoreLocation: true,
    }), [allFlatTools]);

    const filteredCards = useMemo((): ArticleWithCategory[] => {
        const base = searchQuery.length >= 2
            ? fuse.search(searchQuery).map(r => r.item)
            : allFlatTools;
        let inCategory = base.filter(t => filter === 'all' || t.category === filter);
        if (filterNew) inCategory = inCategory.filter(t => isRecentlyAdded(t.created_at, 3));
        if (sort === 'random') return seededShuffle(inCategory, seed);
        return [...inCategory].sort(toolComparators[sort]);
    }, [filter, sort, seed, searchQuery, filterNew, fuse, allFlatTools]);

    useEffect(() => {
        setDisplayedCount(ITEMS_PER_PAGE);
    }, [filter, searchQuery, filterNew, sort, seed]);

    useEffect(() => {
        const observer = new IntersectionObserver((entries) => {
            if (entries[0]?.isIntersecting && !isLoading && displayedCount < filteredCards.length) {
                setIsLoading(true);
                setTimeout(() => {
                    setDisplayedCount(prev => Math.min(prev + ITEMS_PER_PAGE, filteredCards.length));
                    setIsLoading(false);
                }, 300);
            }
        }, { threshold: 0.1 });
        if (loaderRef.current) observer.observe(loaderRef.current);
        return () => observer.disconnect();
    }, [displayedCount, isLoading, filteredCards.length]);

    const feedItems = useMemo(() => {
        const items: FeedItem[] = [];
        const displayed = filteredCards.slice(0, displayedCount);
        displayed.forEach((card, i) => {
            items.push({ type: 'card', key: `${card.title}-${i}`, order: items.length, card });
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

    const onTabClick = (key: FeedSort) => {
        // Clicking "اكتشف" again reshuffles, like Imgur's random feed.
        if (key === 'random' && sort === 'random') setSeed(s => s + 1);
        setSort(key);
    };

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
                <span className="feed-count">{filteredCards.length} مقالة</span>
            </div>

            {filteredCards.length === 0 ? (
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
                                            href={item.card.url || `https://x.com/${item.card.screen_name}/status/${item.card.id_str}`}
                                            title={item.card.title}
                                            body={item.card.preview_text}
                                            screen_name={item.card.screen_name}
                                            dateAdded={item.card.created_at}
                                            slug={item.card.slug}
                                            internalHref={item.card.internalHref}
                                            category={categoryTitleMap[item.card.category] || item.card.category}
                                            image={item.card.original_img_url}
                                            authorHref={item.card.authorHref}
                                            authorLabel={item.card.authorName}
                                            priority={item.order < 4}
                                        />
                                    )}
                                </ul>
                            ))}
                        </div>
                    ))}
                </div>
            )}

            {displayedCount < filteredCards.length && (
                <div ref={loaderRef} className="infinite-scroll-loader">
                    {isLoading && <p className="loading-text">جارٍ تحميل المزيد...</p>}
                </div>
            )}
        </section>
    );
}
