import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ArticlesConfig, Category, Article } from '../src/types/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_SLUG_BYTES = 150; // keeps `<slug>.json` well under the 255-byte filesystem filename limit

function truncateToByteLength(str: string, maxBytes: number): string {
    let result = str;
    while (Buffer.byteLength(result, 'utf-8') > maxBytes) {
        result = result.slice(0, -1);
    }
    return result;
}

function slugify(text: string): string {
    const slug = text
        .toString()
        .replace(/[ً-ٟؐ-ؚۖ-ۜ]/g, '') // strip Arabic diacritics (tashkeel)
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^\wء-ي٠-٩-]+/g, '') // keep ASCII word chars + Arabic letters/digits + hyphens
        .replace(/--+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '');

    return truncateToByteLength(slug, MAX_SLUG_BYTES).replace(/-+$/, '');
}

const toolsPath = path.join(__dirname, '../src/data/articles.json');

try {
    // Process monolithic tools.json
    const data: ArticlesConfig = JSON.parse(fs.readFileSync(toolsPath, 'utf-8'));
    let modified = false;

    // 1. Build a set of all existing slugs to detect collisions
    const existingSlugs = new Set<string>();
    data.articles.forEach((category: Category) => {
        category.content.forEach((tool: Article) => {
            if (tool.slug) {
                existingSlugs.add(tool.slug);
            }
        });
    });

    data.articles.forEach((category: Category) => {
        // 2. Generate missing slugs with collision detection
        category.content.forEach((tool: Article) => {
            if (!tool.slug) {
                let baseSlug = slugify(tool.title);
                let uniqueSlug = baseSlug;
                let counter = 1;

                while (existingSlugs.has(uniqueSlug)) {
                    uniqueSlug = `${baseSlug}-${counter}`;
                    counter++;
                }

                tool.slug = uniqueSlug;
                existingSlugs.add(uniqueSlug);

                if (uniqueSlug !== baseSlug) {
                    console.log(`Generated unique slug for ${tool.title}: ${uniqueSlug} (collision resolved)`);
                } else {
                    console.log(`Generated slug for ${tool.title}: ${uniqueSlug}`);
                }
                modified = true;
            }
        });

        // 3. Sort tools alphabetically by title
        const originalOrder = [...category.content];
        category.content.sort((a, b) => a.title.localeCompare(b.title));

        const orderChanged = JSON.stringify(originalOrder) !== JSON.stringify(category.content);
        if (orderChanged) {
            console.log(`Sorted tools in category: ${category.category}`);
            modified = true;
        }
    });

    if (modified) {
        fs.writeFileSync(toolsPath, JSON.stringify(data, null, 2));
        console.log('✅ Updated tools.json (slugs & sorting)');
    } else {
        console.log('✅ tools.json already up to date (slugs & sorting)');
    }

} catch (error: any) {
    console.error('❌ Error processing slugs:', error.message);
}
