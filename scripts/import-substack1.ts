#!/usr/bin/env bun
/**
 * Import articles from a Substack author's full archive into articles.json.
 * Uses Ollama (local) with gemma4:e4b for Arabic SEO summaries.
 * The AI automatically picks the best category for each article.
 *
 * Uses Substack's paginated /api/v1/archive endpoint (not /feed, which caps
 * at ~20 items) to discover every post, then fetches each free post's full
 * body via /api/v1/posts/{slug} instead of relying on the RSS preview text.
 *
 * Every run also re-checks the archive of every author already present
 * in articles.json (their screen_name is their Substack username), so new
 * posts from previously-imported authors get picked up automatically. Any
 * usernames passed on the CLI are merged into that set.
 *
 * Usage:
 *   bun run scripts/import-substack.ts [username] [username2] ...
 *
 * Example:
 *   bun run scripts/import-substack.ts                     # re-check all known authors
 *   bun run scripts/import-substack.ts 99iov                # + a brand-new author
 *   bun run scripts/import-substack.ts 99iov sabahlal        # + several new authors
 *
 * Requires Ollama running locally with gemma4:e4b pulled.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ArticlesConfig, Article } from '../src/types/index.ts';
import { personalBlogs } from '../src/data/personal-blogs.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ───────────────────────────────────────────────────────────────────

const MODEL     = 'gemma4:e4b';
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const ARTICLES_PATH = path.join(__dirname, '../src/data/articles.json');
const API_DELAY_MS  = 1500;
const ARCHIVE_PAGE_DELAY_MS = 500;
const POST_FETCH_DELAY_MS   = 500;

// Personal blog (abderahmane.com) — Arabic posts get pulled in on every run
const LOCAL_BLOG_DIR        = '/Users/abdou/Desktop/websites/abderahmane/src/content/article';
const LOCAL_BLOG_SITE_URL   = 'https://abderahmane.elhellal.com';
const LOCAL_BLOG_SCREEN_NAME = 'abdou_hll';

// ─── 50 general categories ────────────────────────────────────────────────────

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

// screen_name values in articles.json that are NOT Substack usernames (skip these
// when re-checking existing authors' archives)
const NON_SUBSTACK_SCREEN_NAMES = new Set([
    LOCAL_BLOG_SCREEN_NAME,
    ...Object.values(personalBlogs).map(p => p.slug),
]);

function getExistingSubstackAuthors(): string[] {
    const data: ArticlesConfig = JSON.parse(fs.readFileSync(ARTICLES_PATH, 'utf-8'));
    const screenNames = new Set(
        data.articles.flatMap(c => c.content.map(a => a.screen_name))
    );
    return [...screenNames].filter(name => name && !NON_SUBSTACK_SCREEN_NAMES.has(name));
}

const cliUsers = process.argv.slice(2);
const existingAuthors = getExistingSubstackAuthors();
const substackUsers: string[] = [...new Set([...cliUsers, ...existingAuthors])];

if (substackUsers.length === 0) {
    console.error('Usage: bun run scripts/import-substack.ts [username] [username2] ...');
    console.error('Example: bun run scripts/import-substack.ts 99iov sabahlal');
    console.error('(with no args, re-checks every author already in articles.json)');
    process.exit(1);
}

console.log(
    `👥 Checking ${substackUsers.length} author(s) total ` +
    `(${existingAuthors.length} already known from articles.json` +
    (cliUsers.length > 0 ? `, ${cliUsers.length} passed on the CLI)` : ')') +
    '\n'
);

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

/** Deterministic 19-digit numeric ID from a URL */
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
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; elhellal/1.0)',
};

// ─── Substack archive + full post fetching ───────────────────────────────────

interface ArchiveEntry {
    id: number;
    slug: string;
    title: string;
    subtitle: string;
    description: string;
    canonical_url: string;
    post_date: string;
    cover_image: string;
    type: 'newsletter' | 'podcast' | 'thread';
    audience: 'everyone' | 'only_paid' | 'founding';
}

interface ImportItem {
    id: string;
    title: string;
    previewText: string;
    fullContent: string;
    link: string;
    date: string;
    image: string;
}

/** Paginates https://{user}.substack.com/api/v1/archive until an empty page comes back */
async function fetchArchive(substackUser: string): Promise<ArchiveEntry[]> {
    const base = `https://${substackUser}.substack.com`;
    const all: ArchiveEntry[] = [];
    let offset = 0;
    const limit = 12; // larger limits return inconsistent counts from Substack

    const seenSlugs = new Set<string>();
    let page = 0;
    const MAX_PAGES = 500; // safety cap — 500 * 12 = 6000 posts, far past any realistic archive

    while (true) {
        page++;
        if (page > MAX_PAGES) {
            console.log(`   ⚠️  hit ${MAX_PAGES}-page safety cap, stopping pagination early`);
            break;
        }

        let res: Response;
        try {
            res = await fetch(
                `${base}/api/v1/archive?sort=new&offset=${offset}&limit=${limit}`,
                { headers: FETCH_HEADERS, signal: AbortSignal.timeout(15000) },
            );
        } catch (e: any) {
            throw new Error(`archive fetch failed at offset ${offset}: ${e.message}`);
        }
        if (!res.ok) throw new Error(`archive ${res.status} ${res.statusText}`);
        const entries = await res.json() as ArchiveEntry[];
        if (entries.length === 0) break;

        // Some publications don't honor `offset` correctly and just repeat the
        // last page forever — bail if every slug in this page has already been seen.
        const newEntries = entries.filter(e => !seenSlugs.has(e.slug));
        if (newEntries.length === 0) {
            console.log(`   ⚠️  page repeated with no new posts, stopping pagination`);
            break;
        }
        for (const e of newEntries) seenSlugs.add(e.slug);

        all.push(...newEntries);
        console.log(`   📄 page ${page}: offset=${offset} got=${entries.length} (${all.length} total so far)`);

        offset += entries.length;
        await sleep(ARCHIVE_PAGE_DELAY_MS);
    }

    return all.filter(p => p.type === 'newsletter');
}

/** Fetches the full body HTML of one post. Paywalled posts return truncated/empty body without an auth cookie. */
async function fetchFullPostBody(substackUser: string, slug: string): Promise<string> {
    const res = await fetch(
        `https://${substackUser}.substack.com/api/v1/posts/${slug}`,
        { headers: FETCH_HEADERS, signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) throw new Error(`post ${res.status} ${res.statusText}`);
    const post = await res.json() as any;
    return stripHtml(post.body_html || '');
}

/** Returns every newsletter post for an author, with full body text where the post is free. */
async function getAllSubstackPosts(substackUser: string): Promise<ImportItem[]> {
    const entries = await fetchArchive(substackUser);
    console.log(`   📚 ${entries.length} newsletter posts in archive — fetching full bodies now\n`);
    const items: ImportItem[] = [];

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        let fullContent = stripHtml(entry.description || '');
        const progress = `${i + 1}/${entries.length}`;

        if (entry.audience === 'everyone') {
            try {
                fullContent = await fetchFullPostBody(substackUser, entry.slug);
                console.log(`   📝 body ${progress}: ${entry.slug} (${fullContent.length} chars)`);
            } catch (e: any) {
                console.log(`   ⚠️  body ${progress}: couldn't fetch ${entry.slug}: ${e.message}`);
            }
            await sleep(POST_FETCH_DELAY_MS);
        } else {
            console.log(`   🔒 body ${progress}: paywalled, using preview only: ${entry.slug}`);
        }

        items.push({
            id: urlToId(entry.canonical_url),
            title: stripHtml(entry.title),
            previewText: fullContent.slice(0, 400),
            fullContent,
            link: entry.canonical_url,
            date: (entry.post_date || '').split('T')[0] || new Date().toISOString().split('T')[0]!,
            image: entry.cover_image || '',
        });
    }

    return items;
}

// ─── Local blog (abderahmane.com) ────────────────────────────────────────────

/** Minimal frontmatter parser — good enough for this blog's flat key/value + array schema */
function parseFrontmatter(raw: string): { data: Record<string, any>; body: string } {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return { data: {}, body: raw };

    const fm = match[1] ?? '';
    const body = match[2] ?? '';
    const data: Record<string, any> = {};

    for (const line of fm.split('\n')) {
        const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (!m) continue;
        const key = m[1]!;
        const val = (m[2] ?? '').trim();

        if (val.startsWith('[') || val.startsWith('{')) {
            try { data[key] = JSON.parse(val); } catch { data[key] = val; }
        } else if (/^"(.*)"$/.test(val) || /^'(.*)'$/.test(val)) {
            data[key] = val.slice(1, -1);
        } else {
            data[key] = val;
        }
    }

    return { data, body: body.trim() };
}

function stripMarkdown(md: string): string {
    return md
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[*_`>]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Reads Arabic-only posts from the personal blog's content collection */
function readLocalBlogPosts(): ImportItem[] {
    if (!fs.existsSync(LOCAL_BLOG_DIR)) {
        console.log(`⚠️  Local blog directory not found, skipping: ${LOCAL_BLOG_DIR}`);
        return [];
    }

    const files = fs.readdirSync(LOCAL_BLOG_DIR).filter(f => /\.mdx?$/.test(f));
    const posts: ImportItem[] = [];

    for (const file of files) {
        const raw = fs.readFileSync(path.join(LOCAL_BLOG_DIR, file), 'utf-8');
        const { data, body } = parseFrontmatter(raw);

        if (data.lang !== 'ar') continue;

        const slug = file.replace(/\.mdx?$/, '');
        const link = `${LOCAL_BLOG_SITE_URL}/article/${slug}`;
        const fullContent = stripMarkdown(body);
        const pubDate: unknown = data.pubDate;
        const date = typeof pubDate === 'string' && pubDate
            ? pubDate
            : new Date().toISOString().split('T')[0]!;

        posts.push({
            id: urlToId(link),
            title: data.title || slug,
            previewText: data.description || fullContent.slice(0, 400),
            fullContent,
            link,
            date,
            image: data.thumb || '',
        });
    }

    return posts;
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

const OLLAMA_TIMEOUT_MS = 120_000; // model cold-start / load can be slow — give it real headroom

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
        .replace(/،/g, ',');   // Arabic comma → JSON comma (model sometimes uses ، as separator)

    const parsed = JSON.parse(text) as Summary;

    // Validate the returned category slug; fall back to 'general' if unknown
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

    // Find or create the AI-selected category
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

const SAVE_EVERY_N_ITEMS = 20; // checkpoint mid-author too, not just between authors

function saveData(data: ArticlesConfig) {
    fs.writeFileSync(ARTICLES_PATH, JSON.stringify(data, null, 2));
}

async function main() {
    const data: ArticlesConfig = JSON.parse(fs.readFileSync(ARTICLES_PATH, 'utf-8'));

    // Duplicate check across ALL categories
    const allExistingIds = new Set(
        data.articles.flatMap(c => c.content.map(a => a.id_str))
    );

    let added = 0;
    let skipped = 0;
    let failedUsers = 0;
    let sinceLastSave = 0;

    for (const substackUser of substackUsers) {
        console.log(`\n📡 [${substackUser}] Fetching full archive\n`);

        let items: ImportItem[];
        try {
            items = await getAllSubstackPosts(substackUser);
        } catch (err: any) {
            console.error(`❌ [${substackUser}] Archive error: ${err.message}`);
            failedUsers++;
            continue;
        }

        console.log(items.length > 0 ? `📰 ${items.length} articles found\n` : '⚠️  No articles found in archive.\n');

        for (let i = 0; i < items.length; i++) {
            const wasAdded = await processItem(
                items[i]!, `[${substackUser} ${i + 1}/${items.length}]`, substackUser, '', data, allExistingIds,
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

        // Always checkpoint at the end of each author, even if under the item threshold
        saveData(data);
        sinceLastSave = 0;
    }

    // ─── Personal blog (abderahmane.com) — Arabic posts ────────────────────
    const localPosts = readLocalBlogPosts();
    console.log(
        localPosts.length > 0
            ? `\n📁 ${localPosts.length} Arabic post(s) found in local blog\n`
            : '\n📁 No Arabic posts found in local blog\n'
    );

    for (let i = 0; i < localPosts.length; i++) {
        const wasAdded = await processItem(
            localPosts[i]!, `[${i + 1}/${localPosts.length}]`, LOCAL_BLOG_SCREEN_NAME, '', data, allExistingIds,
        );
        wasAdded ? added++ : skipped++;

        sinceLastSave++;
        if (sinceLastSave >= SAVE_EVERY_N_ITEMS) {
            saveData(data);
            sinceLastSave = 0;
            console.log(`   💾 checkpoint saved (${added} added so far)`);
        }

        if (i < localPosts.length - 1) await sleep(API_DELAY_MS);
    }

    saveData(data);

    console.log('\n─────────────────────────────────────────');
    console.log(`✅ Added    ${added} articles`);
    console.log(`⏭  Skipped  ${skipped} duplicates`);
    if (failedUsers > 0) console.log(`❌ Failed   ${failedUsers} user feed(s)`);
    console.log('─────────────────────────────────────────');
    console.log('\n💡 Run: bun run prepare-data\n');
}

main().catch(err => {
    console.error('\n❌', err.message);
    process.exit(1);
});