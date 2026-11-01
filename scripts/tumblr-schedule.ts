#!/usr/bin/env bun
/**
 * Tumblr scheduler — الهلال
 * -------------------------
 * Queues a daily mix of posts on the Tumblr blog (TUMBLR_BLOG, default
 * "elhellal") through the official API: every post gets a publish time, so it
 * lands in Tumblr's queue and goes out on its own. Every post is built to send
 * readers to one of the sites: a tall pin image, an Arabic caption, a bold
 * link, the link as the post's source, and Arabic + English tags (tags are how
 * people find posts on Tumblr).
 *
 *   article  pin image (or the site's link card) + title + tldr → elhellal.com
 *   quote    quote card + the quote + author/book → quotes.elhellal.com
 *   book     book pin + summary → books.elhellal.com
 *   bio      biography pin + summary → biographies.elhellal.com
 *   quiz     question card, answer withheld → quiz.elhellal.com
 *   reblog   re-queues one of the blog's own best posts (most notes) that is
 *            at least 3 days old, for readers in other time zones
 *
 * Images and links for quotes / books / bios / quizzes come from the Pinterest
 * feeds on R2 (bun run admin → Pins makes them); articles come from the catalog
 * and use their pin when one exists.
 *
 *   bun run tumblr-schedule --day           one day (today if its slots are still ahead, else tomorrow)
 *   bun run tumblr-schedule --next 7        the next N days
 *   bun run tumblr-schedule --month 11 2026 every remaining day of that month
 *
 * Options (per day):
 *   --articles 3 --quotes 2 --books 1 --bios 0 --quizzes 1 --reblogs 1
 *   --from 08:00 --to 23:00   posting window; the day's posts are spread evenly over it
 *   --date YYYY-MM-DD         first day (--day / --next)
 *   --category <slug>         articles from one category only
 *   --since YYYY-MM-DD        articles created on/after this day
 *   --random                  random article order (default: articles with a pin first, newest first)
 *   --dry-run                 print the plan, post nothing
 *
 * Tumblr caps a blog at about 250 posts and 150 photo uploads a day. When the
 * cap is hit the script stops; everything queued so far is remembered in
 * .tumblr/posted.json, so running the same command again tomorrow carries on
 * (taken time slots and used items are skipped).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Article, Category } from '../src/types';
import { readArticles } from '../src/lib/articles-store.ts';
import { BLOG, TUMBLR_DIR, TumblrError, createPost, imageUrlBlock, isConnected, linkText, text, tumblr, type Upload } from './lib/tumblr.ts';
import { isImageUrl, resizeImage } from '../src/lib/images.ts';

const ROOT = join(import.meta.dir, '..');
const STATE_FILE = join(TUMBLR_DIR, 'posted.json');
const SITE = 'https://elhellal.com';
const FEEDS = (process.env.R2_PUBLIC_URL || 'https://img.elhellal.com').replace(/\/$/, '');
const QUOTES_JSON = join(ROOT, '../elhellal-quotes/src/data/quotes.json');

// ── args ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
};
const count = (name: string, fallback: number) => {
    const v = opt(name);
    if (v === undefined) return fallback;
    if (!/^\d+$/.test(v) || Number(v) > 24) throw new Error(`--${name} takes a number of posts per day (0-24)`);
    return Number(v);
};

const mode = flag('month') ? 'month' : flag('next') ? 'next' : flag('day') ? 'day' : undefined;
if (!mode) {
    console.error('Usage: bun run tumblr-schedule --day | --next N | --month M YYYY [--articles 3] [--quotes 2] [--books 1] [--bios 0] [--quizzes 1] [--reblogs 1] [--from 08:00] [--to 23:00] [--date YYYY-MM-DD] [--category slug] [--since YYYY-MM-DD] [--random] [--dry-run]');
    process.exit(1);
}
const dryRun = flag('dry-run');

const KINDS = ['article', 'quote', 'quiz', 'book', 'bio', 'reblog'] as const;
type Kind = (typeof KINDS)[number];
const perDay: Record<Kind, number> = {
    article: count('articles', 3),
    quote: count('quotes', 2),
    quiz: count('quizzes', 1),
    book: count('books', 1),
    bio: count('bios', 0),
    reblog: count('reblogs', 1),
};
const daily = KINDS.reduce((n, k) => n + perDay[k], 0);
if (!daily) throw new Error('Nothing to post — every count is 0');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const from = opt('from') ?? '08:00';
const to = opt('to') ?? '23:00';
if (!TIME_RE.test(from) || !TIME_RE.test(to) || from >= to) throw new Error('--from / --to must be HH:MM with from < to');

// ── dates & slots ──────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const hm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const earliest = Date.now() + 10 * 60_000;
const future = (at: string) => new Date(at).getTime() > earliest;

/** The day's kinds interleaved (article, quote, quiz, article, …) so the same kind never runs back to back if it can help it. */
function dayOrder(): Kind[] {
    const left = { ...perDay };
    const out: Kind[] = [];
    while (out.length < daily) {
        // Most-remaining first, never repeating the previous kind when another is left.
        const next = KINDS.filter((k) => left[k] > 0).sort((a, b) => left[b] - left[a] || KINDS.indexOf(a) - KINDS.indexOf(b));
        const pick = next.find((k) => k !== out.at(-1)) ?? next[0]!;
        out.push(pick);
        left[pick]--;
    }
    return out;
}

function dayTimes(n: number): string[] {
    const a = mins(from);
    const b = mins(to);
    return Array.from({ length: n }, (_, i) => hm(n === 1 ? Math.round((a + b) / 2 / 5) * 5 : a + Math.round(((b - a) * i) / (n - 1) / 5) * 5));
}

function days(): string[] {
    const list: string[] = [];
    const i = argv.indexOf('--month');
    if (mode === 'month') {
        const m = Number(argv[i + 1]);
        const y = Number(argv[i + 2]);
        if (!(m >= 1 && m <= 12) || !/^\d{4}$/.test(argv[i + 2] ?? '')) throw new Error('Use --month <1-12> <YYYY>, e.g. --month 11 2026');
        for (let d = 1; d <= new Date(y, m, 0).getDate(); d++) list.push(`${y}-${pad(m)}-${pad(d)}`);
        return list;
    }
    const n = mode === 'next' ? Number(opt('next') ?? 7) : 1;
    if (!Number.isInteger(n) || n < 1 || n > 60) throw new Error('--next takes 1-60 days');
    const d = opt('date') ? new Date(`${opt('date')}T00:00:00`) : new Date();
    if (Number.isNaN(d.getTime())) throw new Error('--date must be YYYY-MM-DD');
    // One day without --date: today only if all its slots are still ahead.
    if (mode === 'day' && !opt('date') && !dayTimes(daily).every((t) => future(`${ymd(d)}T${t}`))) d.setDate(d.getDate() + 1);
    for (let k = 0; k < n; k++) {
        list.push(ymd(d));
        d.setDate(d.getDate() + 1);
    }
    return list;
}

// ── state ──────────────────────────────────────────────────────────────
interface State {
    /** item key (article id, link, reblog:<id>) → when it was queued for */
    items: Record<string, { at: string; post?: string; kind: Kind }>;
    /** "YYYY-MM-DDTHH:MM" → item key, so a rerun never double-books a slot */
    slots: Record<string, string>;
}
mkdirSync(TUMBLR_DIR, { recursive: true });
const state: State = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { items: {}, slots: {} };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const slots: { at: string; kind: Kind }[] = [];
const order = dayOrder();
const times = dayTimes(daily);
for (const day of days()) {
    order.forEach((kind, i) => {
        const at = `${day}T${times[i]}`;
        if (future(at) && !state.slots[at]) slots.push({ at, kind });
    });
}
if (!slots.length) throw new Error('No free future slots in that range (already queued, or the days are over)');

// ── sources ────────────────────────────────────────────────────────────
interface FeedItem {
    title: string;
    link: string;
    description: string;
    image: string;
}

const unxml = (s: string) =>
    s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();

async function feed(key: string): Promise<FeedItem[]> {
    const res = await fetch(`${FEEDS}/${key}`);
    if (!res.ok) {
        console.warn(`Feed ${key}: ${res.status} — skipping`);
        return [];
    }
    const xml = await res.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].flatMap(([, item]) => {
        const tag = (t: string) => unxml(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(item!)?.[1] ?? '');
        const image = /<enclosure url="([^"]+)"/.exec(item!)?.[1];
        const link = tag('link');
        return image && link ? [{ title: tag('title'), link, description: tag('description'), image: unxml(image) }] : [];
    });
}

function shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
}

const need = (k: Kind) => slots.some((s) => s.kind === k);
const [articleFeed, bookFeed, bioFeed, quizFeed] = await Promise.all([
    need('article') ? feed('feed.xml') : [],
    need('book') ? feed('books-feed.xml') : [],
    need('bio') ? feed('bio-feed.xml') : [],
    need('quiz') ? feed('quiz-feed.xml') : [],
]);

const utm = (url: string) => `${url}${url.includes('?') ? '&' : '?'}utm_source=tumblr&utm_medium=social`;

/** Tumblr tags: no commas or #, ≤140 chars, deduped, at most 30. */
function tags(list: (string | undefined)[]): string[] {
    const seen = new Set<string>();
    return list
        .map((t) => (t ?? '').replace(/[,#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140))
        .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
        .slice(0, 30);
}

const clip = (s: string, n: number) => {
    s = s.replace(/\s+/g, ' ').trim();
    return s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, '')}…`;
};

interface Planned {
    key: string;
    kind: Kind;
    label: string;
    build: () => Promise<{ content: unknown[]; tags: string[]; source_url?: string; uploads: Upload[]; reblog?: { uuid: string; id: string; key: string } }>;
}

/** Image block from a pin URL (Tumblr fetches and re-hosts it). Fails early if the image is gone. */
async function pin(url: string, alt: string) {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) throw new Error(`Image ${url}: ${res.status}`);
    return imageUrlBlock(url, alt);
}

/** An article's cover at 1200px as JPEG (Tumblr doesn't take WebP everywhere). */
const cover = (url: string) => resizeImage(url, 1200).replace('f_webp', 'f_jpg').replace('format=auto', 'format=jpeg');

// Articles: catalog, pinned ones first (their pin is the post's image).
function articlePool(): Planned[] {
    const pins = new Map(articleFeed.map((f) => [f.link.replace(/\/?$/, '/'), f.image]));
    const data = readArticles() as { articles: Category[] };
    const category = opt('category');
    const since = opt('since') ?? '';
    const contentKey = (a: Article) => `${a.screen_name}|${(a.preview_text || a.tldr || a.title).replace(/\s+/g, ' ').trim().slice(0, 120)}`;
    const used = new Set(data.articles.flatMap((c) => c.content).filter((a) => state.items[a.id_str]).map(contentKey));
    const seen = new Set<string>();
    const list = data.articles
        .filter((c) => !category || c.category === category)
        .flatMap((c) => c.content.map((a) => ({ a, cat: c })))
        .filter(({ a }) => {
            if (!a.slug || !(a.tldr || a.preview_text)?.trim() || a.created_at < since || state.items[a.id_str]) return false;
            const key = contentKey(a);
            if (used.has(key) || seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .map(({ a, cat }) => {
            const url = `${SITE}/articles/${encodeURIComponent(a.slug!)}/`;
            return { a, cat, url, pin: pins.get(url) };
        });
    if (flag('random')) shuffle(list);
    else list.sort((x, y) => Number(!!y.pin) - Number(!!x.pin) || y.a.created_at.localeCompare(x.a.created_at));
    return list.map(({ a, cat, url, pin: image }) => ({
        key: a.id_str,
        kind: 'article',
        label: a.title,
        build: async () => {
            const summary = clip(a.tldr || a.preview_text, 600);
            const link = utm(url);
            const uploads: Upload[] = [];
            // The pin, else the article's own cover; a link card only when neither loads.
            const img = image ?? (isImageUrl(a.original_img_url) ? cover(a.original_img_url) : undefined);
            const block = img ? await pin(img, a.title).catch(() => null) : null;
            const content: unknown[] = [
                ...(block ? [block] : []),
                text(a.title, 'heading1'),
                text(summary),
                block ? linkText('اقرأ المقال كاملاً على الهلال ←', link) : { type: 'link', url: link, title: a.title, description: clip(a.preview_text || summary, 200), site_name: 'الهلال' },
            ];
            return {
                content,
                uploads,
                source_url: url,
                tags: tags([cat.title, ...(a.keywords ?? []).slice(0, 6), 'مقالات', 'مقالات عربية', 'قراءة', 'الهلال', 'arabic', 'arabic articles']),
            };
        },
    }));
}

// Quotes: every author in ../elhellal-quotes, most-liked first, authors taking turns.
// Quotes that have a pin on R2 get their card image; the rest go out as Tumblr text quotes.
async function quotePool(): Promise<Planned[]> {
    if (!existsSync(QUOTES_JSON)) {
        console.warn(`${QUOTES_JSON} not found — skipping quotes`);
        return [];
    }
    const pinned = new Set<string>(((await fetch(`${FEEDS}/published.json`).then((r) => r.json()).catch(() => ({}))) as any).urls ?? []);
    const authors: any[] = JSON.parse(readFileSync(QUOTES_JSON, 'utf8')).authors ?? [];
    const groups = shuffle(
        authors.map((a) =>
            (a.quotes ?? [])
                .filter((q: any) => q.text?.length <= 500)
                .map((q: any) => ({ q, a, url: `https://quotes.elhellal.com/${a.slug}/${q.id}/` }))
                .filter((x: any) => !state.items[x.url])
                .sort((x: any, y: any) => (y.q.likes ?? 0) - (x.q.likes ?? 0)),
        ),
    ).filter((g) => g.length);
    const mixed: { q: any; a: any; url: string }[] = [];
    for (let i = 0; groups.some((g) => g.length > i); i++) for (const g of groups) if (g[i]) mixed.push(g[i]);
    return mixed.map(({ q, a, url }) => ({
        key: url,
        kind: 'quote' as const,
        label: `${a.name}${pinned.has(url) ? ' 🖼' : ''}: ${q.text}`,
        build: async () => {
            const content: unknown[] = [];
            const uploads: Upload[] = [];
            if (pinned.has(url)) content.push(await pin(`${FEEDS}/images/quotes/${encodeURIComponent(a.slug)}/${q.id}.png`, clip(q.text, 900)));
            content.push(text(q.text.trim(), 'quote'), text(`— ${a.name}`), linkText(`المزيد من اقتباسات ${a.name} ←`, utm(url)));
            return {
                content,
                uploads,
                source_url: url,
                tags: tags(['اقتباسات', 'اقتباس', a.name, ...(q.tags ?? []).slice(0, 4), 'كتب', 'أدب', 'عبارات', 'arabic quotes', 'quotes', 'booklr', 'literature']),
            };
        },
    }));
}

function bookPool(): Planned[] {
    return bookFeed
        .filter((f) => !state.items[f.link])
        .map((f) => {
            const [, title = f.title, author] = /^ملخص كتاب (.+?) — (.+)$/.exec(f.title) ?? [];
            const summary = f.description.replace(/^[^:]*:\s*/, '');
            return {
                key: f.link,
                kind: 'book' as const,
                label: f.title,
                build: async () => {
                    const p = await pin(f.image, f.title);
                    return {
                        content: [p, text(`ملخص كتاب «${title}»`, 'heading1'), ...(author ? [text(`لـ${author}`)] : []), text(clip(summary, 700)), linkText('اقرأ الملخص كاملاً ←', utm(f.link))],
                        uploads: [],
                        source_url: f.link,
                        tags: tags(['ملخص كتاب', 'ملخصات كتب', 'كتب', 'قراءة', title, author, 'booklr', 'books', 'book summary', 'arabic']),
                    };
                },
            };
        });
}

function bioPool(): Planned[] {
    return bioFeed
        .filter((f) => !state.items[f.link])
        .map((f) => {
            const name = /^سيرة (.+?)(?: — |$)/.exec(f.title)?.[1] ?? f.title;
            const summary = f.description.slice(f.title.length).replace(/^:\s*/, '') || f.description;
            return {
                key: f.link,
                kind: 'bio' as const,
                label: f.title,
                build: async () => {
                    const p = await pin(f.image, f.title);
                    return {
                        content: [p, text(f.title, 'heading1'), text(clip(summary, 700)), linkText('اقرأ السيرة كاملة ←', utm(f.link))],
                        uploads: [],
                        source_url: f.link,
                        tags: tags(['سيرة', 'سير ذاتية', 'شخصيات', 'شخصيات تاريخية', name, 'تاريخ', 'biography', 'history']),
                    };
                },
            };
        });
}

// Quizzes: the answer stays on the site — that's the click.
function quizPool(): Planned[] {
    return shuffle(quizFeed.filter((f) => !state.items[f.link])).map((f) => {
        const topic = /اختبر معلوماتك في (.+?) مع/.exec(f.description)?.[1];
        return {
            key: f.link,
            kind: 'quiz' as const,
            label: f.title,
            build: async () => {
                const p = await pin(f.image, f.title);
                return {
                    content: [p, text(`🧠 ${f.title}`, 'heading2'), text('هل تعرف الإجابة؟ فكّر قبل أن تضغط 👇'), linkText('اكتشف الإجابة ←', utm(f.link))],
                    uploads: [],
                    source_url: f.link,
                    tags: tags(['اختبار', 'أسئلة', 'سؤال وجواب', 'معلومات عامة', 'ثقافة عامة', topic, 'trivia', 'quiz', 'arabic']),
                };
            },
        };
    });
}

// Reblogs: the blog's own original posts with the most notes, ≥3 days old, each reblogged once.
async function reblogPool(): Promise<Planned[]> {
    if (!isConnected()) {
        console.warn('Tumblr not connected — skipping reblogs');
        return [];
    }
    const info = await tumblr('GET', `/blog/${BLOG}/info`);
    const uuid: string = info.blog.uuid;
    const posts: any[] = [];
    for (let offset = 0; offset < 300; offset += 20) {
        const r = await tumblr('GET', `/blog/${BLOG}/posts`, { query: { limit: 20, offset, npf: true, reblog_info: true } });
        posts.push(...r.posts);
        if (r.posts.length < 20) break;
    }
    const cutoff = Date.now() / 1000 - 3 * 86400;
    return posts
        .filter((p) => !p.reblogged_from_id && !p.parent_post_url && p.timestamp < cutoff && (p.note_count ?? 0) > 0 && !state.items[`reblog:${p.id_string}`])
        .sort((a, b) => b.note_count - a.note_count)
        .map((p) => ({
            key: `reblog:${p.id_string}`,
            kind: 'reblog' as const,
            label: `${p.note_count} notes · ${p.summary || p.post_url}`,
            build: async () => ({ content: [], tags: p.tags ?? [], uploads: [], reblog: { uuid, id: p.id_string, key: p.reblog_key } }),
        }));
}

const pools: Record<Kind, Planned[]> = {
    article: need('article') ? articlePool() : [],
    quote: need('quote') ? await quotePool() : [],
    book: need('book') ? bookPool() : [],
    bio: need('bio') ? bioPool() : [],
    quiz: need('quiz') ? quizPool() : [],
    reblog: need('reblog') ? await reblogPool() : [],
};

const plan: { at: string; item: Planned }[] = [];
const short: Partial<Record<Kind, number>> = {};
for (const s of slots) {
    const item = pools[s.kind].shift();
    if (item) plan.push({ at: s.at, item });
    else short[s.kind] = (short[s.kind] ?? 0) + 1;
}
for (const [k, n] of Object.entries(short)) console.warn(`⚠️  Ran out of ${k} posts — ${n} ${k} slot(s) left empty.`);
if (!plan.length) throw new Error('Nothing to post');

const tally = (k: Kind) => plan.filter((p) => p.item.kind === k).length;
for (const p of plan) console.log(`${p.at.replace('T', ' ')}  ${p.item.kind.padEnd(7)} ${clip(p.item.label, 80)}`);
console.log(`\n${plan.length} posts (${KINDS.filter(tally).map((k) => `${tally(k)} ${k}`).join(', ')}), ${plan[0]!.at.replace('T', ' ')} → ${plan.at(-1)!.at.replace('T', ' ')}`);

if (dryRun) {
    console.log('\n--dry-run: nothing posted.');
    process.exit(0);
}

// ── post ───────────────────────────────────────────────────────────────
console.log(`\nQueuing on ${BLOG}.tumblr.com…`);
let done = 0;
for (const { at, item } of plan) {
    try {
        const b = await item.build();
        const id = await createPost(
            BLOG,
            {
                content: b.content,
                tags: b.tags,
                state: 'queue',
                publish_on: new Date(at).toISOString(),
                source_url: b.source_url,
                ...(b.reblog ? { parent_tumblelog_uuid: b.reblog.uuid, parent_post_id: b.reblog.id, reblog_key: b.reblog.key } : {}),
            },
            b.uploads,
        );
        state.items[item.key] = { at, post: id, kind: item.kind };
        state.slots[at] = item.key;
        save();
        done++;
        console.log(`✓ ${at.replace('T', ' ')} ${item.kind} (${done}/${plan.length})`);
    } catch (e) {
        if (e instanceof TumblrError && e.isRateLimit) {
            console.error(`\n⏸  Tumblr's daily limit reached after ${done} posts: ${e.message}\nRun the same command tomorrow — it picks up where it stopped.`);
            process.exit(2);
        }
        if (e instanceof TumblrError && e.status === 401) {
            console.error(`\n✗ ${e.message}`);
            process.exit(1);
        }
        // One bad item (a missing image, a deleted post) shouldn't stop the batch.
        console.error(`✗ ${at.replace('T', ' ')} ${item.kind} ${clip(item.label, 60)} — ${(e as Error).message}`);
    }
    await Bun.sleep(1200);
}
console.log(`\ndone — ${done} of ${plan.length} queued. See https://www.tumblr.com/blog/${BLOG}/queue`);
