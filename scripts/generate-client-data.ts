import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ArticlesConfig, Category, Article } from '../src/types/index.ts';
import { readArticles } from '../src/lib/articles-store.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Client-hydrated React islands (MostRead, FavoritesView, CategoryNav,
 * CardsContainer) import an articles dataset directly so it gets bundled
 * into the browser JS. The article catalog also carries several SEO-only fields
 * (tldr, whyThisMatters, whoShouldRead, metaDescription, keywords) that are
 * only ever read server-side (in [slug].astro's <meta> tags) — never by any
 * client component. Those fields alone are about half its size.
 *
 * This script writes a stripped-down copy, articles.client.json, containing
 * only the fields client components actually render, so the client bundle
 * doesn't ship SEO metadata to every visitor's browser.
 */

const OUTPUT_PATH = path.join(__dirname, '../src/data/articles.client.json');

// Fields the client components (Card, MostRead, FavoritesView, CategoryNav,
// CardsContainer) actually read. Keep this in sync with those components —
// if one of them starts using a new field, add it here too.
const CLIENT_FIELDS = [
    'id_str',
    'title',
    'preview_text',
    'screen_name',
    'created_at',
    'slug',
    'url',
    'original_img_url',
    'profile_image_url_https',
    'authorName',
    'authorHref',
    'internalHref',
] as const satisfies readonly (keyof Article)[];

function pickClientFields(article: Article): Partial<Article> {
    const out: Partial<Article> = {};
    for (const key of CLIENT_FIELDS) {
        if (article[key] !== undefined) {
            (out as any)[key] = article[key];
        }
    }
    return out;
}

try {
    const data: ArticlesConfig = readArticles();

    const clientData: ArticlesConfig = {
        articles: data.articles.map((cat: Category) => ({
            category: cat.category,
            title: cat.title,
            content: cat.content.map(pickClientFields) as Article[],
        })),
    };

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(clientData));

    const outputSize = fs.statSync(OUTPUT_PATH).size;
    console.log(`✅ Generated articles.client.json: ${(outputSize / 1024 / 1024).toFixed(2)} MB`);
} catch (error: any) {
    console.error('❌ Error generating client data:', error.message);
    process.exit(1);
}
