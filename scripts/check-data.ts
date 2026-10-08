import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ArticlesConfig, Category, Article } from '../src/types/index.ts';
import { bucketFiles, bucketOf, readArticles } from '../src/lib/articles-store.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ValidationIssues {
    missing_url: string[];
    missing_protocol: string[];
    missing_ref: string[];
    missing_slug: string[];
    out_of_order: string[];
    invalid_structure: string[];
}

const issues: ValidationIssues = {
    missing_url: [],
    missing_protocol: [],
    missing_ref: [],
    missing_slug: [],
    out_of_order: [],
    invalid_structure: []
};

let totalTools = 0;
let totalSplitTools = 0;

const splitDataDir = path.join(__dirname, '../src/data/articles');

function validateTool(tool: Article, source: string) {
    const identifier = `${tool.title} (${source})`;

    if (!tool.original_img_url) {
        issues.missing_url.push(identifier);
    } else {
        if (!tool.original_img_url.startsWith('http://') && !tool.original_img_url.startsWith('https://')) {
            issues.missing_protocol.push(identifier);
        }
        try {
            const url = new URL(tool.original_img_url);
            {/*if (url.searchParams.get('ref') !== 'pbs.twimg.com') {
                issues.missing_ref.push(identifier);
            }*/}
        } catch (e) {
            // If URL is invalid, it will already be caught by protocol check or be flagged here
            issues.missing_ref.push(`${identifier} (Invalid URL)`);
        }
    }

    if (!tool.slug) {
        issues.missing_slug.push(identifier);
    }
}

try {
    // 1. Check the catalog files (src/data/catalog/): each must be an array of
    //    articles from its month, in alphabetical order.
    console.log("Checking the article catalog...");
    const data: ArticlesConfig = readArticles();
    data.articles.forEach((category: Category) => {
        for (const file of bucketFiles(category.category)) {
            const name = `${category.category}/${path.basename(file)}`;
            const content = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (!Array.isArray(content)) {
                issues.invalid_structure.push(`File: ${name} - Expected Array, got ${typeof content}`);
                continue;
            }
            let lastTool: Article | null = null;
            (content as Article[]).forEach((tool) => {
                totalTools++;
                validateTool(tool, name);
                if (`${bucketOf(tool)}.json` !== path.basename(file)) {
                    issues.invalid_structure.push(`${tool.title} (created_at ${tool.created_at}) is in the wrong file: ${name}`);
                }
                if (lastTool && tool.title.localeCompare(lastTool.title) < 0) {
                    issues.out_of_order.push(`${tool.title} (should be before ${lastTool.title}) in ${name}`);
                }
                lastTool = tool;
            });
        }
    });

    // 2. Check split files
    if (fs.existsSync(splitDataDir)) {
        console.log("Checking split category files...");
        const files = fs.readdirSync(splitDataDir).filter(f => f.endsWith('.json'));

        files.forEach(file => {
            const filePath = path.join(splitDataDir, file);
            const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

            if (!Array.isArray(content)) {
                issues.invalid_structure.push(`File: ${file} - Expected Array, got ${typeof content}`);
                return;
            }

            const tools: Article[] = content;
            let lastTool: Article | null = null;
            tools.forEach(tool => {
                totalSplitTools++;
                validateTool(tool, file);

                if (lastTool && tool.title.localeCompare(lastTool.title) < 0) {
                    issues.out_of_order.push(`${tool.title} (should be before ${lastTool.title}) in split file ${file}`);
                }
                lastTool = tool;
            });
        });
    }

    // --- Reporting ---
    console.log(`\nReport Summary:`);
    console.log(`Total tools processed: ${totalTools} (+ ${totalSplitTools} split)`);
    console.log(`Issues found: ${Object.values(issues).flat().length}`);

    if (issues.missing_url.length > 0) {
        console.log("\n❌ Missing URLs:");
        issues.missing_url.forEach(i => console.log(`   - ${i}`));
    }

    if (issues.missing_protocol.length > 0) {
        console.log("\n❌ Missing Protocol (http/https):");
        issues.missing_protocol.forEach(i => console.log(`   - ${i}`));
    }

    if (issues.missing_ref.length > 0) {
        console.log("\n❌ Missing ref parameter (?ref=riseofmachine.com):");
        issues.missing_ref.forEach(i => console.log(`   - ${i}`));
    }

    if (issues.missing_slug.length > 0) {
        console.log("\n❌ Missing Slugs:");
        issues.missing_slug.forEach(i => console.log(`   - ${i}`));
    }

    if (issues.out_of_order.length > 0) {
        console.log("\n❌ Alphabetical Order Issues:");
        issues.out_of_order.forEach(i => console.log(`   - ${i}`));
    }

    if (issues.invalid_structure.length > 0) {
        console.log("\n❌ Invalid JSON Structure:");
        issues.invalid_structure.forEach(i => console.log(`   - ${i}`));
    }


    const issueCount = Object.values(issues).flat().length;
    if (issueCount === 0) {
        console.log("\n✅ Data check passed! No issues found.");
    } else {
        process.exit(1);
    }

} catch (error: any) {
    console.error('❌ Error checking data:', error.message);
    process.exit(1);
}
