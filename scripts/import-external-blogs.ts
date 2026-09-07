#!/usr/bin/env bun
/**
 * Import articles from personal/independent blogs (non-Substack) into articles.json.
 * Works with any blog that exposes an RSS or Atom feed — WordPress.com blogs,
 * self-hosted WordPress, Ghost, Hugo, Jekyll, hand-rolled feeds, etc.
 * Uses Ollama (local) with gemma4:e4b for Arabic SEO summaries — same pipeline
 * as import-substack.ts, so both scripts write into the same articles.json shape.
 *
 * Feed discovery (in order):
 *   1. Tries common feed paths directly: /feed/, /feed, /rss/, /rss, /rss.xml,
 *      /atom.xml, /index.xml, /?feed=rss2
 *   2. Falls back to <link rel="alternate" type="application/rss+xml|atom+xml">
 *      autodiscovery on the blog's homepage HTML.
 *   3. You can also hardcode `feedUrl` per blog in external-blogs.ts if a site's
 *      feed lives somewhere unusual and discovery fails.
 *
 * Content extraction:
 *   - Prefers full HTML already in the feed (<content:encoded> for RSS,
 *     <content> for Atom) — this is what most WordPress/Ghost feeds give you.
 *   - If the feed item is short (a teaser/excerpt), fetches the article page
 *     directly and extracts text from <article>/<main>, falling back to
 *     <body> with nav/header/footer/script/style stripped out first.
 *   This page-scraping fallback is a best-effort heuristic, not a full
 *   readability parser — for a blog with an unusual layout, spot-check the
 *   first few imported articles' `tldr` and tune MIN_FULL_CONTENT_CHARS or
 *   add a `feedUrl` override if the extracted text looks wrong.
 *
 * Every run re-checks every blog already registered in src/data/external-blogs.ts,
 * so new posts from previously-added blogs get picked up automatically. Any URLs
 * passed on the CLI are processed too (registered in-memory for this run only —
 * add them to external-blogs.ts to have them re-checked on future runs).
 *
 * NOTE: this is unrelated to src/data/personal-blogs.ts, which defines your
 * fixed local personas (omar/layla/youssef/yacine) and their Astro content
 * collections — this script never touches that file.
 *
 * Usage:
 *   bun run scripts/import-external-blogs.ts [url] [url2] ...
 *
 * Example:
 *   bun run scripts/import-external-blogs.ts                                     # re-check all known blogs
 *   bun run scripts/import-external-blogs.ts https://alfarhan.ws                 # + a brand-new blog
 *   bun run scripts/import-external-blogs.ts https://alfarhan.ws https://fatthatmablog.wordpress.com
 *
 * Requires Ollama running locally with gemma4:e4b pulled.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ArticlesConfig, Article } from '../src/types/index.ts';
import { externalBlogs } from '../src/data/external-blogs.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ───────────────────────────────────────────────────────────────────

const MODEL                = 'gemma4:e4b';
const OLLAMA_URL           = 'http://localhost:11434/api/chat';
const OLLAMA_TIMEOUT_MS    = 120_000; // model cold-start / load can be slow — give it real headroom
const ARTICLES_PATH        = path.join(__dirname, '../src/data/articles.json');
const API_DELAY_MS         = 1500; // between Ollama summary calls
const PAGE_FETCH_DELAY_MS  = 500;  // between article-page fetches (full-content fallback)
const MIN_FULL_CONTENT_CHARS = 600; // below this, the feed content counts as an "excerpt" and we fetch the page

// ─── 50 general categories (identical to import-substack.ts so both scripts
// file articles into the same taxonomy) ───────────────────────────────────────

const CATEGORIES = [
    { slug: 'psychology',        title: 'علم النفس'                  },
    { slug: 'religion',          title: 'الدين والروحانيات'          },
    { slug: 'quran',             title: 'القرآن والتفسير'            },
    { slug: 'islamic-fiqh',      title: 'الفقه الإسلامي'             },
    { slug: 'technology',        title: 'التقنية'                    },
    { slug: 'ai',                title: 'الذكاء الاصطناعي'          },
    { slug: 'programming',       title: 'البرمجة والتطوير'           },
    { slug: 'data-science',      title: 'علم البيانات'               },
    { slug: 'cybersecurity',     title: 'الأمن الإلكتروني'          },
    { slug: 'health',            title: 'الصحة والطب'                },
    { slug: 'mental-health',     title: 'الصحة النفسية'             },
    { slug: 'nutrition',         title: 'التغذية وأسلوب الحياة'     },
    { slug: 'science',           title: 'العلوم والاكتشافات'         },
    { slug: 'space',             title: 'الفضاء والكون'             },
    { slug: 'biology',           title: 'الأحياء والطبيعة'          },
    { slug: 'history',           title: 'التاريخ'                   },
    { slug: 'philosophy',        title: 'الفلسفة'                   },
    { slug: 'sociology',         title: 'علم الاجتماع'              },
    { slug: 'politics',          title: 'السياسة والشأن العام'      },
    { slug: 'economics',         title: 'الاقتصاد والمال'           },
    { slug: 'business',          title: 'الأعمال'                   },
    { slug: 'entrepreneurship',  title: 'ريادة الأعمال'             },
    { slug: 'investing',         title: 'الاستثمار'                 },
    { slug: 'marketing',         title: 'التسويق'                   },
    { slug: 'management',        title: 'القيادة والإدارة'          },
    { slug: 'productivity',      title: 'الإنتاجية وإدارة الوقت'   },
    { slug: 'self-development',  title: 'التطوير الذاتي'            },
    { slug: 'education',         title: 'التعليم والتدريس'          },
    { slug: 'writing',           title: 'الكتابة والتحرير'          },
    { slug: 'literature',        title: 'الأدب والشعر'              },
    { slug: 'language',          title: 'اللغة واللغويات'           },
    { slug: 'media',             title: 'الإعلام والصحافة'          },
    { slug: 'social-media',      title: 'وسائل التواصل الاجتماعي'  },
    { slug: 'communication',     title: 'التواصل والعلاقات العامة'  },
    { slug: 'relationships',     title: 'العلاقات الاجتماعية'       },
    { slug: 'parenting',         title: 'التربية والأسرة'           },
    { slug: 'culture',           title: 'الثقافة والحضارة'          },
    { slug: 'art',               title: 'الفن والإبداع'             },
    { slug: 'design',            title: 'التصميم والجماليات'        },
    { slug: 'cinema',            title: 'السينما والمسلسلات'        },
    { slug: 'music',             title: 'الموسيقى والصوت'           },
    { slug: 'sports',            title: 'الرياضة'                   },
    { slug: 'travel',            title: 'السفر والسياحة'            },
    { slug: 'food',              title: 'الطعام والطهي'             },
    { slug: 'environment',       title: 'البيئة والاستدامة'         },
    { slug: 'law',               title: 'القانون والحقوق'           },
    { slug: 'biography',         title: 'السيرة الذاتية والشخصيات' },
    { slug: 'reviews',           title: 'المراجعات والنقد'          },
    { slug: 'humor',             title: 'الفكاهة والترفيه'          },
    { slug: 'general',           title: 'عام ومتنوع'                },
] as const;

type CategorySlug = typeof CATEGORIES[number]['slug'];
const CATEGORY_SLUGS = CATEGORIES.map(c => c.slug).join(', ');

// ─── CLI args ─────────────────────────────────────────────────────────────────

interface BlogJob {
    slug: string;
    name: string;
    url: string;
    feedUrl?: string;
}

function deriveSlugFromUrl(url: string): string {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host
        .replace(/\.(com|net|org|ws|io|blog)$/i, '')
        .replace(/[^a-z0-9]+/gi, '-')
        .toLowerCase();
}

/** Cleans up a pasted URL/domain into something `new URL()` can parse:
 *  - unwraps markdown link syntax, e.g. "[www.foo.com](https://www.foo.com)" -> "https://www.foo.com"
 *    (happens when a chat UI auto-links bare domains and the user copies the rendered markdown)
 *  - strips stray trailing punctuation left over from pasting a list
 *  - adds a missing "https://" scheme for bare domains like "badwi.com/blog" or "smallpages.blog"
 *  Returns null if the result still isn't a valid URL, so the caller can skip it instead of crashing. */
function normalizeUrlArg(raw: string): string | null {
    let s = raw.trim();
    const mdMatch = s.match(/\[([^\]]*)\]\(([^)]+)\)/);
    if (mdMatch) s = mdMatch[2]!.trim();
    s = s.replace(/[),.]+$/, '');
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    try {
        new URL(s); // validate
        return s;
    } catch {
        return null;
    }
}

const knownJobs: BlogJob[] = Object.values(externalBlogs).map(b => ({
    slug: b.slug,
    name: b.name,
    url: b.url,
    feedUrl: b.feedUrl,
}));

const knownUrlSet = new Set(knownJobs.map(j => j.url.replace(/\/$/, '')));

const cliJobs: BlogJob[] = [];
const seenCliUrls = new Set<string>();
const unparseableArgs: string[] = [];

for (const raw of process.argv.slice(2)) {
    const url = normalizeUrlArg(raw);
    if (!url) { unparseableArgs.push(raw); continue; }

    const key = url.replace(/\/$/, '');
    if (knownUrlSet.has(key) || seenCliUrls.has(key)) continue; // already known, or duplicate in this run
    seenCliUrls.add(key);

    const slug = deriveSlugFromUrl(url);
    cliJobs.push({ slug, name: slug, url });
}

if (unparseableArgs.length > 0) {
    console.log(`⚠️  Skipping ${unparseableArgs.length} arg(s) that aren't valid URLs even after cleanup:`);
    for (const a of unparseableArgs) console.log(`   ${a}`);
    console.log('');
}

const jobs: BlogJob[] = [...knownJobs, ...cliJobs];

if (jobs.length === 0) {
    console.error('Usage: bun run scripts/import-external-blogs.ts [url] [url2] ...');
    console.error('Example: bun run scripts/import-external-blogs.ts https://alfarhan.ws');
    console.error('(with no args, re-checks every blog already in src/data/external-blogs.ts)');
    process.exit(1);
}

console.log(
    `📚 Checking ${jobs.length} blog(s) total ` +
    `(${knownJobs.length} already known from external-blogs.ts` +
    (cliJobs.length > 0 ? `, ${cliJobs.length} new from CLI)` : ')') +
    '\n'
);

if (cliJobs.length > 0) {
    console.log('💡 New blog(s) — add these to src/data/external-blogs.ts to have them re-checked on future runs:');
    for (const j of cliJobs) {
        console.log(`   ${j.slug}: { slug: '${j.slug}', name: '${j.name}', url: '${j.url}' },`);
    }
    console.log('');
}

// Verify Ollama is reachable before starting
try {
    const ping = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
    if (!ping.ok) throw new Error(`status ${ping.status}`);
} catch (e: any) {
    console.error(`❌ Ollama not reachable at localhost:11434 — is it running? (${e.message})`);
    process.exit(1);
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function stripHtml(html: string): string {
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#x([0-9a-fA-F]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;|&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Deterministic 19-digit numeric ID from a URL (same scheme as import-substack.ts, so
 *  IDs stay consistent if an article ever gets cross-referenced between scripts) */
function urlToId(url: string): string {
    let h = 2166136261n;
    for (let i = 0; i < url.length; i++) {
        h ^= BigInt(url.charCodeAt(i));
        h = (h * 16777619n) & 0xFFFFFFFFFFFFFFFFn;
    }
    return ((h % 9000000000000000000n) + 1000000000000000000n).toString();
}

function sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

const FETCH_HEADERS = {
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/html, */*',
    'User-Agent': 'Mozilla/5.0 (compatible; elhellal/1.0)',
};

// ─── Feed discovery ───────────────────────────────────────────────────────────

const COMMON_FEED_PATHS = ['feed/', 'feed', 'rss/', 'rss', 'rss.xml', 'atom.xml', 'index.xml', '?feed=rss2'];

async function discoverFeedUrl(blogUrl: string): Promise<string | null> {
    const base = blogUrl.replace(/\/$/, '');

    // 1. Try all common feed paths concurrently — covers the vast majority of blogs,
    // and doing this in parallel matters once you're checking 100+ sites in one run.
    const attempts = COMMON_FEED_PATHS.map(async (p) => {
        const candidate = p.startsWith('?') ? `${base}/${p}` : `${base}/${p}`;
        try {
            const res = await fetch(candidate, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const text = await res.text();
                if (/<rss[\s>]|<feed[\s>]/i.test(text.slice(0, 500))) return candidate;
            }
        } catch { /* this path didn't work, others might */ }
        return null;
    });
    const found = (await Promise.all(attempts)).find(r => r !== null);
    if (found) return found;

    // 2. Fall back to <link rel="alternate" type="...+xml"> autodiscovery on the homepage.
    try {
        const res = await fetch(base, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(10000) });
        if (res.ok) {
            const html = await res.text();
            const m = html.match(/<link[^>]+type=["'](?:application\/rss\+xml|application\/atom\+xml)["'][^>]*>/i);
            if (m) {
                const hrefMatch = m[0].match(/href=["']([^"']+)["']/i);
                if (hrefMatch) {
                    const href = hrefMatch[1]!;
                    return href.startsWith('http') ? href : new URL(href, base).toString();
                }
            }
        }
    } catch { /* homepage fetch failed too */ }

    return null;
}

// ─── Feed parsing (regex-based — no XML dependency, mirrors the project's
// existing no-dependency style for the local-blog frontmatter parser) ────────

interface FeedItem {
    title: string;
    link: string;
    pubDate: string; // ISO yyyy-mm-dd
    contentHtml: string;
    image: string;
}

function decodeCdata(raw: string): string {
    const s = raw.trim();
    const m = s.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
    return m ? m[1]! : s;
}

function extractTag(block: string, tag: string): string {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
    const m = block.match(re);
    return m ? decodeCdata(m[1]!) : '';
}

function extractAttr(block: string, tag: string, attr: string, relFilter?: string): string {
    const re = new RegExp(`<${tag}\\b[^>]*/?>`, 'gi');
    const matches = block.match(re) || [];
    for (const tagStr of matches) {
        if (relFilter && !new RegExp(`rel=["']${relFilter}["']`, 'i').test(tagStr)) continue;
        const attrMatch = tagStr.match(new RegExp(`${attr}=["']([^"']+)["']`, 'i'));
        if (attrMatch) return attrMatch[1]!;
    }
    return '';
}

function parseFeed(xml: string): FeedItem[] {
    const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
    const blocks = isAtom
        ? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || []
        : xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];

    const items: FeedItem[] = [];

    for (const block of blocks) {
        const title = stripHtml(extractTag(block, 'title'));

        let link: string;
        let pubDateRaw: string;
        let contentHtml: string;

        if (isAtom) {
            link = extractAttr(block, 'link', 'href', 'alternate') || extractAttr(block, 'link', 'href');
            pubDateRaw = extractTag(block, 'published') || extractTag(block, 'updated');
            contentHtml = extractTag(block, 'content') || extractTag(block, 'summary');
        } else {
            link = extractTag(block, 'link');
            pubDateRaw = extractTag(block, 'pubDate') || extractTag(block, 'dc:date');
            contentHtml = extractTag(block, 'content:encoded') || extractTag(block, 'description');
        }

        if (!title || !link) continue; // skip malformed entries

        const enclosureUrl = extractAttr(block, 'enclosure', 'url');
        const mediaUrl = extractAttr(block, 'media:content', 'url');
        const imgMatch = contentHtml.match(/<img[^>]+src=["']([^"']+)["']/i);
        const image = enclosureUrl || mediaUrl || (imgMatch ? imgMatch[1]! : '');

        const parsedDate = pubDateRaw ? new Date(pubDateRaw) : null;
        const date = parsedDate && !isNaN(parsedDate.getTime())
            ? parsedDate.toISOString().split('T')[0]!
            : new Date().toISOString().split('T')[0]!;

        items.push({ title, link: link.trim(), pubDate: date, contentHtml, image });
    }

    return items;
}

// ─── Full-page content fallback (for feeds that only ship excerpts) ─────────

async function fetchFullArticleText(url: string): Promise<string> {
    const res = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`page ${res.status} ${res.statusText}`);
    let html = await res.text();

    // Strip obviously non-content sections first so nav/sidebar/comment text
    // doesn't leak into the extracted article text.
    html = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
        .replace(/<header[\s\S]*?<\/header>/gi, ' ')
        .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
        .replace(/<aside[\s\S]*?<\/aside>/gi, ' ');

    const articleMatch = html.match(/<article[\s\S]*?<\/article>/i);
    const mainMatch = html.match(/<main[\s\S]*?<\/main>/i);
    const bodyMatch = html.match(/<body[\s\S]*?<\/body>/i);
    const chunk = articleMatch?.[0] || mainMatch?.[0] || bodyMatch?.[0] || html;

    return stripHtml(chunk);
}

// ─── Per-blog import ──────────────────────────────────────────────────────────

interface ImportItem {
    id: string;
    title: string;
    previewText: string;
    fullContent: string;
    link: string;
    date: string;
    image: string;
}

async function getAllBlogPosts(job: BlogJob): Promise<ImportItem[]> {
    const feedUrl = job.feedUrl || await discoverFeedUrl(job.url);
    if (!feedUrl) throw new Error(`no RSS/Atom feed found at or under ${job.url}`);

    console.log(`   📡 feed: ${feedUrl}`);
    const res = await fetch(feedUrl, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`feed ${res.status} ${res.statusText}`);
    const xml = await res.text();

    const entries = parseFeed(xml);
    console.log(`   📚 ${entries.length} post(s) in feed — filling in full content now\n`);

    const items: ImportItem[] = [];
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        let fullContent = stripHtml(entry.contentHtml);
        const progress = `${i + 1}/${entries.length}`;

        if (fullContent.length < MIN_FULL_CONTENT_CHARS) {
            try {
                const pageText = await fetchFullArticleText(entry.link);
                if (pageText.length > fullContent.length) fullContent = pageText;
                console.log(`   📝 body ${progress}: fetched page (${fullContent.length} chars)`);
            } catch (e: any) {
                console.log(`   ⚠️  body ${progress}: couldn't fetch page, using feed excerpt: ${e.message}`);
            }
            await sleep(PAGE_FETCH_DELAY_MS);
        } else {
            console.log(`   📝 body ${progress}: full content from feed (${fullContent.length} chars)`);
        }

        items.push({
            id: urlToId(entry.link),
            title: entry.title,
            previewText: fullContent.slice(0, 400),
            fullContent,
            link: entry.link,
            date: entry.pubDate,
            image: entry.image,
        });
    }

    return items;
}

// ─── Ollama (local) ───────────────────────────────────────────────────────────

interface Summary {
    category: CategorySlug;
    tldr: string;
    whyThisMatters: string;
    whoShouldRead: string;
    metaDescription: string;
    keywords: string[];
}

async function generateSummary(title: string, content: string): Promise<Summary> {
    const res = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
        body: JSON.stringify({
            model: MODEL,
            stream: false,
            messages: [{
                role: 'user',
                content: `أنت محرر محتوى متخصص في تحسين محركات البحث (SEO) للمقالات العربية.

التصنيفات المتاحة — اختر الـ slug الأنسب للمقال:
${CATEGORY_SLUGS}

العنوان: ${title}
المحتوى: ${content.slice(0, 4000)}

اكتب تحليلاً احترافياً شاملاً باللغة العربية. أجب بـ JSON فقط بدون markdown أو أي نص خارجه:
{
  "category": "psychology",
  "tldr": "ملخص شامل للمقال يغطي أهم النقاط بأسلوب واضح وجذاب (180-220 حرف)",
  "whyThisMatters": "شرح معمّق لأهمية هذا المقال وما يضيفه للقارئ وتأثيره على حياته (180-220 حرف)",
  "whoShouldRead": "وصف دقيق للجمهور المستهدف وسبب اهتمامه بهذا الموضوع (120-150 حرف)",
  "metaDescription": "وصف محسّن لمحركات البحث يتضمن الكلمات المفتاحية الرئيسية ويشجع على النقر والقراءة (155-165 حرف)",
  "keywords": ["كلمة1", "كلمة2", "كلمة3", "كلمة4", "كلمة5", "كلمة6", "كلمة7"]
}`,
            }],
        }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 120)}`);
    }

    const data = await res.json() as any;
    const text = (data.message?.content || '').trim()
        .replace(/^```(?:json)?\n?/, '')
        .replace(/\n?```$/, '')
        .replace(/،/g, ','); // Arabic comma → JSON comma (model sometimes uses ، as separator)

    const parsed = JSON.parse(text) as Summary;

    if (!CATEGORIES.some(c => c.slug === parsed.category)) {
        parsed.category = 'general';
    }

    return parsed;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/** Summarizes + categorizes one item via Ollama and appends it to `data` if new. Returns true if added. */
async function processItem(
    item: ImportItem,
    label: string,
    screenName: string,
    profileImage: string,
    data: ArticlesConfig,
    allExistingIds: Set<string>,
): Promise<boolean> {
    if (allExistingIds.has(item.id)) {
        console.log(`⏭  ${label} Skip (exists): ${item.title.slice(0, 55)}`);
        return false;
    }

    process.stdout.write(`🤖 ${label} ${item.title.slice(0, 55)}\n   → `);

    let summary: Summary = {
        category: 'general',
        tldr: '', whyThisMatters: '', whoShouldRead: '',
        metaDescription: '', keywords: [],
    };
    try {
        summary = await generateSummary(item.title, item.fullContent);
        console.log(`[${summary.category}] ✅`);
    } catch (err: any) {
        console.log(`⚠️  skipped (${err.message.slice(0, 80)})`);
    }

    const catDef = CATEGORIES.find(c => c.slug === summary.category)
        ?? CATEGORIES.find(c => c.slug === 'general')!;
    let targetCat = data.articles.find(c => c.category === catDef.slug);
    if (!targetCat) {
        targetCat = { category: catDef.slug, title: catDef.title, content: [] };
        data.articles.push(targetCat);
    }

    const article: Article = {
        id_str: item.id,
        title: item.title,
        preview_text: item.previewText,
        screen_name: screenName,
        created_at: item.date,
        url: item.link,
        ...(item.image     && { original_img_url: item.image }),
        ...(profileImage   && { profile_image_url_https: profileImage }),
        ...(summary.tldr             && { tldr: summary.tldr }),
        ...(summary.whyThisMatters   && { whyThisMatters: summary.whyThisMatters }),
        ...(summary.whoShouldRead    && { whoShouldRead: summary.whoShouldRead }),
        ...(summary.metaDescription  && { metaDescription: summary.metaDescription }),
        ...(summary.keywords?.length && { keywords: summary.keywords }),
    };

    targetCat.content.push(article);
    allExistingIds.add(item.id);
    return true;
}

const SAVE_EVERY_N_ITEMS = 20;

function saveData(data: ArticlesConfig) {
    fs.writeFileSync(ARTICLES_PATH, JSON.stringify(data, null, 2));
}

async function main() {
    const data: ArticlesConfig = JSON.parse(fs.readFileSync(ARTICLES_PATH, 'utf-8'));
    const allExistingIds = new Set(data.articles.flatMap(c => c.content.map(a => a.id_str)));

    let added = 0;
    let skipped = 0;
    let failedBlogs = 0;
    let sinceLastSave = 0;

    for (const job of jobs) {
        console.log(`\n📡 [${job.slug}] ${job.url}\n`);

        let items: ImportItem[];
        try {
            items = await getAllBlogPosts(job);
        } catch (err: any) {
            console.error(`❌ [${job.slug}] ${err.message}`);
            failedBlogs++;
            continue;
        }

        console.log(items.length > 0 ? `📰 ${items.length} articles found\n` : '⚠️  No articles found.\n');

        for (let i = 0; i < items.length; i++) {
            const wasAdded = await processItem(
                items[i]!, `[${job.slug} ${i + 1}/${items.length}]`, job.slug, '', data, allExistingIds,
            );
            wasAdded ? added++ : skipped++;

            sinceLastSave++;
            if (sinceLastSave >= SAVE_EVERY_N_ITEMS) {
                saveData(data);
                sinceLastSave = 0;
                console.log(`   💾 checkpoint saved (${added} added so far)`);
            }

            if (i < items.length - 1) await sleep(API_DELAY_MS);
        }

        saveData(data);
        sinceLastSave = 0;
    }

    console.log('\n─────────────────────────────────────────');
    console.log(`✅ Added    ${added} articles`);
    console.log(`⏭  Skipped  ${skipped} duplicates`);
    if (failedBlogs > 0) console.log(`❌ Failed   ${failedBlogs} blog(s)`);
    console.log('─────────────────────────────────────────');
    console.log('\n💡 Run: bun run prepare-data\n');
}

main().catch(err => {
    console.error('\n❌', err.message);
    process.exit(1);
});