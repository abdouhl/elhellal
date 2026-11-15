---
name: elhellal-author
description: >
  Write new articles for elhellal's personal-blog authors (Omar, Layla, Youssef,
  or any future author) in that author's own voice, and scaffold brand-new authors
  into the personal-blog system (content collection, routing, category mapping,
  accent color). Use when the user says "write an article for omar/layla/youssef",
  "write as <author>", "new author", "add a writer/persona", or asks for a post in
  one of the personal blogs.
user-invokable: true
argument-hint: "[write <author> <topic> | new-author]"
license: MIT
---

# Elhellal Personal-Blog Author Skill

## Architecture recap

- Each author is an Astro content collection: `src/content/<slug>/*.md`. The
  filename (kebab-case, English) is the slug — there is no add-slugs step like
  the article catalog (`src/data/catalog/`) has.
- Authors ("personas") are defined in `src/data/personas.json`, which `src/data/personal-blogs.ts`
  loads. The first four (omar, layla, youssef, yacine) each have a collection
  `src/content/<slug>/`; personas added since share `src/content/house/`, each post
  naming its writer in `persona:` frontmatter. `src/utils/personPosts.ts`
  (`getPersonPosts`) hides the difference.
- Routing (`/articles/<slug>`), author pages (`/authors/<slug>`), and the
  homepage feed all *auto-derive* from those three files. Adding a `.md` file
  for an existing author is the entire job — no per-article registration.
- Images: `thumb`/`large` must be site-root-absolute paths — `/thumbs/<name>.png`
  — never `public/thumbs/...` (that prefix was a real bug that 404'd every
  thumbnail, fixed 2026-07-04). If no thumbnail image exists yet, omit the field
  entirely; `getPlaceholderImage()` in `src/utils/placeholderImage.ts` already
  supplies a designed fallback (`/thumbs/placeholder.png`).
- `bun run add-slugs` / `check-data` / `split-data` only touch the catalog.
  Never run them for personal-blog work.

## Command 1: write an article for an existing author

1. Identify the author and topic. If no topic is given, propose 2-3 based on
   the author's `bio`/`tagline` in `src/data/personal-blogs.ts`.
2. Read that author's 2-3 most recent posts in `src/content/<slug>/` (sort by
   `pubDate`, descending). Treat them as the real style guide — the table below
   is a starting point, not a substitute for reading actual recent output.
3. Research current stats for the topic (WebSearch/WebFetch). Prefer named
   studies, primary sources, and original reporting over SEO content-mill pages;
   favor 2025-2026 data. This site cites sources inline and by name, so vague or
   uncited claims stand out.
4. Write following the house style below, in the author's persona.
5. Save to `src/content/<slug>/<english-kebab-slug>.md` for the first four
   personas, or `src/content/house/<english-kebab-slug>.md` with `persona: <slug>`
   in the frontmatter for the others (check `collection` in `src/data/personas.json`).
6. Only set `thumb` if an actual image already exists at
   `public/thumbs/<slug>.png` (as `/thumbs/<slug>.png`). Don't invent a path to
   an image that doesn't exist — omit the field and let the placeholder handle it.

### House style (observed across all published posts — deviate only with a reason)

- **Length**: 600-700 words including headings (updated 2026-07-04 — the
  original 15 posts ran 520-590, but the user asked for articles to run longer
  and more developed going forward while keeping everything else about the
  format the same). Still a tight essay, not an SEO wall of text — the extra
  length buys 1-2 more H2 sections or deeper development of existing ones, not
  padding.
- **Structure**: cold-open paragraph (a hook stat/fact reframed into a tension
  or question) → 3-5 `##` H2 sections, no numbering, no bullet lists, no bolded
  "Key Takeaways" box, no FAQ block, no tables → closing paragraph that resolves
  back to the opening tension, usually ending on an implication or a rhetorical
  question. No CTA, no "in conclusion", no meta-commentary about the article
  itself. A user once pasted a generic 1800-3000 word SEO template (FAQ, tables,
  meta-keyword blocks) asking for it site-wide — declined, since the content
  schema has no fields for that metadata and the frontend isn't styled for
  tables/FAQ; if asked again, confirm before restructuring anything that
  drastically.
- **Title**: hook clause + colon + question, e.g. "٤٦٪ من الشيفرة يكتبها
  الذكاء الاصطناعي الآن: ماذا تغيّر فعليا في هندسة البرمجيات؟"
- **Frontmatter `description`**: exactly 2 sentences — the core stat/finding,
  then the article's angle on it.
- **Citations**: 4-6 per article, inline and embedded in the Arabic sentence
  (not footnotes), format `([Source Name](https://...), YYYY)` placed right
  after the claim it supports.
- **Register**: Modern Standard Arabic, argumentative-essay tone — direct,
  confident claims, no hedging filler, no marketing voice, no emoji.

### Per-author voice (verify against their latest posts before writing)

| Author | Domain | Voice notes |
|---|---|---|
| عمر الحربي (`omar`) | هندسة برمجيات، ذكاء اصطناعي، مصادر مفتوحة، أمن سيبراني، شركات ناشئة تقنية | Data/engineering-literal; opens with an adoption/usage stat; frames the "so what" for a working developer. |
| ليلى المنصوري (`layla`) | بيئة، استدامة، طاقة متجددة، نظم بيئية صحراوية | Field-observation framing; often opens by debunking a common misconception about climate/desert life; closes on a systemic-limits note. |
| يوسف الخطيب (`youssef`) | اقتصاد، سياسات عامة، تنمية، ريادة أعمال | Historical/structural framing; contrasts theory vs. real-world implementation; sometimes anchors on Arabic literature or history. |

If a new author was created via Command 2, use their bio/tagline the same way.

## Command 2: create a new author

Personas are data now: the admin panel (`bun run admin` → **Personas**) creates and
edits them, generates drafts headlessly and approves them. Prefer pointing the user
there. To do it by hand:

1. Ask for anything not given: Arabic full name, Latin name (caps, for byline),
   slug (English, lowercase, e.g. `sara`), tagline (2-4 words, like
   "الاقتصاد · السياسات العامة"), bio (2-3 sentences matching existing bios),
   voice notes, topics, a feed category (a thin, topically relevant one from
   `src/data/catalog/categories.json`), and an accent hex distinct from those
   already in `src/data/personas.json`.
2. Append it to `personas` in `src/data/personas.json` with
   `"collection": "house"` and `"active": true`. That is the only registration:
   routing, author pages and feeds all derive from this file.
3. Write its posts to `src/content/house/<english-kebab-slug>.md` with
   `persona: <slug>` in the frontmatter (Command 1 flow otherwise). The first four
   personas keep their own collections (`src/content/<slug>/`, no `persona:`).
4. Sanity-check with `bun run dev`; a bad Zod schema edit throws at build time.

Never touch `src/data/articles.json` or run `add-slugs`/`check-data`/
`split-data` for this workflow — it is a fully separate content system.
