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
  tldr?: string;
  whyThisMatters?: string;
}

/**
 * Cloudflare rejects assets over 25 MiB, and the full catalog outgrew that.
 * Links keep their Arabic slugs readable (percent-encoding triples their
 * size), thin articles (noindex, see isThinArticle) are left out, and past
 * PREVIEW_BUDGET the previews are dropped so the file always deploys.
 */
const MAX_BYTES = 24 * 1024 * 1024;
const PREVIEW_BUDGET = 20 * 1024 * 1024;

function articleUrl(slug: string): string {
  // Only what would break a markdown link or a URL gets encoded.
  return `https://elhellal.com/articles/${slug.replace(/[\s()<>%\[\]]/g, (c) => encodeURIComponent(c))}/`;
}

// Resolve paths relative to project root (script lives in /scripts)
const projectRoot = join(__dirname, "..");
const articlesDir = join(projectRoot, "src", "data", "articles");
const outputPath = join(projectRoot, "public", "llms.txt");

// Read all .json files in the articles folder
const files = readdirSync(articlesDir).filter((f) => f.endsWith(".json"));

const lines: string[] = [];

// Header block
lines.push("# الهلال (elhellal.com)");
lines.push("");
lines.push("> A curated collection of the best Arabic Substack articles, organized by topic.");
lines.push("");
lines.push(`> Site: https://elhellal.com`);
lines.push("");

let totalArticles = 0;
let bytes = 0;
let previewsDropped = 0;
const push = (line: string) => {
  lines.push(line);
  bytes += Buffer.byteLength(line, "utf-8") + 1;
};

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

  push(`## ${categoryTitle}`);
  push("");

  for (const article of articles) {
    if (!article.slug || (!article.tldr && !article.whyThisMatters)) continue;
    push(`- [${article.title.replace(/[\[\]]/g, "")}](${articleUrl(article.slug)})`);

    const meta: string[] = [];
    if (article.created_at) meta.push(`Published: ${article.created_at}`);
    if (article.screen_name) meta.push(`Author: @${article.screen_name}`);
    if (meta.length) push(`  ${meta.join(" · ")}`);

    if (article.preview_text && bytes < PREVIEW_BUDGET) {
      const preview = article.preview_text.replace(/\n/g, " ").trim();
      const short = preview.length > 160 ? preview.slice(0, 157) + "…" : preview;
      push(`  ${short}`);
    } else if (article.preview_text) {
      previewsDropped++;
    }

    push("");
    totalArticles++;
  }
}

const output = lines.join("\n");
if (Buffer.byteLength(output, "utf-8") > MAX_BYTES) {
  throw new Error(`llms.txt is ${(Buffer.byteLength(output, "utf-8") / 1048576).toFixed(1)} MiB, over the ${MAX_BYTES / 1048576} MiB limit`);
}
writeFileSync(outputPath, output, "utf-8");

console.log(`✅  llms.txt written to ${outputPath}`);
console.log(
  `   ${files.length} categories, ${totalArticles} articles, ${(Buffer.byteLength(output, "utf-8") / 1048576).toFixed(1)} MiB` +
    (previewsDropped ? ` (${previewsDropped} previews dropped to fit)` : "")
);
