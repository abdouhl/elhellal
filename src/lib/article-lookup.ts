import { shardOf, type ArticleShard } from './article-page';
import { toFeedCard, type FeedCard } from './feed';

/**
 * Browser-side lookup of articles by slug (bookmarks, the most-read list),
 * reading only the static shards those slugs live in (dist/_data/articles/,
 * written by scripts/build-worker-data.ts) instead of bundling every article.
 * Unknown slugs are simply missing from the result.
 */
export async function lookupCards(slugs: string[]): Promise<Map<string, FeedCard>> {
    const byShard = new Map<number, string[]>();
    for (const slug of new Set(slugs)) {
        const shard = shardOf(slug);
        byShard.set(shard, [...(byShard.get(shard) || []), slug]);
    }

    const found = new Map<string, FeedCard>();
    await Promise.all(
        [...byShard].map(async ([shard, wanted]) => {
            try {
                const res = await fetch(`/_data/articles/${shard}.json`);
                if (!res.ok) return;
                const records = (await res.json()) as ArticleShard;
                for (const slug of wanted) {
                    const record = records[slug];
                    if (record) found.set(slug, toFeedCard(record, record.category));
                }
            } catch {
                // Offline or a stale slug — leave it out.
            }
        })
    );
    return found;
}
