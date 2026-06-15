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
```

### Testing
```bash
bun run test              # Run tests in watch mode
bun run test:run          # Run tests once
```

## Architecture & Data Flow

### Source of Truth
**`src/data/articles.json`** is the single source of truth for all articles. This monolithic file contains all articles organized by category.

**NEVER edit** files in `src/data/articles/*.json` or `src/data/article-metadata/*.json` - these are auto-generated during the build process.

### Build Pipeline (prepare-data)

The build process transforms the monolithic `articles.json` into optimized per-category and per-article files:

1. **`add-slugs.ts`** - Generates URL slugs from titles and sorts articles alphabetically within categories
2. **`split-data.ts`** - Splits `articles.json` into category files in `src/data/articles/`
3. **`generate-slug-map.ts`** - Creates `slug-map.json` mapping slugs to their categories
4. **`generate-article-metadata.ts`** - Creates individual metadata files in `src/data/article-metadata/` for optimal page loads
5. **`generate-llms.ts`** - Generates `public/llms.txt` for LLM indexing

This architecture optimizes bundle size by loading only the required data per page instead of the entire dataset.

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
- **`/articles/[slug]`** - Individual article page (dynamic routes)
- **`/saved`** - Bookmarked articles (client-side)
- **`/about`**, **`/privacy`**, **`/terms`**, **`/cookies`** - Static pages

## Adding a New Article

1. Edit `src/data/articles.json` directly
2. Add to the appropriate category's `content` array
3. Article format:
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
4. Run `bun run add-slugs` to auto-generate slug and sort alphabetically
5. Run `bun run check-data` to validate before committing
6. Articles must be in alphabetical order within their category

**Note:** Slugs are auto-generated from titles. You can manually override by adding a `slug` field.

## Data Validation

Before submitting PRs, always run:
```bash
bun run check-data
```

This validates:
- URL presence and validity
- Protocol (http/https) presence
- JSON structure integrity
- Alphabetical order within categories
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
import articles from 'elhellal';              // Main articles.json
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
