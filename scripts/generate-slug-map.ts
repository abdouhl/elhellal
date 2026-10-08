import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ArticlesConfig, Category, Article, SlugMap } from '../src/types/index.ts';
import { readArticles } from '../src/lib/articles-store.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🗺️  Generating slug-to-category mapping...\n');

let data: ArticlesConfig;

try {
    data = readArticles();
} catch (error: any) {
    console.error('❌ Error reading the article catalog:', error.message);
    process.exit(1);
}

const slugMap: SlugMap = {};
let totalSlugs = 0;
const duplicates: { slug: string; categories: string[] }[] = [];

// Build slug-to-category mapping
data.articles.forEach((category: Category) => {
    category.content.forEach((article: Article) => {
        if (article.slug) {
            const slug = article.slug;
            const categoryName = category.category;

            if (!slugMap[slug]) {
                slugMap[slug] = [categoryName];
            } else if (!slugMap[slug].includes(categoryName)) {
                slugMap[slug].push(categoryName);
            }
            totalSlugs++;
        }
    });
});

// Identify duplicates from slugs mapping to multiple categories
Object.entries(slugMap).forEach(([slug, categories]) => {
    if (categories.length > 1) {
        duplicates.push({ slug, categories });
    }
});

// Write slug map
const outputPath = path.join(__dirname, '../src/data/slug-map.json');
try {
    fs.writeFileSync(outputPath, JSON.stringify(slugMap, null, 2));
    console.log(`✅ Generated slug map with ${totalSlugs} entries`);
} catch (error: any) {
    console.error(`❌ Error writing slug-map.json to ${outputPath}:`, error.message);
    process.exit(1);
}

if (duplicates.length > 0) {
    console.log(`\n⚠️  Warning: Found ${duplicates.length} duplicate slugs:`);
    duplicates.forEach(dup => {
        console.log(`   - ${dup.slug}: ${dup.categories.join(', ')}`);
    });
} else {
    console.log('✅ No duplicate slugs found');
}

console.log(`\n✅ Slug map saved to: ${outputPath}`);
