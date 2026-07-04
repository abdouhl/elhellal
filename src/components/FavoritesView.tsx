import { useState, useEffect } from 'react';
import { getBookmarkedArticles, type BookmarkedArticle } from '../utils/bookmarks';
import { toolComparators, type SortKey } from '../utils/sorting';
import Card from './Card';
import EmptyState, { BookmarkIcon } from './EmptyState';
import './CardsContainer.css';
import data from '../data/articles.json';
import type { Category } from '../types';

type FavoritesSortKey = Exclude<SortKey, 'random'>;

interface FavoritesViewProps {
    extraArticles?: BookmarkedArticle[];
}

export default function FavoritesView({ extraArticles = [] }: FavoritesViewProps) {
    const [bookmarkedArticles, setBookmarkedArticles] = useState<BookmarkedArticle[]>([]);
    const [sortBy, setSortBy] = useState<FavoritesSortKey>('nameAsc');

    const loadBookmarks = () => {
        const tools = getBookmarkedArticles(data.articles as Category[], extraArticles);
        setBookmarkedArticles(tools);
    };

    useEffect(() => {
        loadBookmarks();
    }, [extraArticles]);

    useEffect(() => {
        const handleBookmarkChange = () => {
            loadBookmarks();
        };

        window.addEventListener('bookmarks:changed', handleBookmarkChange);
        return () => {
            window.removeEventListener('bookmarks:changed', handleBookmarkChange);
        };
    }, []);

    const sortedTools = [...bookmarkedArticles].sort(toolComparators[sortBy]);

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

    return (
        <section>
            <div className="favorites-header">
                <div className="favorites-info">
                    <p className="nu-c-fs-small nu-u-text--secondary">
                        {bookmarkedArticles.length} {bookmarkedArticles.length === 1 ? 'مقالة محفوظة' : 'مقالات محفوظة'}
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
                {sortedTools.map(({ id_str, title, preview_text, screen_name, created_at, slug, category, original_img_url, internalHref, authorHref, authorName }, i) => (
                    <Card
                        key={`${slug}-${i}`}
                        href={internalHref || `https://x.com/${screen_name}/status/${id_str}`}
                        title={title}
                        body={preview_text}
                        screen_name={screen_name}
                        dateAdded={created_at}
                        slug={slug}
                        internalHref={internalHref}
                        category={category}
                        image={original_img_url}
                        authorHref={authorHref}
                        authorLabel={authorName}
                    />
                ))}
            </ul>
        </section>
    );
}
