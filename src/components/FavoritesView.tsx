import { useState, useEffect } from 'react';
import { getBookmarkedArticles, type BookmarkedArticle } from '../utils/bookmarks';
import { toolComparators, type SortKey } from '../utils/sorting';
import Card from './Card';
import EmptyState, { BookmarkIcon } from './EmptyState';
import './CardsContainer.css';
import data from '../data/articles.json';
import type { Category } from '../types';

type FavoritesSortKey = Exclude<SortKey, 'random'>;

export default function FavoritesView() {
    const [bookmarkedArticles, setBookmarkedArticles] = useState<BookmarkedArticle[]>([]);
    const [sortBy, setSortBy] = useState<FavoritesSortKey>('nameAsc');

    const loadBookmarks = () => {
        const tools = getBookmarkedArticles(data.articles as Category[]);
        setBookmarkedArticles(tools);
    };

    useEffect(() => {
        loadBookmarks();
    }, []);

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
                    message="Start saving AI tools by clicking the bookmark icon on any tool card. Your saved tools will appear here for quick access."
                    actionText="Browse AI Tools"
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
                        {bookmarkedArticles.length} {bookmarkedArticles.length === 1 ? 'tool' : 'tools'} saved
                    </p>
                </div>

                <div className="favorites-controls">
                    <select
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value as FavoritesSortKey)}
                        className="sort-select"
                    >
                        <option value="nameAsc">Name (A-Z)</option>
                        <option value="nameDesc">Name (Z-A)</option>
                        <option value="dateNewest">Newest First</option>
                        <option value="dateOldest">Oldest First</option>
                    </select>
                </div>
            </div>

            <ul role="list" className="link-card-grid">
                {sortedTools.map(({ id_str, title, preview_text, screen_name, created_at, slug, category, original_img_url }, i) => (
                    <Card
                        key={`${slug}-${i}`}
                        href={`https://x.com/${screen_name}/status/${id_str}`}
                        title={title}
                        body={preview_text}
                        screen_name={screen_name}
                        dateAdded={created_at}
                        slug={slug}
                        category={category}
                        image={original_img_url}
                    />
                ))}
            </ul>
        </section>
    );
}
