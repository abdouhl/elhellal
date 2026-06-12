import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, basename } from "path";

interface Article {
  id_str: string;
  title: string;
  preview_text: string;
  original_img_url: string;
  screen_name: string;
  created_at?: string;
  slug: string;
}

// Resolve paths relative to project root (script lives in /scripts)
const projectRoot = join(__dirname, "..");
const articlesDir = join(projectRoot, "src", "data", "articles");
const outputPath = join(projectRoot, "public", "llms.txt");

// Read all .json files in the articles folder
const files = readdirSync(articlesDir).filter((f) => f.endsWith(".json"));

const lines: string[] = [];

// Header block
lines.push("# xarticl.es");
lines.push("");
lines.push("> A curated collection of long-form articles organized by topic.");
lines.push("");
lines.push(`> Site: https://xarticl.es`);
lines.push("");

let totalArticles = 0;

for (const file of files) {
  const category = basename(file, ".json"); // e.g. "ai-coding"
  const filePath = join(articlesDir, file);
  const articles: Article[] = JSON.parse(readFileSync(filePath, "utf-8"));

  if (!Array.isArray(articles) || articles.length === 0) continue;

  // Convert slug-case to Title Case for the heading
  const categoryTitle = category
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  lines.push(`## ${categoryTitle}`);
  lines.push("");

  for (const article of articles) {
    const url = `https://xarticl.es/${category}/${article.slug}`;

    lines.push(`- [${article.title}](${url})`);

    const meta: string[] = [];
    if (article.created_at) meta.push(`Published: ${article.created_at}`);
    if (article.screen_name) meta.push(`Author: @${article.screen_name}`);
    if (meta.length) lines.push(`  ${meta.join(" · ")}`);

    if (article.preview_text) {
      const preview = article.preview_text.replace(/\n/g, " ").trim();
      const short = preview.length > 160 ? preview.slice(0, 157) + "…" : preview;
      lines.push(`  ${short}`);
    }

    lines.push("");
    totalArticles++;
  }
}

const output = lines.join("\n");
writeFileSync(outputPath, output, "utf-8");

console.log(`✅  llms.txt written to ${outputPath}`);
console.log(`   ${files.length} categories, ${totalArticles} articles`);
