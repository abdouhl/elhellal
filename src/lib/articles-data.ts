import fs from 'node:fs';
import path from 'node:path';
import type { ArticlesConfig } from '../types';

/**
 * Build-time access to src/data/articles.json for prerendered pages.
 *
 * Read from disk instead of `import data from '…/articles.json'`: an import
 * makes Vite compile the whole dataset into the server bundle as a JS module,
 * which is what ran the build out of memory. Never import this from client
 * components or the Worker — it's Node-only.
 */
let cached: ArticlesConfig | undefined;

export function loadArticles(): ArticlesConfig {
    cached ??= JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'src/data/articles.json'), 'utf-8')
    ) as ArticlesConfig;
    return cached;
}
