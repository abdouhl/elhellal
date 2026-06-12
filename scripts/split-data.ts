import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ArticlesConfig, Category } from '../src/types/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🚀 Starting data split process...\n');

// Path to the monolithic tools.json
const toolsPath = path.join(__dirname, '../src/data/articles.json');
const outputDir = path.join(__dirname, '../src/data/articles');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`📁 Created directory: ${outputDir}`);
}

try {
    const rawData = fs.readFileSync(toolsPath, 'utf-8');
    const data: ArticlesConfig = JSON.parse(rawData);

    if (!data.articles || !Array.isArray(data.articles)) {
        throw new Error('Invalid articles.json structure');
    }

    let categoryCount = 0;
    let toolCount = 0;

    data.articles.forEach((cat: Category) => {
        const categoryName = cat.category.toLowerCase().replace(/\s+/g, '-');
        const outputPath = path.join(outputDir, `${categoryName}.json`);

        // Write each category to its own file
        fs.writeFileSync(outputPath, JSON.stringify(cat.content, null, 2));

        categoryCount++;
        toolCount += cat.content.length;
        console.log(`✅ Processed "${cat.category}" -> ${categoryName}.json (${cat.content.length} tools)`);
    });

    console.log(`\n✨ Successfully split ${toolCount} tools into ${categoryCount} category files.`);

} catch (error: any) {
    console.error('❌ Error splitting data:', error.message);
    process.exit(1);
}
