/**
 * The collapsed explore block shows one row of tiles. The first two (all a
 * phone fits) are above the fold, and often the page's LCP, so they skip
 * lazy-loading. The rest stay lazy: MasonryFeed.css hides covers past the
 * first row, and only lazy images are skipped while hidden. Shared by
 * ExploreTiles.astro and the Worker's listing data (src/lib/listing-page.ts).
 */
const EAGER_TILES = 2;

export function tileLoading(index: number): { loading: 'eager' | 'lazy'; priority: 'high' | 'auto' } {
    return index < EAGER_TILES ? { loading: 'eager', priority: 'high' } : { loading: 'lazy', priority: 'auto' };
}
