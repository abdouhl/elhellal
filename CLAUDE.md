# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an Arabic Substack articles directory built with Astro, deployed to Cloudflare. The site collects and curates the best Arabic articles from Substack, organized by category. It's forked from xarticl.es and uses Bun as the JavaScript runtime.

**Key Technologies:**
- Astro 5 (static site generator with Cloudflare adapter)
- React 19 (for interactive components)
- Bun (package manager and runtime)
- TypeScript
- Vitest (testing framework)
- Cloudflare Pages (deployment target)

## Development Commands

### Setup
```bash
bun install          # Install dependencies
```

### Development Server
```bash
bun run dev          # Runs prepare-data then starts Astro dev server
bun run start        # Alternative: just starts Astro dev server
```

### Build & Preview
```bash
bun run build        # Runs prepare-data then builds for production
bun run preview      # Preview production build locally
```

### Data Management
```bash
bun run prepare-data      # Full data pipeline (slugs → split → slug-map → metadata → llms.txt)
bun run add-slugs         # Generate slugs and sort articles alphabetically
bun run check-data        # Validate data integrity before commits
bun run update-metadata   # Update article metadata
bun run admin             # Local admin panel (localhost:4322): remove/edit/move articles, block authors, generate/remove Pinterest pins on R2, run discover-substack into an import list and the Substack/external-blog importers; Health (check-data issues per article, fixable in place), Publish (commit data paths or everything + git push to GitHub, then build & deploy with a live log), Social (x/linkedin schedulers, TikTok generators) and Stats (weekly volume, sources, top/stale authors, most-read); Sites manages the sibling repos ../elhellal-quotes, -books, -biographies, -quiz (edit quotes / book & biography entries / quiz bank rows, run their scripts, build + deploy, commit their data, read quiz player reports from D1); Leads manages the abderahmane blog's /functional-food-leads queue (scrape, skip, add by URL, "Write" opens an interactive Claude Code session in Terminal for one or many leads, edit/delete the resulting articles, deploy one article = commit that file + push main, Copy for X, Publish to X via the skill, record X links)
```

### Testing
```bash
bun run test              # Run tests in watch mode
bun run test:run          # Run tests once
```

## Architecture & Data Flow

### Source of Truth
**`src/data/catalog/`** is the single source of truth for all articles, split so no file outgrows GitHub's 100MB limit:
- `catalog/categories.json` — `[{ category, title }]` in display order
- `catalog/<category>/<YYYY-MM>.json` — that category's articles by `created_at` month, sorted by title (`undated.json` for the rest)

Always go through `readArticles()` / `writeArticles()` in `src/lib/articles-store.ts` (the old single-file `{ articles: Category[] }` shape); `loadArticles()` in `src/lib/articles-data.ts` is the cached build-time version for pages. Never `import` the data as JSON — Vite would bundle it and run the build out of memory.

**NEVER edit** files in `src/data/articles/*.json` or `src/data/article-metadata/*.json` - these are auto-generated during the build process.

### Build Pipeline (prepare-data)

The build process derives per-category and per-article files from the catalog:

1. **`add-slugs.ts`** - Generates URL slugs from titles and sorts articles alphabetically within categories
2. **`split-data.ts`** - Writes one file per category into `src/data/articles/`
3. **`generate-slug-map.ts`** - Creates `slug-map.json` mapping slugs to their categories
4. **`generate-article-metadata.ts`** - Creates individual metadata files in `src/data/article-metadata/` for optimal page loads
5. **`generate-llms.ts`** - Generates `public/llms.txt` for LLM indexing

This architecture optimizes bundle size by loading only the required data per page instead of the entire dataset.

After `astro build`, **`scripts/build-worker-data.ts`** writes the data the site Worker (`workers/site/`) renders pages from, so they don't have to be prerendered (100k+ articles would blow Cloudflare's file limits):
- `/articles/<slug>/`, `/tags/<slug>/`, `/authors/<name>/` are filled into Astro-built *shell* pages (rendered once with `{{tokens}}`, see `src/lib/shell-template.ts`) from hashed JSON shards in `dist/_data/` (`articles/`, `listings/`, `feeds/`). Data contracts: `src/lib/article-page.ts`, `src/lib/listing-page.ts`.
- Personal-blog posts and writers stay prerendered; the Worker hands names it has no data for back to the static assets.

### Data Types (src/types/index.ts)

```typescript
interface Article {
    title: string;
    preview_text: string;
    original_img_url?: string;
    profile_image_url_https?: string;
    id_str: string;           // Article/post ID
    screen_name: string;      // Author username
    created_at: string;       // YYYY-MM-DD format
    slug?: string;            // Auto-generated URL-safe identifier
    tldr?: string;
    whyThisMatters?: string;
    whoShouldRead?: string;
}

interface Category {
    category: string;         // URL-safe category identifier
    title: string;           // Display title
    content: Article[];
}
```

### Page Routes

- **`/`** - Homepage (index.astro)
- **`/[category]`** - Category listing page
- **`/articles/[slug]`**, **`/tags/[tag]`**, **`/authors/[author]`** - Article, tag and author pages (rendered by the site Worker from shells; see above)
- **`/saved`** - Bookmarked articles (client-side)
- **`/about`**, **`/privacy`**, **`/terms`**, **`/cookies`** - Static pages

## Adding a New Article

1. Add it to `src/data/catalog/<category>/<YYYY-MM>.json` (the month of its `created_at`; create the file if needed) — or, from a script, `readArticles()`, push into the category's `content`, `writeArticles()`
2. Article format:
   ```json
   {
     "id_str": "2026146182675013854",
     "title": "Your Article Title",
     "preview_text": "Brief description of the article content...",
     "original_img_url": "https://img.xarticl.es/original_img_url/image.jpg",
     "screen_name": "TwitterHandle",
     "created_at": "2026-02-24"
   }
   ```
3. Run `bun run add-slugs` to auto-generate slug and sort alphabetically
4. Run `bun run check-data` to validate before committing
5. Articles must be in alphabetical order within each file

**Note:** Slugs are auto-generated from titles. You can manually override by adding a `slug` field.

## Data Validation

Before submitting PRs, always run:
```bash
bun run check-data
```

This validates:
- URL presence and validity
- Protocol (http/https) presence
- JSON structure integrity, and each article being in its `created_at` month's file
- Alphabetical order within each catalog file
- Slug uniqueness

## Component Architecture

React components live in `src/components/` and handle:
- **Card.tsx** - Article card display
- **CardsContainer.tsx** - Grid layout with search/filter
- **CategoryNav.tsx** - Category navigation
- **BookmarkButton.tsx** - Client-side bookmarking
- **Dashboard.tsx** - Main article dashboard

Components use corresponding `.css` files for styling (not CSS modules).

## Deployment

The site deploys to Cloudflare Pages using the Cloudflare adapter. Configuration in:
- **astro.config.mjs** - Astro + Cloudflare adapter setup
- **wrangler.jsonc** - Cloudflare Workers configuration

The build outputs to `dist/` with the worker file at `dist/_worker.js/index.js`.

## NPM Package Export

This project is also published as an npm package, exposing the article data:

```javascript
import articles from 'elhellal';              // All articles
import metadata from 'elhellal/metadata';     // Metadata map
import slugMap from 'elhellal/slug-map';      // Slug-to-category mapping
```

Individual category and article metadata files are also accessible via package exports.

## Important Notes

- Use Bun commands (`bun run`) not npm/pnpm
- Always run `prepare-data` before building or development to ensure generated files are current
- The `prepare-data` script is automatically run by `dev` and `build` commands
- Article images are hosted on `img.xarticl.es`
- This site curates the best Arabic articles from Substack
