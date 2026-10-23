/**
 * Push notifications for elhellal.com (route: elhellal.com/api/push/*).
 *
 *   GET  /api/push/key            VAPID public key for pushManager.subscribe()
 *   GET  /api/push/subscription   ?endpoint= → the stored preferences
 *   POST /api/push/subscribe      { subscription, categories, frequency, oldEndpoint? }
 *   POST /api/push/unsubscribe    { endpoint }
 *   POST /api/push/test           { endpoint } → one test notification (1/min)
 *   POST /api/push/event          { name } → daily counter (installs, clicks…)
 *   POST /api/push/ping           { id, platform, push } → the installed app was
 *                                 opened today (once a day per device; `installs`)
 *   POST /api/push/quiz           { endpoint, day } → this subscriber answered the
 *                                 Explore tab's question of the day (its streak)
 *   POST /api/push/read           { endpoint, day, streak, week } → this subscriber
 *                                 read an article today (src/scripts/reading.ts):
 *                                 their reading streak and last 7 days' numbers
 *   POST /api/push/follows        { endpoint, follows: ['author:x', 'tag:y'] }
 *   POST /api/push/suggest        { url, title } → a link suggested for the
 *                                 directory (the app's share target, /share/)
 *
 * The cron trigger (every 5 minutes) sends:
 *   1. digests: each subscription is due at SEND_HOUR_UTC daily, or on
 *      Fridays when weekly. Its notification lists the articles of its
 *      categories that appeared on the site since its last digest, read from
 *      dist/_data/push-digest.json (src/lib/push-digest.ts). "Appeared" is
 *      when this Worker first saw an article in the digest (articles_seen),
 *      not its created_at: imports trail publication by days, and dating by
 *      created_at would skip whatever arrived late. Each digest ends with the
 *      quote of the day (the one the app's Explore tab shows, from
 *      quotes.elhellal.com/app-feed.json); with no new articles a daily
 *      subscriber still gets the quote alone, a weekly one nothing.
 *      Followed authors and tags count as wanted, whatever the categories,
 *      and lead the notification.
 *   2. nudges, one a day at most per subscriber (nudged_day):
 *      - the weekly recap, Fridays at RECAP_HOUR_UTC, to readers active in
 *        the last two days: their last 7 days' reads, minutes and top topic
 *      - streak reminders at REMIND_HOUR_UTC: a reading streak (2+ days)
 *        that ends yesterday gets a short article to keep it alive; failing
 *        that, a quiz streak gets the question of the day; failing both, a
 *        daily subscriber gets a short read for the evening. So a daily
 *        subscriber gets two notifications a day, a weekly one about one a week.
 *   3. "more notifications" (opt-in, daily subscribers; extra_day/extra_sent):
 *      a morning article at MORNING_HOUR_UTC, the quote of the day at
 *      QUOTE_HOUR_UTC and the quiz question at QUIZ_HOUR_UTC (unless already
 *      answered): five a day with the digest and the evening nudge. Their
 *      digest then skips the quote-only fallback.
 *   4. the outbox: one-off messages the admin panel queues (scripts/admin.ts).
 * At most PUSH_BATCH messages per run: the free plan allows 50 subrequests and
 * 10 ms of CPU per invocation, so big sends are spread over several runs
 * (40 per 5 minutes ≈ 11k a day).
 */

import type { DigestArticle, PushDigest } from '../../../src/lib/push-digest';
import { sendPush, VapidSigner, type PushTarget } from './webpush';

interface Env {
    DB: D1Database;
    /** The site Worker, for the digest file (a same-zone fetch would skip it). */
    SITE?: Fetcher;
    SITE_URL: string;
    VAPID_PUBLIC_KEY: string;
    /** Secret: the VAPID private key as a JWK (scripts/generate-vapid.ts). */
    VAPID_PRIVATE_JWK: string;
    VAPID_SUBJECT: string;
    PUSH_BATCH?: string;
    SEND_HOUR_UTC?: string;
    REMIND_HOUR_UTC?: string;
    RECAP_HOUR_UTC?: string;
    /** The quotes site's Worker, for the quote of the day. */
    QUOTES?: Fetcher;
    /** The quiz site's Worker, for the question of the day. */
    QUIZ?: Fetcher;
    MORNING_HOUR_UTC?: string;
    QUOTE_HOUR_UTC?: string;
    QUIZ_HOUR_UTC?: string;
}

/** One item of the quiz site's /app-feed.json (../elhellal-quiz). */
export interface FeedQuiz {
    /** the question */
    title: string;
    options?: string[];
}

/** One item of a sister site's /app-feed.json (../elhellal-quotes/src/pages/app-feed.json.ts). */
export interface FeedQuote {
    text: string;
    /** the author */
    title: string;
    url: string;
}

type Frequency = 'daily' | 'weekly';

interface SubscriptionRow {
    endpoint: string;
    p256dh: string;
    auth: string;
    /** '*' or ',cat-a,cat-b,' (comma-wrapped so SQL can LIKE '%,cat,%') */
    categories: string;
    frequency: Frequency;
    /** ms: articles first seen after this are new to this subscriber */
    since: number;
    next_due_at: number;
    last_test_at: number | null;
    failures: number;
    quiz_day: number;
    quiz_streak: number;
    /** ',author:x,tag:y,' */
    follows: string;
    /** 1: "more notifications" (up to five a day) */
    extra: number;
}

/** Bits of extra_sent: the extra slots already sent on extra_day. */
const EXTRA_MORNING = 1;
const EXTRA_QUOTE = 2;
const EXTRA_QUIZ = 4;

interface Job {
    target: PushTarget;
    payload: Record<string, unknown>;
    topic?: string;
    /** A digest: on success the subscriber's `since` moves to this run. */
    digest?: boolean;
}

const ALLOWED_ORIGINS = ['https://elhellal.com', 'https://www.elhellal.com'];
/** Push services browsers use; anything else would make us POST to arbitrary URLs. */
const PUSH_HOSTS =
    /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|[\w-]+\.notify\.windows\.com)$/;
const CATEGORY_RE = /^[a-z0-9-]{1,40}$/;
/** 'author:<screen_name>' or 'tag:<slug>' (tag slugs are often Arabic) */
const FOLLOW_RE = /^(author|tag):[^\s,]{1,80}$/u;
const MAX_FOLLOWS = 100;
const INSTALL_ID_RE = /^[\w-]{16,64}$/;
const PLATFORMS = new Set(['ios', 'android', 'desktop', 'other']);
const EVENTS = new Set([
    'installed',
    'install-accepted',
    'install-dismissed',
    'banner-dismissed',
    'banner-shown',
    'banner-shown-ios',
    'banner-clicked',
    'cta-clicked',
    'link-clicked',
    'card-clicked',
    'app-clicked',
    'app-page',
    'quiz-answered',
    'app-page-quotes',
    'app-page-books',
    'app-page-biographies',
    'app-page-quiz',
    'guide-shown',
    'inapp-shown',
    'inapp-opened',
    'notify-dismissed',
    'click',
    'subscribed',
    'unsubscribed',
]);
const MAX_BODY = 4096;
const MAX_FAILURES = 5;
const TEST_INTERVAL_MS = 60_000;
/** Longer than the digest's reach (DIGEST_DAYS), so a slug is never re-seen as new. */
const SEEN_RETENTION_DAYS = 60;
const DAY_MS = 86_400_000;

// ─── HTTP ────────────────────────────────────────────────────────────────────

class HttpError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

function corsHeaders(origin: string | null): HeadersInit {
    const allowed = origin && (ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost:\d+$/.test(origin));
    return {
        'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0]!,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        Vary: 'Origin',
    };
}

function json(data: unknown, status: number, origin: string | null, headers: HeadersInit = {}): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin), ...headers },
    });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
    const text = await request.text();
    if (text.length > MAX_BODY) throw new HttpError(413, 'body too large');
    try {
        const body = JSON.parse(text);
        if (body && typeof body === 'object') return body;
    } catch {
        // fall through
    }
    throw new HttpError(400, 'invalid body');
}

function validEndpoint(value: unknown): string {
    if (typeof value !== 'string' || value.length > 1000) throw new HttpError(400, 'invalid endpoint');
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new HttpError(400, 'invalid endpoint');
    }
    if (url.protocol !== 'https:' || !PUSH_HOSTS.test(url.hostname)) throw new HttpError(400, 'unsupported push service');
    return value;
}

function parseCategories(value: unknown): string {
    if (value === undefined || value === '*') return '*';
    if (!Array.isArray(value) || value.length === 0 || value.length > 60) throw new HttpError(400, 'invalid categories');
    if (!value.every((c) => typeof c === 'string' && CATEGORY_RE.test(c))) throw new HttpError(400, 'invalid categories');
    return `,${[...new Set(value as string[])].sort().join(',')},`;
}

function parseFrequency(value: unknown): Frequency {
    if (value === undefined) return 'daily';
    if (value === 'daily' || value === 'weekly') return value;
    throw new HttpError(400, 'invalid frequency');
}

function preferences(row: Pick<SubscriptionRow, 'categories' | 'frequency' | 'extra'>) {
    return {
        categories: row.categories === '*' ? '*' : row.categories.split(',').filter(Boolean),
        frequency: row.frequency,
        extra: row.extra === 1,
    };
}

async function countEvent(env: Env, name: string, by = 1) {
    if (by <= 0) return;
    await env.DB.prepare('INSERT INTO events (day, name, n) VALUES (?, ?, ?) ON CONFLICT (day, name) DO UPDATE SET n = n + excluded.n')
        .bind(new Date().toISOString().slice(0, 10), name, by)
        .run();
}

async function handleSubscribe(request: Request, env: Env, ctx: ExecutionContext) {
    const body = await readBody(request);
    const sub = body.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
    const endpoint = validEndpoint(sub?.endpoint);
    const { p256dh, auth } = sub?.keys ?? {};
    if (typeof p256dh !== 'string' || typeof auth !== 'string' || !/^[\w-]{80,100}$/.test(p256dh) || !/^[\w-]{16,30}$/.test(auth)) {
        throw new HttpError(400, 'invalid keys');
    }

    // Moved by the push service (pushsubscriptionchange): keep the old preferences.
    const oldEndpoint = typeof body.oldEndpoint === 'string' ? body.oldEndpoint : null;
    const previous = await env.DB.prepare('SELECT categories, frequency, since, extra FROM subscriptions WHERE endpoint IN (?, ?)')
        .bind(endpoint, oldEndpoint ?? endpoint)
        .first<Pick<SubscriptionRow, 'categories' | 'frequency' | 'since' | 'extra'>>();
    const categories = body.categories === undefined && previous ? previous.categories : parseCategories(body.categories);
    const frequency = body.frequency === undefined && previous ? previous.frequency : parseFrequency(body.frequency);
    const extra = body.extra === undefined ? previous?.extra ?? 0 : body.extra === true ? 1 : 0;

    const now = Date.now();
    const app = body.app === true ? 1 : 0;
    const statements = [
        env.DB.prepare(
            `INSERT INTO subscriptions (endpoint, p256dh, auth, categories, frequency, since, next_due_at, created_at, app, extra)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT (endpoint) DO UPDATE SET p256dh = ?2, auth = ?3, categories = ?4, frequency = ?5,
                 next_due_at = CASE WHEN frequency = ?5 THEN next_due_at ELSE ?7 END, failures = 0, app = MAX(app, ?9), extra = ?10`
        ).bind(endpoint, p256dh, auth, categories, frequency, previous?.since ?? now, nextSlot(now, frequency, sendHour(env)), now, app, extra),
    ];
    if (oldEndpoint && oldEndpoint !== endpoint) {
        statements.push(env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(oldEndpoint));
    }
    await env.DB.batch(statements);

    if (!previous) {
        ctx.waitUntil(
            Promise.all([
                countEvent(env, 'subscribed'),
                sendPush(signer(env), { endpoint, p256dh, auth }, {
                    title: 'تم تفعيل إشعارات الهلال',
                    body: frequency === 'weekly'
                        ? 'ستصلك كل جمعة أفضل المقالات الجديدة في المواضيع التي اخترتها.'
                        : 'ستصلك كل يوم أفضل المقالات الجديدة في المواضيع التي اخترتها.',
                    url: '/',
                    tag: 'welcome',
                }).catch(() => 0),
            ])
        );
    }
    return { ok: true, ...preferences({ categories, frequency, extra }) };
}

async function handleUnsubscribe(request: Request, env: Env) {
    const body = await readBody(request);
    const endpoint = validEndpoint(body.endpoint);
    const result = await env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(endpoint).run();
    if (result.meta.changes) await countEvent(env, 'unsubscribed');
    return { ok: true };
}

async function handleTest(request: Request, env: Env) {
    const body = await readBody(request);
    const endpoint = validEndpoint(body.endpoint);
    const row = await env.DB.prepare('SELECT * FROM subscriptions WHERE endpoint = ?').bind(endpoint).first<SubscriptionRow>();
    if (!row) throw new HttpError(404, 'not subscribed');
    const now = Date.now();
    if (row.last_test_at && now - row.last_test_at < TEST_INTERVAL_MS) throw new HttpError(429, 'try again in a minute');
    await env.DB.prepare('UPDATE subscriptions SET last_test_at = ? WHERE endpoint = ?').bind(now, endpoint).run();
    const status = await sendPush(signer(env), row, {
        title: 'الهلال',
        body: 'هكذا ستبدو إشعاراتك. قراءة ممتعة!',
        url: '/',
        tag: 'test',
    });
    if (status === 404 || status === 410) {
        await env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(endpoint).run();
        throw new HttpError(410, 'subscription expired');
    }
    return { ok: status >= 200 && status < 300, status };
}

async function handleSubscription(url: URL, env: Env) {
    const endpoint = validEndpoint(url.searchParams.get('endpoint'));
    const row = await env.DB.prepare('SELECT categories, frequency, extra FROM subscriptions WHERE endpoint = ?')
        .bind(endpoint)
        .first<Pick<SubscriptionRow, 'categories' | 'frequency' | 'extra'>>();
    return row ? { subscribed: true, ...preferences(row) } : { subscribed: false };
}

async function handleEvent(request: Request, env: Env) {
    const body = await readBody(request);
    if (typeof body.name !== 'string' || !EVENTS.has(body.name)) throw new HttpError(400, 'unknown event');
    await countEvent(env, body.name);
    return { ok: true };
}

/** The installed app's daily check-in: what the admin's install counts are made of. */
async function handlePing(request: Request, env: Env) {
    const body = await readBody(request);
    if (typeof body.id !== 'string' || !INSTALL_ID_RE.test(body.id)) throw new HttpError(400, 'invalid id');
    const platform = typeof body.platform === 'string' && PLATFORMS.has(body.platform) ? body.platform : 'other';
    const push = body.push === true ? 1 : 0;
    const now = Date.now();
    const day = today(now);
    const previous = await env.DB.prepare('SELECT last_seen FROM installs WHERE id = ?').bind(body.id).first<{ last_seen: number }>();
    const newDay = !previous || today(previous.last_seen) !== day;
    await env.DB.prepare(
        `INSERT INTO installs (id, platform, first_seen, last_seen, days, push) VALUES (?1, ?2, ?3, ?3, 1, ?4)
         ON CONFLICT (id) DO UPDATE SET platform = ?2, last_seen = ?3, push = ?4, days = days + ?5`
    ).bind(body.id, platform, now, push, previous && newDay ? 1 : 0).run();
    if (newDay) await countEvent(env, 'app-open');
    return { ok: true };
}

// ─── Sending ─────────────────────────────────────────────────────────────────

let cachedSigner: { jwk: string; signer: VapidSigner } | null = null;

function signer(env: Env): VapidSigner {
    if (cachedSigner?.jwk !== env.VAPID_PRIVATE_JWK) {
        cachedSigner = {
            jwk: env.VAPID_PRIVATE_JWK,
            signer: new VapidSigner({
                publicKey: env.VAPID_PUBLIC_KEY,
                privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK),
                subject: env.VAPID_SUBJECT,
            }),
        };
    }
    return cachedSigner.signer;
}

function hourVar(value: string | undefined, fallback: number): number {
    const hour = Number(value ?? fallback);
    return Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : fallback;
}

function sendHour(env: Env): number {
    return hourVar(env.SEND_HOUR_UTC, 17);
}

/** Days since the epoch, UTC: what the Explore tab deals its daily items by. */
export function dayNumber(now: number): number {
    return Math.floor(now / DAY_MS);
}

function today(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
}

/** The next send time after `now`: SEND_HOUR_UTC every day, or on Fridays. */
export function nextSlot(now: number, frequency: Frequency, hourUtc: number): number {
    const d = new Date(now);
    d.setUTCHours(hourUtc, 0, 0, 0);
    if (d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 1);
    if (frequency === 'weekly') while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
    return d.getTime();
}

function moreArticles(k: number): string {
    if (k === 1) return 'ومقال آخر';
    if (k === 2) return 'ومقالان آخران';
    if (k <= 10) return `و${k} مقالات أخرى`;
    return `و${k} مقالاً آخر`;
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')}…` : text;
}

/** The notification for one subscription, or null when nothing is new for it. */
export function digestMessage(
    digest: PushDigest,
    /** slug → when this Worker first saw it (ms) */
    seen: Map<string, number>,
    sub: Pick<SubscriptionRow, 'categories' | 'frequency' | 'since'> & { follows?: string },
    quote: FeedQuote | null = null
): Record<string, unknown> | null {
    const wanted = sub.categories === '*' ? null : new Set(sub.categories.split(',').filter(Boolean));
    const follows = new Set((sub.follows ?? '').split(',').filter(Boolean));
    const followed = (a: DigestArticle) =>
        follows.size > 0 && ((!!a.a && follows.has(`author:${a.a}`)) || (a.g ?? []).some((g) => follows.has(`tag:${g}`)));
    // Followed authors and tags first (stable: newest first within each group).
    const fresh: DigestArticle[] = digest.articles
        .filter((a) => (seen.get(a.s) ?? 0) > sub.since && (!wanted || wanted.has(a.c) || followed(a)))
        .sort((x, y) => Number(followed(y)) - Number(followed(x)));
    if (fresh.length === 0) {
        if (!quote || sub.frequency !== 'daily') return null;
        return {
            title: 'الهلال — اقتباس اليوم',
            body: `❝ ${clip(quote.text, 140)}\n— ${quote.title}`,
            url: '/explore/?utm_source=push&utm_medium=quote',
            count: 0,
            tag: 'digest',
        };
    }

    // The notification is about its top article: its title, its preview, its
    // cover, and a tap opens it. The rest of the digest is one action away.
    const top = fresh[0]!;
    const categories = [...new Set(fresh.map((a) => a.c))];
    const utm = `utm_source=push&utm_medium=${sub.frequency}`;
    const listing = categories.length === 1 ? `/${categories[0]}/?${utm}` : `/?${utm}`;
    const where = categories.length === 1 && digest.categories[categories[0]!] ? ` في ${digest.categories[categories[0]!]}` : '';
    const lines = [followed(top) && top.a ? `⭐ @${top.a} · ${top.p ?? ''}` : top.p ?? digest.categories[top.c] ?? ''];
    if (fresh.length > 1) lines.push(`📚 ${moreArticles(fresh.length - 1)}${where}`);
    else if (quote) lines.push(`❝ ${clip(quote.text, 80)} — ${quote.title}`);
    return {
        title: top.t,
        body: lines.filter(Boolean).join('\n'),
        url: `/articles/${encodeURIComponent(top.s)}/?${utm}`,
        image: top.i,
        count: fresh.length,
        tag: 'digest',
        actions: [
            { action: 'read', title: 'اقرأ المقال' },
            ...(fresh.length > 1 ? [{ action: 'more', title: `كل الجديد (${fresh.length})`, url: listing }] : []),
        ],
    };
}

/**
 * Records the digest's articles in articles_seen and returns when each was
 * first seen. On the very first run everything counts as old, so the first
 * digests don't announce two weeks of articles.
 */
async function markSeen(env: Env, digest: PushDigest, now: number): Promise<Map<string, number>> {
    const slugs = JSON.stringify(digest.articles.map((a) => a.s));
    const empty = !(await env.DB.prepare('SELECT 1 FROM articles_seen LIMIT 1').first());
    const [, rows] = await env.DB.batch<{ slug: string; first_seen_at: number }>([
        env.DB.prepare('INSERT OR IGNORE INTO articles_seen (slug, first_seen_at) SELECT value, ? FROM json_each(?)').bind(empty ? 0 : now, slugs),
        env.DB.prepare('SELECT slug, first_seen_at FROM articles_seen WHERE slug IN (SELECT value FROM json_each(?))').bind(slugs),
        env.DB.prepare('DELETE FROM articles_seen WHERE first_seen_at > 0 AND first_seen_at < ?').bind(now - SEEN_RETENTION_DAYS * DAY_MS),
    ]);
    return new Map(rows!.results.map((r) => [r.slug, r.first_seen_at]));
}

async function fetchDigest(env: Env): Promise<PushDigest | null> {
    const url = `${env.SITE_URL}/_data/push-digest.json`;
    try {
        const res = env.SITE ? await env.SITE.fetch(url) : await fetch(url);
        return res.ok ? ((await res.json()) as PushDigest) : null;
    } catch {
        return null;
    }
}

/** Today's item of a sister site's feed, the same one the app's Explore tab shows (src/pages/explore.astro). */
async function fetchFeedItem<T>(site: string, service: Fetcher | undefined, now: number): Promise<T | null> {
    const url = `https://${site}.elhellal.com/app-feed.json`;
    try {
        const res = service ? await service.fetch(url) : await fetch(url);
        if (!res.ok) return null;
        const items = ((await res.json()) as { items?: T[] }).items ?? [];
        return items.length ? items[dayNumber(now) % items.length]! : null;
    } catch {
        return null;
    }
}

function fetchQuote(env: Env, now: number): Promise<FeedQuote | null> {
    return fetchFeedItem<FeedQuote>('quotes', env.QUOTES, now);
}

export function streakReminder(streak: number): Record<string, unknown> {
    return {
        title: `🔥 ${streak} أيام متتالية`,
        body: 'لم تجب عن سؤال اليوم بعد. أجب قبل منتصف الليل لتبقى سلسلتك.',
        url: '/explore/?utm_source=push&utm_medium=quiz#quiz',
        tag: 'quiz-streak',
    };
}

/** Records an answer to the question of the day; the streak grows on consecutive days. */
async function handleQuiz(request: Request, env: Env) {
    const body = await readBody(request);
    const endpoint = validEndpoint(body.endpoint);
    const day = body.day;
    // The reader's local day: within a day of UTC's.
    if (typeof day !== 'number' || !Number.isInteger(day) || Math.abs(day - dayNumber(Date.now())) > 1) throw new HttpError(400, 'invalid day');
    const result = await env.DB.prepare(
        `UPDATE subscriptions SET
            quiz_streak = CASE WHEN quiz_day = ?1 THEN quiz_streak WHEN quiz_day = ?1 - 1 THEN quiz_streak + 1 ELSE 1 END,
            quiz_day = ?1
         WHERE endpoint = ?2 AND quiz_day <= ?1`
    ).bind(day, endpoint).run();
    await countEvent(env, 'quiz-answered');
    return { ok: true, recorded: result.meta.changes > 0 };
}

function daysWord(n: number): string {
    if (n === 2) return 'يومان';
    return n <= 10 ? `${n} أيام` : `${n} يوماً`;
}

/** Evening nudge before a reading streak breaks: one short article to keep it. */
export function readingReminder(streak: number, article: DigestArticle | null): Record<string, unknown> {
    const minutes = article?.m ? ` (${article.m} د)` : '';
    return {
        title: `🔥 ${daysWord(streak)} متتالية`,
        body: article ? `مقال واحد يحفظ سلسلتك: «${clip(article.t, 70)}»${minutes}` : 'لم تقرأ اليوم بعد. مقال واحد يحفظ سلسلتك.',
        url: article ? `/articles/${encodeURIComponent(article.s)}/?utm_source=push&utm_medium=streak` : '/today/?utm_source=push&utm_medium=streak',
        image: article?.i,
        tag: 'reading-streak',
        actions: [{ action: 'today', title: 'ورد اليوم', url: '/today/?utm_source=push&utm_medium=streak' }],
    };
}

/** The shortest recent article in the subscriber's topics: what a streak reminder offers. */
export function quickRead(digest: PushDigest, categories: string): DigestArticle | null {
    const wanted = categories === '*' ? null : new Set(categories.split(',').filter(Boolean));
    const pool = digest.articles.slice(0, 120).filter((a) => !wanted || wanted.has(a.c));
    return pool.filter((a) => a.m).sort((a, b) => a.m! - b.m!)[0] ?? pool[0] ?? null;
}

/** The evening nudge without a streak to keep: a short read before bed. */
export function eveningRead(article: DigestArticle): Record<string, unknown> {
    const minutes = article.m ? ` · ${article.m} د` : '';
    return {
        title: article.t,
        body: `🌙 قراءة قصيرة لهذا المساء${minutes}${article.p ? `\n${article.p}` : ''}`,
        url: `/articles/${encodeURIComponent(article.s)}/?utm_source=push&utm_medium=evening`,
        image: article.i,
        tag: 'evening',
        actions: [{ action: 'today', title: 'ورد اليوم', url: '/today/?utm_source=push&utm_medium=evening' }],
    };
}

/**
 * The morning article: one of the recent articles in the subscriber's topics,
 * a different one each day, with a cover when there is one, and not the
 * evening's short read.
 */
export function morningPick(digest: PushDigest, categories: string, day: number): DigestArticle | null {
    const wanted = categories === '*' ? null : new Set(categories.split(',').filter(Boolean));
    const evening = quickRead(digest, categories)?.s;
    const pool = digest.articles.slice(0, 120).filter((a) => (!wanted || wanted.has(a.c)) && a.s !== evening);
    const covered = pool.filter((a) => a.i).slice(0, 30);
    const from = covered.length ? covered : pool.slice(0, 30);
    return from.length ? from[day % from.length]! : null;
}

export function morningRead(article: DigestArticle): Record<string, unknown> {
    const minutes = article.m ? ` · ${article.m} د` : '';
    return {
        title: article.t,
        body: `☀️ مقال الصباح${minutes}${article.p ? `\n${article.p}` : ''}`,
        url: `/articles/${encodeURIComponent(article.s)}/?utm_source=push&utm_medium=morning`,
        image: article.i,
        tag: 'morning',
        actions: [{ action: 'today', title: 'ورد اليوم', url: '/today/?utm_source=push&utm_medium=morning' }],
    };
}

export function quoteMessage(quote: FeedQuote): Record<string, unknown> {
    return {
        title: 'اقتباس اليوم',
        body: `❝ ${clip(quote.text, 160)}\n— ${quote.title}`,
        url: '/explore/?utm_source=push&utm_medium=quote',
        tag: 'quote',
    };
}

export function quizMessage(quiz: FeedQuiz): Record<string, unknown> {
    const options = (quiz.options ?? []).join(' · ');
    return {
        title: '❓ سؤال اليوم',
        body: `${clip(quiz.title, 120)}${options ? `\n${clip(options, 100)}` : ''}`,
        url: '/explore/?utm_source=push&utm_medium=quiz#quiz',
        tag: 'quiz',
    };
}

export function weeklyRecap(
    row: { week_reads: number; week_minutes: number; week_top: string; read_streak: number },
    categories: Record<string, string>
): Record<string, unknown> {
    const parts = [`📖 ${row.week_reads} مقالات`, `⏱ ${row.week_minutes} دقيقة`];
    if (row.week_top && categories[row.week_top]) parts.push(`أكثر ما قرأت: ${categories[row.week_top]}`);
    return {
        title: 'أسبوعك على الهلال',
        body: `${parts.join(' · ')}${row.read_streak >= 2 ? `\n🔥 سلسلتك: ${daysWord(row.read_streak)}` : ''}`,
        url: '/me/?utm_source=push&utm_medium=recap#recap',
        tag: 'recap',
    };
}

/** Records today's read: the streak as the app counts it, and the last 7 days' numbers. */
async function handleRead(request: Request, env: Env) {
    const body = await readBody(request);
    const endpoint = validEndpoint(body.endpoint);
    const day = body.day;
    if (typeof day !== 'number' || !Number.isInteger(day) || Math.abs(day - dayNumber(Date.now())) > 1) throw new HttpError(400, 'invalid day');
    const int = (v: unknown, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : 0);
    const week = (body.week ?? {}) as Record<string, unknown>;
    const top = typeof week.top === 'string' && CATEGORY_RE.test(week.top) ? week.top : '';
    const result = await env.DB.prepare(
        `UPDATE subscriptions SET read_day = MAX(read_day, ?1), read_streak = ?2, week_reads = ?3, week_minutes = ?4, week_top = ?5
         WHERE endpoint = ?6`
    ).bind(day, int(body.streak, 5000), int(week.reads, 1000), int(week.minutes, 100_000), top, endpoint).run();
    await countEvent(env, 'read');
    return { ok: true, recorded: result.meta.changes > 0 };
}

async function handleFollows(request: Request, env: Env) {
    const body = await readBody(request);
    const endpoint = validEndpoint(body.endpoint);
    const list = body.follows;
    if (!Array.isArray(list) || list.length > MAX_FOLLOWS || !list.every((f) => typeof f === 'string' && FOLLOW_RE.test(f))) {
        throw new HttpError(400, 'invalid follows');
    }
    const follows = list.length ? `,${[...new Set(list as string[])].sort().join(',')},` : '';
    const result = await env.DB.prepare('UPDATE subscriptions SET follows = ? WHERE endpoint = ?').bind(follows, endpoint).run();
    return { ok: true, recorded: result.meta.changes > 0 };
}

async function handleSuggest(request: Request, env: Env) {
    const body = await readBody(request);
    let url: URL;
    try {
        url = new URL(String(body.url ?? ''));
    } catch {
        throw new HttpError(400, 'invalid url');
    }
    if (!/^https?:$/.test(url.protocol) || url.href.length > 500) throw new HttpError(400, 'invalid url');
    url.hash = '';
    // Share sheets add tracking parameters; the same post should count once.
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|r$|s$|triedRedirect$)/.test(key)) url.searchParams.delete(key);
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
    await env.DB.prepare(
        `INSERT INTO suggestions (url, title, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (url) DO UPDATE SET n = n + 1, title = CASE WHEN title = '' THEN ?2 ELSE title END`
    ).bind(url.href, title, Date.now()).run();
    await countEvent(env, 'suggested');
    return { ok: true };
}

async function run(env: Env) {
    const now = Date.now();
    const batch = Math.max(1, Math.min(45, Number(env.PUSH_BATCH) || 40));
    const hour = sendHour(env);
    const jobs: Job[] = [];

    // Feeds are fetched only when someone needs them: a subrequest each otherwise.
    const once = <T>(load: () => Promise<T>) => {
        let value: Promise<T> | undefined;
        return () => (value ??= load());
    };
    const feeds = {
        digest: once(() => fetchDigest(env)),
        quote: once(() => fetchQuote(env, now)),
        quiz: once(() => fetchFeedItem<FeedQuiz>('quiz', env.QUIZ, now)),
    };

    const due = (
        await env.DB.prepare('SELECT * FROM subscriptions WHERE next_due_at <= ? ORDER BY next_due_at LIMIT ?').bind(now, batch).all<SubscriptionRow>()
    ).results;
    if (due.length) {
        // Claim the rows first, so a run cut short never sends a digest twice.
        await env.DB.batch(
            due.map((s) => env.DB.prepare('UPDATE subscriptions SET next_due_at = ? WHERE endpoint = ?').bind(nextSlot(now, s.frequency, hour), s.endpoint))
        );
        const [digest, quote] = await Promise.all([feeds.digest(), feeds.quote()]);
        if (digest) {
            const seen = await markSeen(env, digest, now);
            for (const sub of due) {
                // "More notifications" subscribers had the quote at noon: no quote-only digest.
                const payload = digestMessage(digest, seen, sub, sub.extra ? null : quote);
                if (payload) jobs.push({ target: sub, payload, topic: 'digest', digest: true });
            }
        }
    }

    const day = dayNumber(now);
    const utcHour = new Date(now).getUTCHours();
    /** Sends `message` to the rows `sql` selects (?1 = day, ?2 = limit), claimed by `claim` first, like the digests. */
    const send = async <T extends PushTarget>(
        sql: string,
        claim: string,
        message: (row: T) => Promise<Record<string, unknown> | null>,
        topic: string
    ) => {
        if (jobs.length >= batch) return;
        const rows = (await env.DB.prepare(sql).bind(day, batch - jobs.length).all<T>()).results;
        if (!rows.length) return;
        await env.DB.batch(rows.map((r) => env.DB.prepare(claim).bind(day, r.endpoint)));
        for (const r of rows) {
            const payload = await message(r);
            if (payload) jobs.push({ target: r, payload, topic });
        }
    };
    // One nudge a day at most (nudged_day).
    const NUDGED = 'UPDATE subscriptions SET nudged_day = ?1, quiz_reminded = ?1 WHERE endpoint = ?2';

    if (new Date(now).getUTCDay() === 5 && utcHour === hourVar(env.RECAP_HOUR_UTC, 9)) {
        await send<PushTarget & { week_reads: number; week_minutes: number; week_top: string; read_streak: number }>(
            `SELECT endpoint, p256dh, auth, week_reads, week_minutes, week_top, read_streak FROM subscriptions
             WHERE read_day >= ?1 - 1 AND week_reads > 0 AND nudged_day < ?1 LIMIT ?2`,
            NUDGED,
            async (r) => weeklyRecap(r, (await feeds.digest())?.categories ?? {}),
            'recap'
        );
    }

    if (utcHour === hourVar(env.REMIND_HOUR_UTC, 19)) {
        await send<PushTarget & { read_streak: number; categories: string }>(
            `SELECT endpoint, p256dh, auth, read_streak, categories FROM subscriptions
             WHERE read_day = ?1 - 1 AND read_streak >= 2 AND nudged_day < ?1 LIMIT ?2`,
            NUDGED,
            async (r) => {
                const digest = await feeds.digest();
                return readingReminder(r.read_streak, digest ? quickRead(digest, r.categories) : null);
            },
            'streak'
        );
        await send<PushTarget & { quiz_streak: number }>(
            `SELECT endpoint, p256dh, auth, quiz_streak FROM subscriptions
             WHERE quiz_day = ?1 - 1 AND quiz_streak >= 2 AND quiz_reminded < ?1 AND nudged_day < ?1 LIMIT ?2`,
            NUDGED,
            async (r) => streakReminder(r.quiz_streak),
            'quiz'
        );
        // No streak to keep: daily subscribers still get their second notification.
        await send<PushTarget & { categories: string }>(
            `SELECT endpoint, p256dh, auth, categories FROM subscriptions
             WHERE frequency = 'daily' AND nudged_day < ?1 LIMIT ?2`,
            NUDGED,
            async (r) => {
                const digest = await feeds.digest();
                const article = digest ? quickRead(digest, r.categories) : null;
                return article ? eveningRead(article) : null;
            },
            'evening'
        );
    }

    // "More notifications": each extra slot once a day (a bit of extra_sent).
    const extra = <T extends PushTarget>(bit: number, where: string, message: (row: T) => Promise<Record<string, unknown> | null>, topic: string) =>
        send<T>(
            `SELECT endpoint, p256dh, auth, categories FROM subscriptions
             WHERE extra = 1 AND frequency = 'daily' AND NOT (extra_day = ?1 AND extra_sent & ${bit}) ${where} LIMIT ?2`,
            `UPDATE subscriptions SET extra_sent = CASE WHEN extra_day = ?1 THEN extra_sent | ${bit} ELSE ${bit} END, extra_day = ?1 WHERE endpoint = ?2`,
            message,
            topic
        );
    if (utcHour === hourVar(env.MORNING_HOUR_UTC, 6)) {
        await extra<PushTarget & { categories: string }>(
            EXTRA_MORNING,
            '',
            async (r) => {
                const digest = await feeds.digest();
                const article = digest ? morningPick(digest, r.categories, day) : null;
                return article ? morningRead(article) : null;
            },
            'morning'
        );
    }
    if (utcHour === hourVar(env.QUOTE_HOUR_UTC, 11)) {
        await extra(EXTRA_QUOTE, '', async () => {
            const quote = await feeds.quote();
            return quote ? quoteMessage(quote) : null;
        }, 'quote');
    }
    if (utcHour === hourVar(env.QUIZ_HOUR_UTC, 14)) {
        // Not to those who already answered today's question.
        await extra(EXTRA_QUIZ, 'AND quiz_day < ?1', async () => {
            const quiz = await feeds.quiz();
            return quiz ? quizMessage(quiz) : null;
        }, 'quiz');
    }

    const room = batch - jobs.length;
    if (room > 0) {
        const queued = (
            await env.DB.prepare(
                `SELECT o.id, o.payload, s.endpoint, s.p256dh, s.auth FROM outbox o
                 JOIN subscriptions s ON s.endpoint = o.endpoint ORDER BY o.id LIMIT ?`
            ).bind(room).all<{ id: number; payload: string } & PushTarget>()
        ).results;
        await env.DB.batch([
            ...queued.map((q) => env.DB.prepare('DELETE FROM outbox WHERE id = ?').bind(q.id)),
            // Messages for subscriptions that have since gone away.
            env.DB.prepare('DELETE FROM outbox WHERE endpoint NOT IN (SELECT endpoint FROM subscriptions)'),
        ]);
        for (const q of queued) jobs.push({ target: q, payload: JSON.parse(q.payload) });
    }
    if (!jobs.length) return;

    const sendSigner = signer(env);
    const statuses = await Promise.all(
        jobs.map((job) =>
            sendPush(sendSigner, job.target, job.payload, { topic: job.topic, ttl: 12 * 3600 }).catch(() => 0)
        )
    );

    const updates: D1PreparedStatement[] = [];
    let sent = 0;
    let gone = 0;
    let failed = 0;
    jobs.forEach((job, i) => {
        const status = statuses[i]!;
        const endpoint = job.target.endpoint;
        if (status >= 200 && status < 300) {
            sent++;
            updates.push(
                job.digest
                    ? env.DB.prepare('UPDATE subscriptions SET last_sent_at = ?, since = ?, failures = 0 WHERE endpoint = ?').bind(now, now, endpoint)
                    : env.DB.prepare('UPDATE subscriptions SET failures = 0 WHERE endpoint = ?').bind(endpoint)
            );
        } else if (status === 404 || status === 410) {
            gone++;
            updates.push(env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(endpoint));
        } else {
            failed++;
            updates.push(env.DB.prepare('UPDATE subscriptions SET failures = failures + 1 WHERE endpoint = ?').bind(endpoint));
        }
    });
    updates.push(env.DB.prepare('DELETE FROM subscriptions WHERE failures >= ?').bind(MAX_FAILURES));
    const date = today(now);
    for (const [name, n] of [['sent', sent], ['gone', gone], ['failed', failed]] as const) {
        if (n) {
            updates.push(
                env.DB.prepare('INSERT INTO events (day, name, n) VALUES (?, ?, ?) ON CONFLICT (day, name) DO UPDATE SET n = n + excluded.n').bind(date, name, n)
            );
        }
    }
    await env.DB.batch(updates);
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const origin = request.headers.get('Origin');
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
        const url = new URL(request.url);
        const route = `${request.method} ${url.pathname.replace(/\/$/, '')}`;
        try {
            switch (route) {
                case 'GET /api/push/key':
                    return json({ key: env.VAPID_PUBLIC_KEY }, 200, origin, { 'Cache-Control': 'public, max-age=3600' });
                case 'GET /api/push/subscription':
                    return json(await handleSubscription(url, env), 200, origin);
                case 'POST /api/push/subscribe':
                    return json(await handleSubscribe(request, env, ctx), 200, origin);
                case 'POST /api/push/unsubscribe':
                    return json(await handleUnsubscribe(request, env), 200, origin);
                case 'POST /api/push/test':
                    return json(await handleTest(request, env), 200, origin);
                case 'POST /api/push/event':
                    return json(await handleEvent(request, env), 200, origin);
                case 'POST /api/push/ping':
                    return json(await handlePing(request, env), 200, origin);
                case 'POST /api/push/quiz':
                    return json(await handleQuiz(request, env), 200, origin);
                case 'POST /api/push/read':
                    return json(await handleRead(request, env), 200, origin);
                case 'POST /api/push/follows':
                    return json(await handleFollows(request, env), 200, origin);
                case 'POST /api/push/suggest':
                    return json(await handleSuggest(request, env), 200, origin);
                default:
                    return json({ error: 'not found' }, 404, origin);
            }
        } catch (err) {
            if (err instanceof HttpError) return json({ error: err.message }, err.status, origin);
            console.error(err);
            return json({ error: 'internal error' }, 500, origin);
        }
    },

    async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
        ctx.waitUntil(run(env));
    },
} satisfies ExportedHandler<Env>;
