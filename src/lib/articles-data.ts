import type { ArticlesConfig } from '../types';
import { readArticles } from './articles-store';

/**
 * Build-time access to the article catalog (src/data/catalog/, see
 * ./articles-store.ts) for prerendered pages, read once per build.
 *
 * Read from disk instead of importing JSON: an import makes Vite compile the
 * whole dataset into the server bundle as a JS module, which is what ran the
 * build out of memory. Never import this from client components or the
 * Worker — it's Node-only.
 */
let cached: ArticlesConfig | undefined;

export function loadArticles(): ArticlesConfig {
    cached ??= readArticles();
    return cached;
}
