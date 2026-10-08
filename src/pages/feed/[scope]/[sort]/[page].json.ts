import type { APIRoute, GetStaticPaths } from 'astro';
import { getFeeds } from '../../../../lib/feed-data';
import { FEED_PAGE_SIZE, feedPageCount, type FeedSort } from '../../../../lib/feed';

// Static feed pages: /feed/<all|category>/<newest|alpha>/<n>.json, fetched by
// MasonryFeed as the reader scrolls or searches (see src/lib/feed.ts).
export const prerender = true;

const SORTS: FeedSort[] = ['newest', 'alpha'];

export const getStaticPaths = (async () => {
    const feeds = await getFeeds();
    return [...feeds.values()].flatMap((feed) =>
        SORTS.flatMap((sort) =>
            Array.from({ length: feedPageCount(feed.newest.length) }, (_, page) => ({
                params: { scope: feed.scope, sort, page: String(page) },
                props: {
                    cards: feed[sort].slice(page * FEED_PAGE_SIZE, (page + 1) * FEED_PAGE_SIZE),
                },
            }))
        )
    );
}) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
    new Response(JSON.stringify(props.cards), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
