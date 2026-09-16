{/*export interface Tool {
    title: string;
    body: string;
    tag?: string;
    url: string;
    "date-added": string;
    slug?: string;
}

export interface Category {
    category: string;
    title: string;
    content: Tool[];
}

export interface ToolsConfig {
    tools: Category[];
}

export interface MetadataEntry {
    slug: string;
    title?: string | undefined;
    description?: string | undefined;
    ogImage?: string | undefined;
    twitterHandle?: string | undefined;
    githubUrl?: string | undefined;
}

export type MetadataMap = Record<string, MetadataEntry>;

export type SlugMap = Record<string, string[]>;*/}
export interface Article {
    title: string;
    preview_text: string;
    original_img_url?: string;
    profile_image_url_https?: string;
    id_str: string;
    screen_name: string;
    created_at: string;
    slug?: string;
    url?: string;           // direct article URL (Substack, blog, etc.)

    tldr?: string;
    whyThisMatters?: string;
    whoShouldRead?: string;
    metaDescription?: string;
    keywords?: string[];

    // Personal-blog feed entries (src/content/{omar,layla,youssef}) link straight
    // to their full article instead of /authors/{screen_name} + /articles/{slug}.
    authorName?: string;
    authorHref?: string;
    internalHref?: string;
}

export interface Category {
    category: string;
    title: string;
    content: Article[];
}

export interface ArticleWithCategory extends Article {
    category: string;
}

export interface ArticlesConfig {
    articles: Category[];
}

export interface MetadataEntry {
    slug: string;
    title?: string | undefined;
    description?: string | undefined;
    ogImage?: string | undefined;
    twitterHandle?: string | undefined;
    githubUrl?: string | undefined;
}

export type MetadataMap = Record<string, MetadataEntry>;

export type SlugMap = Record<string, string[]>;

export interface QuoteItem {
    id: string;                 // stable hash of authorSlug+cleaned text, used for dedup across scraper re-runs
    text: string;                // final Arabic text — verbatim original wording (just cleaned) if source was already Arabic, else AI-translated
    tags?: string[];              // goodreads topic tags, translated to Arabic
    likes?: number;
}

export interface QuoteBook {
    slug: string;
    title: string;             // Arabic book title
    cover?: string;             // book cover image URL
    quotes: QuoteItem[];
}

export interface QuoteAuthor {
    slug: string;               // human-readable slug generated from the Arabic name, used for /quotes/[author]
    goodreadsSlug: string;       // original Goodreads author slug (e.g. "1069006.Naval_Ravikant") — only used to re-fetch/dedupe against Goodreads, never in a URL
    name: string;                // Arabic author name
    image?: string;               // goodreads author photo URL
    quotes: QuoteItem[];          // quotes not tagged with a specific book
    books: QuoteBook[];
}

export interface QuotesConfig {
    authors: QuoteAuthor[];
}

/** Flattened view of a single quote with its author/book context inlined — used by pages/components that render one quote at a time. */
export interface FlatQuote {
    id: string;
    text: string;
    tags?: string[];
    likes?: number;
    author: string;
    authorSlug: string;
    authorImage?: string;
    book?: string;
    bookSlug?: string;
    bookCover?: string;
}
