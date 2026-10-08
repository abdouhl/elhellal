import { loadArticles } from './articles-data';
import { getPersonalBlogFeedArticles } from '../utils/personalBlogFeed';
import { compareAlpha, compareNewest, toFeedCard, type FeedCard } from './feed';

/**
 * Build-time feed scopes: "all" plus one per category, each in the two
 * orderings MasonryFeed pages through. Node-only (reads the article catalog and
 * content collections); the browser gets these as static JSON pages.
 */
export interface FeedScope {
    scope: string;
    newest: FeedCard[];
    alpha: FeedCard[];
}

let cached: Promise<Map<string, FeedScope>> | undefined;

async function build(): Promise<Map<string, FeedScope>> {
    const data = loadArticles();
    const personal = await getPersonalBlogFeedArticles();

    // Base order matters for ties: Array.prototype.sort is stable, and the old
    // client feed sorted [catalog order..., personal posts...].
    const all = [
        ...data.articles.flatMap((cat) => cat.content.map((a) => toFeedCard(a, cat.category))),
        ...personal.map((a) => toFeedCard(a, a.category)),
    ];

    const scopes = new Map<string, FeedCard[]>([['all', all]]);
    for (const cat of data.articles) scopes.set(cat.category, []);
    for (const card of all) scopes.get(card.category)?.push(card);

    const result = new Map<string, FeedScope>();
    for (const [scope, cards] of scopes) {
        result.set(scope, {
            scope,
            newest: [...cards].sort(compareNewest),
            alpha: [...cards].sort(compareAlpha),
        });
    }
    return result;
}

export function getFeeds(): Promise<Map<string, FeedScope>> {
    cached ??= build();
    return cached;
}

/** category key → display title, for card tags. */
export function getCategoryTitles(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const cat of loadArticles().articles) map[cat.category] = cat.title;
    return map;
}
