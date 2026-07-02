<div align="center">
  <img src="public/xarticles.svg" width="64" height="64" alt="الهلال logo" />

  # الهلال (Elhellal)

  **A curated directory of the best Arabic articles on the internet.**

  [![Live Site](https://img.shields.io/badge/site-elhellal.com-DarkOrange)](https://elhellal.com)
  [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.txt)
  [![Built with Astro](https://img.shields.io/badge/built%20with-Astro%205-orange)](https://astro.build)
  [![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)

</div>

---

## What is this?

[elhellal.com](https://elhellal.com) collects and curates high-quality Arabic writing — tech, business, economics, culture, science, psychology, and more — from across the internet (Substack and beyond) and organizes it into a fast, searchable, bookmarkable directory.

It started as a fork of [xarticl.es](https://xarticl.es) and has since grown into its own thing: 29 categories, 500+ articles, and counting.

## Features

- 🔍 **Full-text search** across titles, previews, categories, and tags (powered by Fuse.js)
- 🗂️ **Category browsing** with a clean, filterable navigation
- 🔖 **Bookmarks** — save articles client-side, no account needed
- ♾️ **Infinite scroll** with session-persisted scroll position
- 📱 **Fully responsive**, RTL-first Arabic layout
- ⚡ **Static-first** — per-category and per-article data splitting keeps page payloads tiny
- 🤖 **LLM-friendly** — auto-generated `llms.txt` for AI indexing
- 📦 **Published as an npm package** — the article dataset is consumable outside the site itself

## Tech stack

| | |
|---|---|
| **Framework** | [Astro 5](https://astro.build) (static output, Cloudflare adapter) |
| **UI** | [React 19](https://react.dev) for interactive islands |
| **Runtime / package manager** | [Bun](https://bun.sh) |
| **Language** | TypeScript |
| **Search** | [Fuse.js](https://fusejs.io) |
| **Testing** | [Vitest](https://vitest.dev) |
| **Deployment** | [Cloudflare Pages](https://pages.cloudflare.com) |

## Getting started

```bash
# Install dependencies
bun install

# Start the dev server (runs the data pipeline first)
bun run dev
```

The dev server runs at `http://localhost:4321` by default.

### Build & preview

```bash
bun run build      # prepares data, then builds the static site
bun run preview    # preview the production build locally
```

## Data model

`src/data/articles.json` is the **single source of truth** for every article on the site, organized by category:

```json
{
  "category": "technology",
  "title": "تقنية",
  "content": [
    {
      "id_str": "2026146182675013854",
      "title": "Article title",
      "preview_text": "Short description...",
      "original_img_url": "https://img.xarticl.es/...",
      "screen_name": "author_handle",
      "created_at": "2026-02-24"
    }
  ]
}
```

On build, a data pipeline (`bun run prepare-data`) transforms this monolithic file into optimized, per-category and per-article files so each page only loads what it needs:

```
add-slugs → split-data → generate-slug-map → generate-article-metadata → generate-llms
```

> **Never edit** `src/data/articles/*.json` or `src/data/article-metadata/*.json` directly — they're generated. Edit `src/data/articles.json` instead.

### Adding an article

1. Add an entry to the appropriate category in `src/data/articles.json`
2. Run `bun run add-slugs` to generate a slug and keep the category alphabetically sorted
3. Run `bun run check-data` to validate before committing

## Available scripts

| Command | Description |
|---|---|
| `bun run dev` | Prepare data + start the dev server |
| `bun run build` | Prepare data + build for production |
| `bun run preview` | Preview the production build |
| `bun run prepare-data` | Run the full data pipeline |
| `bun run add-slugs` | Generate slugs and sort articles alphabetically |
| `bun run check-data` | Validate data integrity |
| `bun run update-metadata` | Refresh article metadata |
| `bun run test` | Run tests in watch mode |
| `bun run test:run` | Run tests once |

## Project structure

```
src/
├── components/       # React components (Card, Dashboard, CategoryNav, ...)
├── data/             # articles.json (source of truth) + generated files
├── layouts/          # Layout.astro — shared page shell
├── pages/            # File-based routes
│   ├── index.astro
│   ├── [category].astro
│   ├── articles/[slug].astro
│   └── saved.astro
├── types/            # Shared TypeScript types
└── utils/            # Sorting, date helpers, etc.
scripts/              # Data pipeline scripts
```

## Using the dataset as an npm package

The article data is also published to npm, so you can pull the same dataset into your own project:

```bash
bun add elhellal
```

```js
import articles from 'elhellal';          // full articles.json
import metadata from 'elhellal/metadata';  // metadata map
import slugMap from 'elhellal/slug-map';   // slug → category mapping
```

## Contributing

Found a great Arabic article that deserves a spot? Contributions are welcome — open a PR against `src/data/articles.json` following the format above, or open an issue with a suggestion.

Before submitting a PR:

```bash
bun run check-data
```

## License

[MIT](LICENSE.txt)
