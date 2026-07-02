import { useEffect, useMemo, useState } from 'react';
import Card from './Card';
import './MostRead.css';
import data from '../data/articles.json';
import type { Article, Category } from '../types';
import { VIEWS_API_BASE } from '../config/views';

interface LeaderboardEntry {
    slug: string;
    count: number;
}

interface ArticleWithCategory extends Article {
    category: string;
}

export default function MostRead() {
    // null = still loading, [] = no data (API down / leaderboard empty) — both render nothing
    const [items, setItems] = useState<LeaderboardEntry[] | null>(null);

    useEffect(() => {
        let cancelled = false;

        fetch(`${VIEWS_API_BASE}/most-read?limit=8`)
            .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
            .then((json) => {
                if (!cancelled) setItems(Array.isArray(json?.items) ? json.items : []);
            })
            .catch(() => {
                if (!cancelled) setItems([]);
            });

        return () => {
            cancelled = true;
        };
    }, []);

    const categoryTitleMap = useMemo(() => {
        const map: Record<string, string> = {};
        (data.articles as Category[]).forEach((c) => {
            map[c.category] = c.title;
        });
        return map;
    }, []);

    const articlesBySlug = useMemo(() => {
        const map = new Map<string, ArticleWithCategory>();
        (data.articles as Category[]).forEach((cat) => {
            cat.content.forEach((article) => {
                if (article.slug) map.set(article.slug, { ...article, category: cat.category });
            });
        });
        return map;
    }, []);

    const resolved = useMemo(() => {
        if (!items) return [];
        return items
            .map((entry) => articlesBySlug.get(entry.slug))
            .filter((article): article is ArticleWithCategory => Boolean(article));
    }, [items, articlesBySlug]);

    if (resolved.length === 0) return null;

    return (
        <section className="most-read-section" aria-label="الأكثر قراءة">
            <h2 className="most-read-heading">
                <span className="most-read-icon" aria-hidden="true">🔥</span>
                الأكثر قراءة
            </h2>
            <ul role="list" className="link-card-grid most-read-grid">
                {resolved.map(({ id_str, title, preview_text, screen_name, created_at, slug, category, original_img_url, url }, i) => (
                    <Card
                        key={slug}
                        rank={i + 1}
                        href={url || `https://x.com/${screen_name}/status/${id_str}`}
                        title={title}
                        body={preview_text}
                        screen_name={screen_name}
                        dateAdded={created_at}
                        slug={slug}
                        category={categoryTitleMap[category] || category}
                        image={original_img_url}
                    />
                ))}
            </ul>
        </section>
    );
}
