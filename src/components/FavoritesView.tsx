import { useState, useEffect } from 'react';
import { getBookmarks, type BookmarkedArticle } from '../utils/bookmarks';
import Card from './Card';
import EmptyState, { BookmarkIcon } from './EmptyState';
import './CardsContainer.css';
import { lookupCards } from '../lib/article-lookup';
import { compareAlpha, compareNewest, toFeedCard, type FeedCard } from '../lib/feed';

type FavoritesSortKey = 'nameAsc' | 'nameDesc' | 'dateNewest' | 'dateOldest';

const comparators: Record<FavoritesSortKey, (a: FeedCard, b: FeedCard) => number> = {
    nameAsc: compareAlpha,
    nameDesc: (a, b) => compareAlpha(b, a),
    dateNewest: compareNewest,
    dateOldest: (a, b) => compareNewest(b, a),
};

interface FavoritesViewProps {
    extraArticles?: BookmarkedArticle[];
}

export default function FavoritesView({ extraArticles = [] }: FavoritesViewProps) {
    const [bookmarkedArticles, setBookmarkedArticles] = useState<FeedCard[] | null>(null);
    const [sortBy, setSortBy] = useState<FavoritesSortKey>('nameAsc');
    // The service worker (public/sw.js) keeps a copy of every saved article.
    const [offlineReady, setOfflineReady] = useState(false);

    useEffect(() => {
        setOfflineReady(Boolean(navigator.serviceWorker?.controller));
    }, []);

    useEffect(() => {
        let latest = 0;
        const loadBookmarks = async () => {
            const call = ++latest;
            const slugs = getBookmarks();
            // Personal-blog posts aren't in the article shards; they come in as props.
            const extra = extraArticles.filter((a) => a.slug && slugs.includes(a.slug));
            const extraSlugs = new Set(extra.map((a) => a.slug));
            const found = await lookupCards(slugs.filter((s) => !extraSlugs.has(s)));
            if (call !== latest) return;
            setBookmarkedArticles([
                ...slugs.map((s) => found.get(s)).filter((c): c is FeedCard => Boolean(c)),
                ...extra.map((a) => toFeedCard(a, a.category)),
            ]);
        };

        loadBookmarks();
        window.addEventListener('bookmarks:changed', loadBookmarks);
        return () => {
            window.removeEventListener('bookmarks:changed', loadBookmarks);
        };
    }, [extraArticles]);

    // Still reading the shards — render nothing rather than flash the empty state.
    if (bookmarkedArticles === null) return null;

    if (bookmarkedArticles.length === 0) {
        return (
            <section>
                <EmptyState
                    icon={<BookmarkIcon />}
                    message="احفظ المقالات التي تعجبك بالنقر على أيقونة الحفظ في أي بطاقة مقال. ستظهر مقالاتك المحفوظة هنا للوصول إليها بسرعة."
                    actionText="تصفح المقالات"
                    actionHref="/"
                />
            </section>
        );
    }

    const sortedTools = [...bookmarkedArticles].sort(comparators[sortBy]);

    return (
        <section>
            <div className="favorites-header">
                <div className="favorites-info">
                    <p className="nu-c-fs-small nu-u-text--secondary">
                        {bookmarkedArticles.length} {bookmarkedArticles.length === 1 ? 'مقالة محفوظة' : 'مقالات محفوظة'}
                        {offlineReady && ' · متاحة دون اتصال بالإنترنت'}
                    </p>
                </div>
                <div className="favorites-controls">
                    <select
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value as FavoritesSortKey)}
                        className="sort-select"
                    >
                        <option value="nameAsc">الاسم (أ-ي)</option>
                        <option value="nameDesc">الاسم (ي-أ)</option>
                        <option value="dateNewest">الأحدث أولاً</option>
                        <option value="dateOldest">الأقدم أولاً</option>
                    </select>
                </div>
            </div>

            <ul role="list" className="link-card-grid">
                {sortedTools.map((card, i) => (
                    <Card
                        key={`${card.slug}-${i}`}
                        href={card.internalHref || card.url || ''}
                        title={card.title}
                        body=""
                        screen_name={card.author}
                        dateAdded={card.date}
                        slug={card.slug}
                        internalHref={card.internalHref}
                        category={card.category}
                        image={card.img}
                        authorHref={card.authorHref}
                        authorLabel={card.authorName}
                    />
                ))}
            </ul>
        </section>
    );
}
