import { useEffect, useState } from 'react';
import Card from './Card';
import './MostRead.css';
import { VIEWS_API_BASE } from '../config/views';
import { lookupCards } from '../lib/article-lookup';
import type { FeedCard } from '../lib/feed';

interface LeaderboardEntry {
    slug: string;
    count: number;
}

interface MostReadProps {
    /** category key → display title */
    categoryTitles: Record<string, string>;
}

export default function MostRead({ categoryTitles }: MostReadProps) {
    // Empty while loading and when there's no data (API down / leaderboard empty) — both render nothing
    const [resolved, setResolved] = useState<FeedCard[]>([]);

    useEffect(() => {
        let cancelled = false;
        fetch(`${VIEWS_API_BASE}/most-read?limit=8`)
            .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
            .then(async (json) => {
                const items: LeaderboardEntry[] = Array.isArray(json?.items) ? json.items : [];
                const cards = await lookupCards(items.map((entry) => entry.slug));
                if (!cancelled) {
                    setResolved(items.map((entry) => cards.get(entry.slug)).filter((c): c is FeedCard => Boolean(c)));
                }
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, []);

    if (resolved.length === 0) return null;

    return (
        <section className="most-read-section" aria-label="الأكثر قراءة">
            <h2 className="most-read-heading">
                <span className="most-read-icon" aria-hidden="true">🔥</span>
                الأكثر قراءة
            </h2>
            <ul role="list" className="link-card-grid most-read-grid">
                {resolved.map((card, i) => (
                    <Card
                        key={card.slug}
                        rank={i + 1}
                        href={card.url || ''}
                        title={card.title}
                        body=""
                        screen_name={card.author}
                        dateAdded={card.date}
                        slug={card.slug}
                        category={categoryTitles[card.category] || card.category}
                        image={card.img}
                    />
                ))}
            </ul>
        </section>
    );
}
