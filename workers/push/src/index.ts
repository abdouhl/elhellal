/**
 * Push notifications for elhellal.com (route: elhellal.com/api/push/*).
 *
 *   GET  /api/push/key            VAPID public key for pushManager.subscribe()
 *   GET  /api/push/subscription   ?endpoint= → the stored preferences
 *   POST /api/push/subscribe      { subscription, categories, frequency, oldEndpoint? }
 *   POST /api/push/unsubscribe    { endpoint }
 *   POST /api/push/test           { endpoint } → one test notification (1/min)
 *   POST /api/push/event          { name } → daily counter (installs, clicks…)
 *
 * The cron trigger (every 5 minutes) sends:
 *   1. digests: each subscription is due at SEND_HOUR_UTC daily, or on
 *      Fridays when weekly. Its notification lists the articles of its
 *      categories that appeared on the site since its last digest, read from
 *      dist/_data/push-digest.json (src/lib/push-digest.ts). "Appeared" is
 *      when this Worker first saw an article in the digest (articles_seen),
 *      not its created_at: imports trail publication by days, and dating by
 *      created_at would skip whatever arrived late. Nothing new → nothing sent.
 *   2. the outbox: one-off messages the admin panel queues (scripts/admin.ts).
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
}

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
const EVENTS = new Set([
    'installed',
    'install-accepted',
    'install-dismissed',
    'banner-dismissed',
    'cta-clicked',
    'link-clicked',
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

function preferences(row: Pick<SubscriptionRow, 'categories' | 'frequency'>) {
    return {
        categories: row.categories === '*' ? '*' : row.categories.split(',').filter(Boolean),
        frequency: row.frequency,
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
    const previous = await env.DB.prepare('SELECT categories, frequency, since FROM subscriptions WHERE endpoint IN (?, ?)')
        .bind(endpoint, oldEndpoint ?? endpoint)
        .first<Pick<SubscriptionRow, 'categories' | 'frequency' | 'since'>>();
    const categories = body.categories === undefined && previous ? previous.categories : parseCategories(body.categories);
    const frequency = body.frequency === undefined && previous ? previous.frequency : parseFrequency(body.frequency);

    const now = Date.now();
    const statements = [
        env.DB.prepare(
            `INSERT INTO subscriptions (endpoint, p256dh, auth, categories, frequency, since, next_due_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT (endpoint) DO UPDATE SET p256dh = ?2, auth = ?3, categories = ?4, frequency = ?5,
                 next_due_at = CASE WHEN frequency = ?5 THEN next_due_at ELSE ?7 END, failures = 0`
        ).bind(endpoint, p256dh, auth, categories, frequency, previous?.since ?? now, nextSlot(now, frequency, sendHour(env)), now),
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
    return { ok: true, ...preferences({ categories, frequency }) };
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
    const row = await env.DB.prepare('SELECT categories, frequency FROM subscriptions WHERE endpoint = ?')
        .bind(endpoint)
        .first<Pick<SubscriptionRow, 'categories' | 'frequency'>>();
    return row ? { subscribed: true, ...preferences(row) } : { subscribed: false };
}

async function handleEvent(request: Request, env: Env) {
    const body = await readBody(request);
    if (typeof body.name !== 'string' || !EVENTS.has(body.name)) throw new HttpError(400, 'unknown event');
    await countEvent(env, body.name);
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

function sendHour(env: Env): number {
    const hour = Number(env.SEND_HOUR_UTC ?? 17);
    return Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : 17;
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

/** The notification for one subscription, or null when nothing is new for it. */
export function digestMessage(
    digest: PushDigest,
    /** slug → when this Worker first saw it (ms) */
    seen: Map<string, number>,
    sub: Pick<SubscriptionRow, 'categories' | 'frequency' | 'since'>
): Record<string, unknown> | null {
    const wanted = sub.categories === '*' ? null : new Set(sub.categories.split(',').filter(Boolean));
    const fresh: DigestArticle[] = digest.articles.filter(
        (a) => (seen.get(a.s) ?? 0) > sub.since && (!wanted || wanted.has(a.c))
    );
    if (fresh.length === 0) return null;

    const top = fresh[0]!;
    const categories = [...new Set(fresh.map((a) => a.c))];
    const utm = `utm_source=push&utm_medium=${sub.frequency}`;
    const url = fresh.length === 1
        ? `/articles/${encodeURIComponent(top.s)}/?${utm}`
        : categories.length === 1
            ? `/${categories[0]}/?${utm}`
            : `/?${utm}`;
    const where = categories.length === 1 && digest.categories[categories[0]!] ? ` في ${digest.categories[categories[0]!]}` : '';
    return {
        title: sub.frequency === 'weekly' ? `الهلال — مختارات الأسبوع${where}` : `الهلال — جديد اليوم${where}`,
        body: fresh.length === 1 ? top.t : `${top.t}\n${moreArticles(fresh.length - 1)}`,
        url,
        image: top.i,
        count: fresh.length,
        tag: 'digest',
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

async function run(env: Env) {
    const now = Date.now();
    const batch = Math.max(1, Math.min(45, Number(env.PUSH_BATCH) || 40));
    const hour = sendHour(env);
    const jobs: Job[] = [];

    const due = (
        await env.DB.prepare('SELECT * FROM subscriptions WHERE next_due_at <= ? ORDER BY next_due_at LIMIT ?').bind(now, batch).all<SubscriptionRow>()
    ).results;
    if (due.length) {
        // Claim the rows first, so a run cut short never sends a digest twice.
        await env.DB.batch(
            due.map((s) => env.DB.prepare('UPDATE subscriptions SET next_due_at = ? WHERE endpoint = ?').bind(nextSlot(now, s.frequency, hour), s.endpoint))
        );
        const digest = await fetchDigest(env);
        if (digest) {
            const seen = await markSeen(env, digest, now);
            for (const sub of due) {
                const payload = digestMessage(digest, seen, sub);
                if (payload) jobs.push({ target: sub, payload, topic: 'digest', digest: true });
            }
        }
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
    const day = today(now);
    for (const [name, n] of [['sent', sent], ['gone', gone], ['failed', failed]] as const) {
        if (n) {
            updates.push(
                env.DB.prepare('INSERT INTO events (day, name, n) VALUES (?, ?, ?) ON CONFLICT (day, name) DO UPDATE SET n = n + excluded.n').bind(day, name, n)
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
