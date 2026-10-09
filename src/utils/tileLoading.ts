/**
 * The collapsed explore block shows one row of tiles (up to ~8 on wide
 * screens). Those covers are above the fold, and often the page's LCP, so
 * they skip lazy-loading. Shared by ExploreTiles.astro and the Worker's
 * listing data (src/lib/listing-page.ts).
 */
const EAGER_TILES = 8;
const HIGH_PRIORITY_TILES = 2;

export function tileLoading(index: number): { loading: 'eager' | 'lazy'; priority: 'high' | 'auto' } {
    return {
        loading: index < EAGER_TILES ? 'eager' : 'lazy',
        priority: index < HIGH_PRIORITY_TILES ? 'high' : 'auto',
    };
}
