import { useMemo, useState, useEffect, useRef } from 'react';
import Fuse from 'fuse.js';
import Card from './Card';
import AdCard from './AdCard';
import EmptyState, { SearchIcon } from './EmptyState';
import './CardsContainer.css';
import data from '../data/articles.json';
import type { Category, ArticleWithCategory } from '../types';
import { toolComparators, seededShuffle, type SortKey } from '../utils/sorting';
import { isRecentlyAdded } from '../utils/dates';

// Server-rendered up front so Googlebot's static snapshot (it doesn't scroll
// to trigger the infinite-scroll loader below) sees far more real article
// links per category/tag/author hub page, not just the first screenful.
const ITEMS_PER_PAGE = 100;
// One ad slotted in per 12 articles — frequent enough to matter, sparse enough to stay out of the way.
const AD_INTERVAL = 12;

const fuseOptions = {
    keys: [
        { name: 'title', weight: 0.4 },
        { name: 'body', weight: 0.3 },
        { name: 'category', weight: 0.2 },
        { name: 'tag', weight: 0.1 }
    ],
    threshold: 0.3,
    includeScore: true,
    minMatchCharLength: 2,
    ignoreLocation: true
};

interface CardsContainerProps {
    filter: string;
    sort?: SortKey;
    randomSeed?: number;
    searchQuery?: string;
    filterNew?: boolean;
    extraArticles?: ArticleWithCategory[];
}

export default function CardsContainer({
    filter,
    sort = 'nameAsc',
    randomSeed = 0,
    searchQuery = '',
    filterNew = false,
    extraArticles = [],
}: CardsContainerProps) {
    const [displayedCount, setDisplayedCount] = useState(ITEMS_PER_PAGE);
    const [isLoading, setIsLoading] = useState(false);
    const loaderRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        try {
            const raw = sessionStorage.getItem('toolsState');
            if (raw) {
                const state = JSON.parse(raw);
                if (state && state.filter === filter) {
                    if (state.displayedCount && state.displayedCount > displayedCount) {
                        setDisplayedCount(state.displayedCount);
                    }
                    setTimeout(() => {
                        if (typeof window !== 'undefined' && typeof state.scrollY !== 'undefined') {
                            window.scrollTo(0, state.scrollY);
                        }
                    }, 50);
                }
                sessionStorage.removeItem('toolsState');
            }
        } catch (err) { }
    }, []);

    const categoryTitleMap = useMemo(() => {
        const map: Record<string, string> = {};
        (data.articles as Category[]).forEach(c => { map[c.category] = c.title; });
        return map;
    }, []);

    const allFlatTools = useMemo((): ArticleWithCategory[] => {
        const base = (data.articles as Category[]).flatMap((item) =>
            item.content.map((tool) => ({
                ...tool,
                category: item.category,
            }))
        );
        return [...base, ...extraArticles];
    }, [extraArticles]);

    const fuse = useMemo(() => {
        return new Fuse(allFlatTools, fuseOptions);
    }, [allFlatTools]);

    const filteredCards = useMemo((): ArticleWithCategory[] => {
        let base: ArticleWithCategory[];

        if (searchQuery && searchQuery.length >= 2) {
            const results = fuse.search(searchQuery);
            base = results.map(result => result.item);
            if (filter !== 'all') {
                base = base.filter(tool => tool.category === filter);
            }
        } else {
            base = allFlatTools.filter((tool) => filter === 'all' || filter === tool.category);
        }

        // Filter for new tools (added within last 30 days)
        if (filterNew) {
            base = base.filter((tool) => isRecentlyAdded(tool.created_at, 3));
        }

        if (sort === 'random') {
            // Use provided seed for deterministic shuffling, fallback to stable default
            // If truly random ordering per session is needed, pass Date.now() as randomSeed from parent
            const DEFAULT_SEED = 42;
            return seededShuffle(base, randomSeed || DEFAULT_SEED);
        } else {
            const comparator = toolComparators[sort] || toolComparators.nameAsc;
            return [...base].sort(comparator);
        }
    }, [filter, sort, randomSeed, searchQuery, filterNew, fuse, allFlatTools]);

    useEffect(() => {
        setDisplayedCount(ITEMS_PER_PAGE);
    }, [filter, searchQuery, filterNew]);

    useEffect(() => {
        const handleSaveState = () => {
            try {
                const state = {
                    filter,
                    displayedCount,
                    scrollY: typeof window !== 'undefined' ? window.scrollY || window.pageYOffset : 0,
                };
                sessionStorage.setItem('toolsState', JSON.stringify(state));
            } catch (err) { }
        };

        window.addEventListener('tools:save-state', handleSaveState);
        return () => window.removeEventListener('tools:save-state', handleSaveState);
    }, [displayedCount, filter]);

    useEffect(() => {
        const tryRestore = () => {
            try {
                const raw = sessionStorage.getItem('toolsState');
                if (!raw) return;
                const state = JSON.parse(raw);
                if (state && state.filter === filter) {
                    if (state.displayedCount && state.displayedCount > displayedCount) {
                        setDisplayedCount(state.displayedCount);
                    }
                    setTimeout(() => {
                        if (typeof window !== 'undefined' && typeof state.scrollY !== 'undefined') {
                            window.scrollTo(0, state.scrollY);
                        }
                    }, 50);
                }
                sessionStorage.removeItem('toolsState');
            } catch (err) { }
        };

        window.addEventListener('pageshow', tryRestore);
        window.addEventListener('astro:page-load', tryRestore);
        return () => {
            window.removeEventListener('pageshow', tryRestore);
            window.removeEventListener('astro:page-load', tryRestore);
        };
    }, [filter]);

    useEffect(() => {
        const observer = new IntersectionObserver(
            (entries) => {
            if (entries[0]?.isIntersecting && !isLoading && displayedCount < filteredCards.length) {
                    setIsLoading(true);
                    setTimeout(() => {
                        setDisplayedCount((prev) => Math.min(prev + ITEMS_PER_PAGE, filteredCards.length));
                        setIsLoading(false);
                    }, 300);
                }
            },
            { threshold: 0.1 }
        );

        if (loaderRef.current) {
            observer.observe(loaderRef.current);
        }

        return () => observer.disconnect();
    }, [displayedCount, isLoading, filteredCards.length]);

    const displayedCards = filteredCards.slice(0, displayedCount);

    // Intersperse an ad card every AD_INTERVAL real cards. Indices are a stable
    // prefix of displayedCards, so ad positions don't shift as infinite scroll
    // appends more items — avoids remounting (and re-initializing) earlier ads.
    const gridItems = useMemo(() => {
        const items: Array<
            | { type: 'card'; key: string; card: ArticleWithCategory }
            | { type: 'ad'; key: string }
        > = [];
        displayedCards.forEach((card, i) => {
            items.push({ type: 'card', key: `${card.title}-${i}`, card });
            if ((i + 1) % AD_INTERVAL === 0 && i !== displayedCards.length - 1) {
                items.push({ type: 'ad', key: `ad-${i}` });
            }
        });
        return items;
    }, [displayedCards]);

    // Check if searching with no results in a specific category
    const isSearchingInCategory = searchQuery && searchQuery.length >= 2 && filter !== 'all';
    const hasNoSearchResults = isSearchingInCategory && filteredCards.length === 0;

    if (hasNoSearchResults) {
        return (
            <section>
                <EmptyState
                    icon={<SearchIcon />}
                    message={`لا توجد نتائج لـ "${searchQuery}" في هذا التصنيف.`}
                    actionText="ابحث في جميع المقالات"
                    actionHref="/"
                />
            </section>
        );
    }

    return (
        <section>
            <ul role="list" className="link-card-grid">
                {gridItems.map((item) =>
                    item.type === 'ad' ? (
                        <AdCard key={item.key} />
                    ) : (
                        <Card
                            key={item.key}
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
                        />
                    )
                )}
            </ul>

            {displayedCount < filteredCards.length && (
                <div ref={loaderRef} className="infinite-scroll-loader">
                    {isLoading && (
                        <p className="loading-text">جارٍ تحميل المزيد...</p>
                    )}
                </div>
            )}
        </section>
    );
}
