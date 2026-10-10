#!/usr/bin/env bun
/**
 * Local admin panel for the catalog: search, edit, move and remove articles,
 * block authors, and settle the moderation script's "review" verdicts. Its Pins
 * tab runs scripts/generate-pinterest-pin.ts --storage r2 (generate, --fix,
 * --remove) and shows what's in the R2 bucket; its Import tab runs
 * scripts/import-substack2.ts and scripts/import-external-blogs.ts, picking
 * Substack authors from a list filled by hand or by scripts/discover-substack.ts.
 * Health lists check-data's problems per article; Publish runs check-data,
 * build and wrangler deploy and commits the data changes; Social runs the X /
 * LinkedIn schedulers and TikTok generators and deletes the media they wrote; Stats charts the catalog.
 * Sites does the same for the sibling repos (../elhellal-quotes, -books,
 * -biographies, -quiz): edit their data, run their scripts, build, deploy, commit;
 * and for ../abderahmane, whose deploy is a push to main (Cloudflare builds from GitHub).
 * Leads manages the abderahmane blog's /functional-food-leads queue: pick leads to
 * write (opens an interactive Claude Code session), edit / remove / deploy the
 * articles, copy them for X and record X links.
 *
 *   bun run admin                # http://localhost:4322
 *   bun run admin --port 5000
 *
 * Local only — it binds to 127.0.0.1 and has no login. Every change goes
 * straight to the files in src/data/catalog/ and src/data/moderation/, so
 * review it with `git diff`, then `bun run check-data`, commit and deploy.
 *
 * Removing an article or author also adds it to src/data/moderation/blocklist.json,
 * which the importers respect, so removed content never comes back.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Article, ArticlesConfig } from '../src/types/index.ts';
import { bucketFiles, bucketOf, readArticles, writeArticles } from '../src/lib/articles-store.ts';
import {
    loadBlocklist,
    loadOverrides,
    loadVerdicts,
    saveBlocklist,
    saveOverrides,
} from './lib/moderation.ts';

const portArg = process.argv.indexOf('--port');
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 4322;
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const PAGE = fileURLToPath(new URL('admin/index.html', import.meta.url));
const SITE = 'https://elhellal.com';

// ─── Catalog cache ────────────────────────────────────────────────────────────

let data: ArticlesConfig = readArticles();
let loadedAt = Date.now();

function reload() {
    data = readArticles();
    loadedAt = Date.now();
}

/**
 * Applies `change` to a fresh read of the catalog and writes it back, so an
 * importer's writes since the last load aren't overwritten with stale data.
 */
function mutate<T>(change: (d: ArticlesConfig) => T): T {
    // An importer writes back the catalog it read at startup, which would undo this change.
    if (importSlot.proc || otherImports().length) {
        throw new HttpError(409, 'An import is running and would overwrite this change — wait for it to finish');
    }
    // `bun run build` / add-slugs rewrite the catalog too.
    if (publishSlot.proc && WRITES_CATALOG.has(publishSlot.job?.mode ?? '')) {
        throw new HttpError(409, 'A build is running and rewrites the catalog — wait for it to finish');
    }
    reload();
    const result = change(data);
    writeArticles(data);
    loadedAt = Date.now();
    return result;
}

interface Row {
    category: string;
    article: Article;
}

const rows = (): Row[] => data.articles.flatMap((c) => c.content.map((article) => ({ category: c.category, article })));

function find(d: ArticlesConfig, id: string): { cat: ArticlesConfig['articles'][number]; index: number } | null {
    for (const cat of d.articles) {
        const index = cat.content.findIndex((a) => a.id_str === id);
        if (index > -1) return { cat, index };
    }
    return null;
}

/** Removals made since the server started, so they can be undone. */
const trash = new Map<string, Row>();

function today() {
    return new Date().toISOString().slice(0, 10);
}

/** Removes the articles from `d` and blocklists them. Returns how many were removed. */
function removeArticles(d: ArticlesConfig, ids: Set<string>, note: string): number {
    const blocklist = loadBlocklist();
    const blocked = new Set(blocklist.articles.map((a) => a.id_str));
    let removed = 0;
    for (const cat of d.articles) {
        cat.content = cat.content.filter((a) => {
            if (!ids.has(a.id_str)) return true;
            removed++;
            trash.set(a.id_str, { category: cat.category, article: a });
            if (!blocked.has(a.id_str)) {
                blocklist.articles.push({
                    id_str: a.id_str,
                    url: a.url,
                    title: a.title,
                    screen_name: a.screen_name,
                    reasons: [],
                    note: note || undefined,
                    removed_at: today(),
                });
                blocked.add(a.id_str);
            }
            return false;
        });
    }
    saveBlocklist(blocklist);
    return removed;
}

// ─── API ──────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

function summary(r: Row) {
    const a = r.article;
    return {
        category: r.category,
        id_str: a.id_str,
        title: a.title,
        preview_text: a.preview_text,
        screen_name: a.screen_name,
        created_at: a.created_at,
        url: a.url,
        original_img_url: a.original_img_url,
        slug: a.slug,
        live: a.slug ? `${SITE}/articles/${encodeURIComponent(a.slug)}/` : undefined,
    };
}

function listArticles(params: URLSearchParams) {
    const q = (params.get('q') ?? '').trim().toLowerCase();
    const category = params.get('category') ?? '';
    const author = params.get('author') ?? '';
    const sort = params.get('sort') ?? 'newest';
    const page = Math.max(1, Number(params.get('page')) || 1);

    let list = rows().filter(
        (r) =>
            (!category || r.category === category) &&
            (!author || r.article.screen_name === author) &&
            (!q ||
                r.article.title.toLowerCase().includes(q) ||
                r.article.screen_name.toLowerCase().includes(q) ||
                r.article.id_str === q ||
                (r.article.url ?? '').toLowerCase().includes(q)),
    );
    if (sort === 'newest') list.sort((a, b) => b.article.created_at.localeCompare(a.article.created_at));
    else if (sort === 'oldest') list.sort((a, b) => a.article.created_at.localeCompare(b.article.created_at));
    // 'title' is the catalog's own order.

    return {
        total: list.length,
        page,
        pages: Math.max(1, Math.ceil(list.length / PAGE_SIZE)),
        items: list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(summary),
    };
}

function listAuthors(params: URLSearchParams) {
    const q = (params.get('q') ?? '').trim().toLowerCase();
    const blocked = new Set(loadBlocklist().authors);
    const byName = new Map<string, { screen_name: string; count: number; latest: string; categories: Set<string>; image?: string | undefined }>();
    for (const r of rows()) {
        const a = r.article;
        let entry = byName.get(a.screen_name);
        if (!entry) {
            entry = { screen_name: a.screen_name, count: 0, latest: '', categories: new Set() };
            byName.set(a.screen_name, entry);
        }
        entry.count++;
        entry.categories.add(r.category);
        if (a.created_at > entry.latest) entry.latest = a.created_at;
        entry.image ??= a.profile_image_url_https;
    }
    const list = [...byName.values()]
        .filter((e) => !q || e.screen_name.toLowerCase().includes(q))
        .sort((a, b) => b.count - a.count)
        .slice(0, 200)
        .map((e) => ({ ...e, categories: [...e.categories], blocked: blocked.has(e.screen_name) }));
    return { total: byName.size, items: list };
}

function listReview() {
    const verdicts = loadVerdicts();
    const overrides = loadOverrides();
    const items = rows()
        .filter((r) => verdicts[r.article.id_str]?.decision === 'review' && !overrides[r.article.id_str])
        .map((r) => ({ ...summary(r), verdict: verdicts[r.article.id_str] }));
    return { total: items.length, items: items.slice(0, 100) };
}

function listBlocked() {
    const b = loadBlocklist();
    return {
        authors: b.authors,
        articles: [...b.articles].reverse().slice(0, 300).map((a) => ({ ...a, restorable: trash.has(a.id_str) })),
        totalArticles: b.articles.length,
    };
}

function stats() {
    const b = loadBlocklist();
    return {
        articles: data.articles.reduce((n, c) => n + c.content.length, 0),
        categories: data.articles.map((c) => ({ category: c.category, title: c.title, count: c.content.length })),
        blockedArticles: b.articles.length,
        blockedAuthors: b.authors.length,
        loadedAt,
    };
}

type Body = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const ids = (v: unknown) => new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function removeAction(body: Body) {
    const set = ids(body.ids);
    if (!set.size) throw new HttpError(400, 'No ids');
    const removed = mutate((d) => removeArticles(d, set, str(body.note)));
    return { removed };
}

function blockAuthor(body: Body) {
    const name = str(body.screen_name);
    if (!name) throw new HttpError(400, 'No screen_name');
    const removed = mutate((d) => {
        const set = new Set(d.articles.flatMap((c) => c.content.filter((a) => a.screen_name === name).map((a) => a.id_str)));
        const n = removeArticles(d, set, `author @${name} blocked`);
        const blocklist = loadBlocklist();
        if (!blocklist.authors.includes(name)) blocklist.authors.push(name);
        saveBlocklist(blocklist);
        return n;
    });
    return { removed };
}

function unblockAuthor(body: Body) {
    const name = str(body.screen_name);
    const blocklist = loadBlocklist();
    blocklist.authors = blocklist.authors.filter((a) => a !== name);
    saveBlocklist(blocklist);
    return { ok: true };
}

/** Takes the article off the blocklist and, if it was removed in this session, puts it back. */
function restoreArticle(body: Body) {
    const id = str(body.id_str);
    const blocklist = loadBlocklist();
    blocklist.articles = blocklist.articles.filter((a) => a.id_str !== id);
    saveBlocklist(blocklist);
    const row = trash.get(id);
    if (!row) return { restored: false };
    mutate((d) => {
        if (find(d, id)) return;
        const cat = d.articles.find((c) => c.category === row.category) ?? d.articles[0]!;
        cat.content.push(row.article);
    });
    trash.delete(id);
    return { restored: true };
}

const EDITABLE = ['title', 'preview_text', 'original_img_url', 'created_at'] as const;

function editArticle(body: Body) {
    const id = str(body.id_str);
    const changes = (body.changes ?? {}) as Body;
    const moveTo = str(changes.category);
    if (changes.created_at !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(str(changes.created_at))) {
        throw new HttpError(400, 'created_at must be YYYY-MM-DD');
    }
    return mutate((d) => {
        const hit = find(d, id);
        if (!hit) throw new HttpError(404, 'Article not found — reload');
        const article = hit.cat.content[hit.index]!;
        for (const key of EDITABLE) {
            if (typeof changes[key] !== 'string') continue;
            const value = (changes[key] as string).trim();
            if (key === 'title' && !value) throw new HttpError(400, 'Title cannot be empty');
            if (value) article[key] = value;
            else delete article[key as 'original_img_url'];
        }
        if (moveTo && moveTo !== hit.cat.category) {
            const target = d.articles.find((c) => c.category === moveTo);
            if (!target) throw new HttpError(400, `Unknown category ${moveTo}`);
            hit.cat.content.splice(hit.index, 1);
            target.content.push(article);
        }
        return summary({ category: moveTo || hit.cat.category, article });
    });
}

/** Settles a "review" verdict: keep it, or remove it now. */
function decide(body: Body) {
    const id = str(body.id_str);
    const decision = str(body.decision);
    if (decision !== 'keep' && decision !== 'remove') throw new HttpError(400, 'decision must be keep or remove');
    const overrides = loadOverrides();
    overrides[id] = decision;
    saveOverrides(overrides);
    if (decision === 'remove') {
        const note = loadVerdicts()[id]?.note ?? '';
        mutate((d) => removeArticles(d, new Set([id]), note));
    }
    return { ok: true };
}

// ─── Pinterest pins (R2) ─────────────────────────────────────────────────────
// Runs scripts/generate-pinterest-pin.ts --storage r2 as a child process, one
// job at a time, and keeps its output so the page can poll it.

const PIN_SCRIPT = fileURLToPath(new URL('generate-pinterest-pin.ts', import.meta.url));
const ROOT = path.dirname(path.dirname(PIN_SCRIPT));
const R2_BUCKET = process.env.R2_BUCKET || 'elhellalpins';
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || 'https://pins.elhellal.com').replace(/\/$/, '');

/** The quiz's languages, from the sibling repo (the pin script needs it anyway). */
const QUIZ_LANGS: string[] = await import('../../elhellal-quiz/src/i18n.ts').then((m) => m.LANGS as string[]).catch(() => ['ar']);
const PIN_SCOPES = ['articles', 'quotes', 'books', 'bio', ...QUIZ_LANGS.map((l) => `quiz-${l}`)];
const PIN_MODES = ['generate', 'fix', 'remove'] as const;

/** A scope's feed in the bucket ("quiz-ar" is the default language: quiz-feed.xml). */
function feedKey(scope: string) {
    if (scope === 'articles') return 'feed.xml';
    if (scope === `quiz-${QUIZ_LANGS[0]}`) return 'quiz-feed.xml';
    return `${scope}-feed.xml`;
}

/** Same grouping as the pin script's keyKind(): images/<scope folder>/…, articles are everything else. */
function imageScope(key: string) {
    const folder = key.split('/')[0]!;
    if (folder === 'quotes' || folder === 'books' || folder === 'bio') return folder;
    if (folder === 'quiz') return `quiz-${QUIZ_LANGS[0]}`;
    if (/^quiz-[a-z]{2}$/.test(folder)) return folder;
    return 'articles';
}

let s3: { client: any; sdk: typeof import('@aws-sdk/client-s3') } | null = null;
async function r2() {
    if (s3) return s3;
    const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_KEY } = process.env;
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_KEY) {
        throw new HttpError(500, 'R2 credentials missing: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_KEY in .env');
    }
    const sdk = await import('@aws-sdk/client-s3');
    const client = new sdk.S3Client({
        region: 'auto',
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_KEY },
    });
    return (s3 = { client, sdk });
}

async function r2Text(key: string): Promise<string | null> {
    const { client, sdk } = await r2();
    try {
        const res = await client.send(new sdk.GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
        return await res.Body.transformToString('utf-8');
    } catch {
        return null;
    }
}

/** What's in the bucket right now: images per scope, feed items per scope, published.json size. */
async function pinStatus() {
    const { client, sdk } = await r2();
    const images: Record<string, number> = Object.fromEntries(PIN_SCOPES.map((s) => [s, 0]));
    let token: string | undefined;
    do {
        const res: any = await client.send(new sdk.ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: 'images/', ContinuationToken: token }));
        for (const obj of res.Contents ?? []) {
            if (!obj.Key?.endsWith('.png')) continue;
            const scope = imageScope(obj.Key.slice('images/'.length));
            images[scope] = (images[scope] ?? 0) + 1;
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    const scopes = await Promise.all(
        PIN_SCOPES.map(async (scope) => {
            const xml = await r2Text(feedKey(scope));
            return {
                scope,
                images: images[scope] ?? 0,
                feedItems: xml === null ? null : xml.split('<item>').length - 1,
                feedUrl: `${R2_PUBLIC_URL}/${feedKey(scope)}`,
            };
        }),
    );
    const published = JSON.parse((await r2Text('published.json')) ?? '{}');
    return {
        bucket: R2_BUCKET,
        scopes,
        published: Array.isArray(published.urls) ? published.urls.length : 0,
        checkedAt: Date.now(),
    };
}

interface Job {
    id: number;
    mode: string;
    scopes: string[];
    command: string;
    startedAt: number;
    endedAt?: number;
    exitCode?: number | null;
    stopped?: boolean;
    lines: string[];
    /** Lines dropped from the front to cap memory; line n is lines[n - dropped]. */
    dropped: number;
}

const MAX_LINES = 5000;

/** One job at a time per slot; the last one's output stays for the page to poll. */
interface Slot {
    job: Job | null;
    proc: ReturnType<typeof Bun.spawn> | null;
    onExit?: () => void;
}
const pinSlot: Slot = { job: null, proc: null };

function pushOutput(job: Job, text: string, partial: { rest: string }) {
    // Progress bars redraw with \r; treat it as a line break so the log stays readable.
    const parts = (partial.rest + text).split(/\r?\n|\r/);
    partial.rest = parts.pop()!;
    job.lines.push(...parts);
    if (job.lines.length > MAX_LINES) {
        const extra = job.lines.length - MAX_LINES;
        job.lines.splice(0, extra);
        job.dropped += extra;
    }
}

async function pipe(job: Job, stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    const partial = { rest: '' };
    for await (const chunk of stream) pushOutput(job, decoder.decode(chunk, { stream: true }), partial);
    if (partial.rest) pushOutput(job, '\n', partial);
}

function startJob(slot: Slot, script: string, args: string[], meta: Pick<Job, 'mode' | 'scopes'>) {
    return startCommand(slot, [process.execPath, 'run', script, ...args], `bun run scripts/${path.basename(script)} ${args.join(' ')}`, meta);
}

/** Runs any command in `slot` (in the repo root unless `cwd` says otherwise); `display` is what the log shows as the command. */
function startCommand(slot: Slot, cmd: string[], display: string, meta: Pick<Job, 'mode' | 'scopes'>, cwd = ROOT, env: Record<string, string> = {}) {
    const job: Job = {
        id: (slot.job?.id ?? 0) + 1,
        ...meta,
        command: display,
        startedAt: Date.now(),
        lines: [],
        dropped: 0,
    };
    const proc = Bun.spawn(cmd, {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, FORCE_COLOR: '0', ...env },
    });
    slot.job = job;
    slot.proc = proc;
    void Promise.all([pipe(job, proc.stdout as ReadableStream<Uint8Array>), pipe(job, proc.stderr as ReadableStream<Uint8Array>), proc.exited]).then(([, , code]) => {
        job.exitCode = code;
        job.endedAt = Date.now();
        if (slot.proc === proc) slot.proc = null;
        slot.onExit?.();
    });
    return publicJob(job, 0);
}

function stopJob(slot: Slot) {
    if (!slot.proc || !slot.job) throw new HttpError(409, 'No job is running');
    slot.job.stopped = true;
    // SIGINT like Ctrl-C, so the script can clean up (the pin script closes its headless browser).
    slot.proc.kill('SIGINT');
    return { ok: true };
}

function runPins(body: Body) {
    if (pinSlot.proc) throw new HttpError(409, 'A pin job is already running');
    const mode = str(body.mode) as (typeof PIN_MODES)[number];
    if (!PIN_MODES.includes(mode)) throw new HttpError(400, `mode must be one of ${PIN_MODES.join(', ')}`);
    const scopes = [...ids(body.scopes)];
    const unknown = scopes.find((s) => !PIN_SCOPES.includes(s));
    if (unknown) throw new HttpError(400, `Unknown scope ${unknown}`);
    if (!scopes.length) throw new HttpError(400, 'Pick at least one content type');
    // --remove deletes images and empties feeds: make the page send the scope back as confirmation.
    if (mode === 'remove' && str(body.confirm) !== scopes.join('+')) throw new HttpError(400, 'Removal not confirmed');

    const args = ['--storage', 'r2', ...scopes.map((s) => `--${s}`)];
    if (mode === 'fix') args.push('--fix');
    if (mode === 'remove') args.push('--remove');
    const batch = Number(body.batch);
    if (mode === 'generate' && Number.isInteger(batch) && batch > 0) args.push('--batch', String(batch));

    return startJob(pinSlot, PIN_SCRIPT, args, { mode, scopes });
}

function publicJob(job: Job, from: number) {
    const start = Math.max(0, from - job.dropped);
    return {
        ...job,
        running: job.endedAt === undefined,
        lines: job.lines.slice(start),
        next: job.dropped + job.lines.length,
    };
}

function pinJobState(params: URLSearchParams) {
    return {
        scopes: PIN_SCOPES,
        job: pinSlot.job ? publicJob(pinSlot.job, Number(params.get('from')) || 0) : null,
    };
}

// ─── Imports ──────────────────────────────────────────────────────────────────
// Runs the Substack / external-blog importers. They read the whole catalog at
// startup and write it back as they go, so catalog edits here are refused while
// one runs (see mutate), and the cache is reloaded when it ends.

const SUBSTACK_SCRIPT = fileURLToPath(new URL('import-substack2.ts', import.meta.url));
const BLOGS_SCRIPT = fileURLToPath(new URL('import-external-blogs.ts', import.meta.url));
const BLOG_REGISTRY = path.join(ROOT, 'src/data/external-blogs.ts');
const importSlot: Slot = { job: null, proc: null, onExit: reload };

/** Importers started outside the admin (e.g. in a terminal), as "pid command" lines. */
function otherImports(): string[] {
    const res = Bun.spawnSync(['pgrep', '-fl', 'scripts/import-(substack|external-blogs)']);
    return res.stdout
        .toString()
        .split('\n')
        .filter((line) => line.trim() && Number(line.split(' ')[0]) !== importSlot.proc?.pid);
}

/** "foo", "@foo", "foo.substack.com", "https://foo.substack.com/p/x", "substack.com/@foo" → "foo". */
function substackUsername(raw: string): string | null {
    const s = raw.trim().replace(/^\[[^\]]*\]\(([^)]+)\)$/, '$1');
    const m =
        s.match(/^@?([a-z0-9_-]+)$/i) ??
        s.match(/^(?:https?:\/\/)?(?:www\.)?([a-z0-9_-]+)\.substack\.com\b/i) ??
        s.match(/^(?:https?:\/\/)?(?:www\.)?substack\.com\/@([a-z0-9_-]+)/i);
    const name = m?.[1]?.toLowerCase();
    return name && name !== 'www' ? name : null;
}

const splitList = (v: unknown) => str(v).split(/[\s,]+/).filter(Boolean);

function runImport(body: Body) {
    if (importSlot.proc) throw new HttpError(409, 'An import is already running');
    const others = otherImports();
    if (others.length) throw new HttpError(409, `Another import is running outside the admin: ${others.join('; ')}`);
    if (publishSlot.proc && WRITES_CATALOG.has(publishSlot.job?.mode ?? '')) throw new HttpError(409, 'A build is running — import when it has finished');
    const source = str(body.source);
    const only = body.only !== false;

    if (source === 'substack' || source === 'substack-fix') {
        if (source === 'substack-fix') return startJob(importSlot, SUBSTACK_SCRIPT, ['--fix'], { mode: 'substack --fix', scopes: [] });
        const inputs = splitList(body.items);
        const bad = inputs.filter((i) => !substackUsername(i));
        if (bad.length) throw new HttpError(400, `Not a Substack username or *.substack.com URL: ${bad.join(', ')}`);
        const blocked = new Set(loadBlocklist().authors);
        const users = [...new Set(inputs.map((i) => substackUsername(i)!))];
        const blockedUsers = users.filter((u) => blocked.has(u));
        if (blockedUsers.length) throw new HttpError(400, `Blocked author(s): ${blockedUsers.join(', ')} — unblock them first`);
        if (only && !users.length) throw new HttpError(400, 'Enter at least one username');
        return startJob(importSlot, SUBSTACK_SCRIPT, [...(only ? ['--only'] : []), ...users], { mode: 'substack', scopes: users });
    }
    if (source === 'blogs') {
        const urls = [...new Set(splitList(body.items))];
        if (only && !urls.length) throw new HttpError(400, 'Enter at least one blog URL');
        const args = [...(only ? ['--only'] : []), ...(body.save ? ['--save'] : []), ...urls];
        return startJob(importSlot, BLOGS_SCRIPT, args, { mode: 'blogs', scopes: urls });
    }
    throw new HttpError(400, 'source must be substack, substack-fix or blogs');
}

/** Blogs in src/data/external-blogs.ts (read fresh: --save appends to it). */
function registeredBlogs() {
    const src = fs.readFileSync(BLOG_REGISTRY, 'utf-8');
    return [...src.matchAll(/slug:\s*['"]([^'"]+)['"][\s\S]*?url:\s*['"]([^'"]+)['"]/g)].map((m) => ({ slug: m[1]!, url: m[2]! }));
}

function importState(params: URLSearchParams) {
    return {
        job: importSlot.job ? publicJob(importSlot.job, Number(params.get('from')) || 0) : null,
        others: otherImports(),
        blogs: registeredBlogs(),
    };
}

// ─── Substack candidates ──────────────────────────────────────────────────────
// Authors queued for import: added by hand or by a scripts/discover-substack.ts
// run (merged in from .substack-discovery/latest.json when the run ends). The
// Import tab picks from this list.

const DISCOVER_SCRIPT = fileURLToPath(new URL('discover-substack.ts', import.meta.url));
const DISCOVERY_DIR = path.join(ROOT, '.substack-discovery');
const CANDIDATES_PATH = path.join(DISCOVERY_DIR, 'candidates.json');

interface Candidate {
    username: string;
    source: 'manual' | 'discover';
    added_at: string;
    name?: string | undefined;
    score?: number | undefined;
    matches?: number | undefined;
    reactions?: number | undefined;
    keywords?: string[] | undefined;
    latest_post?: string | undefined;
    sample?: { title: string; url: string } | undefined;
}

function loadCandidates(): Candidate[] {
    try {
        return JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf-8')) as Candidate[];
    } catch {
        return [];
    }
}

function saveCandidates(list: Candidate[]) {
    fs.mkdirSync(DISCOVERY_DIR, { recursive: true });
    fs.writeFileSync(CANDIDATES_PATH, JSON.stringify(list, null, 2) + '\n');
}

interface DiscoveredPublication {
    subdomain: string;
    name?: string;
    score?: number;
    matches?: number;
    total_reactions?: number;
    keywords?: string[];
    latest_post?: string;
    posts?: { title: string; url: string }[];
}

/** Adds latest.json's publications to the candidates (refreshing stats of ones already listed). */
function mergeDiscovery(): number {
    let pubs: DiscoveredPublication[];
    try {
        pubs = (JSON.parse(fs.readFileSync(path.join(DISCOVERY_DIR, 'latest.json'), 'utf-8')) as { publications?: DiscoveredPublication[] }).publications ?? [];
    } catch {
        return 0;
    }
    const list = loadCandidates();
    const byName = new Map(list.map((c) => [c.username, c]));
    const blocked = new Set(loadBlocklist().authors);
    let added = 0;
    for (const p of pubs) {
        const username = substackUsername(p.subdomain);
        if (!username || blocked.has(username)) continue;
        const sample = p.posts?.[0];
        const stats = {
            name: p.name || undefined,
            score: p.score,
            matches: p.matches,
            reactions: p.total_reactions,
            keywords: p.keywords?.slice(0, 5),
            latest_post: p.latest_post?.slice(0, 10),
            sample: sample ? { title: sample.title, url: sample.url } : undefined,
        };
        const existing = byName.get(username);
        if (existing) Object.assign(existing, stats);
        else {
            const c: Candidate = { username, source: 'discover', added_at: today(), ...stats };
            list.push(c);
            byName.set(username, c);
            added++;
        }
    }
    saveCandidates(list);
    return added;
}

const discoverSlot: Slot = {
    job: null,
    proc: null,
    onExit: () => {
        if (discoverSlot.job?.exitCode !== 0) return;
        const added = mergeDiscovery();
        discoverSlot.job.lines.push('', `➕ ${added} new author(s) added to the import list`);
    },
};

function listCandidates() {
    const blocked = new Set(loadBlocklist().authors);
    const counts = new Map<string, number>();
    for (const r of rows()) {
        const name = r.article.screen_name.toLowerCase();
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const items = loadCandidates()
        .map((c) => ({ ...c, articles: counts.get(c.username) ?? 0, blocked: blocked.has(c.username) }))
        .sort((a, b) => b.added_at.localeCompare(a.added_at) || (b.score ?? 0) - (a.score ?? 0));
    return { items };
}

function addCandidates(body: Body) {
    const inputs = splitList(body.items);
    const bad = inputs.filter((i) => !substackUsername(i));
    if (bad.length) throw new HttpError(400, `Not a Substack username or *.substack.com URL: ${bad.join(', ')}`);
    const blocked = new Set(loadBlocklist().authors);
    const list = loadCandidates();
    const have = new Set(list.map((c) => c.username));
    const skipped: string[] = [];
    let added = 0;
    for (const username of new Set(inputs.map((i) => substackUsername(i)!))) {
        if (blocked.has(username)) skipped.push(username);
        else if (!have.has(username)) {
            list.push({ username, source: 'manual', added_at: today() });
            have.add(username);
            added++;
        }
    }
    saveCandidates(list);
    return { added, skipped };
}

function removeCandidates(body: Body) {
    const names = ids(body.usernames);
    const list = loadCandidates();
    const kept = list.filter((c) => !names.has(c.username));
    saveCandidates(kept);
    return { removed: list.length - kept.length };
}

function runDiscover(body: Body) {
    if (discoverSlot.proc) throw new HttpError(409, 'Discovery is already running');
    const args: string[] = [];
    const geo = splitList(body.geo).map((g) => g.toUpperCase());
    if (geo.some((g) => !/^[A-Z]{2}$/.test(g))) throw new HttpError(400, 'Countries must be 2-letter codes, e.g. SA EG MA');
    if (geo.length) args.push('--geo', geo.join(','));
    for (const key of ['pages', 'days'] as const) {
        if (body[key] == null || body[key] === '') continue;
        const n = Number(body[key]);
        if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${key} must be a whole number`);
        if (n > 0) args.push(`--${key}`, String(n));
    }
    if (body.all) args.push('--all');
    return startJob(discoverSlot, DISCOVER_SCRIPT, args, { mode: 'discover', scopes: geo });
}

function discoverState(params: URLSearchParams) {
    return { job: discoverSlot.job ? publicJob(discoverSlot.job, Number(params.get('from')) || 0) : null };
}

// ─── Publish ──────────────────────────────────────────────────────────────────
// check-data → build → wrangler deploy, one step at a time in one slot, plus a
// git summary of the changes, a commit (data paths, or everything) and git push.

/** What the admin and the importers change. Commits only ever include these. */
const DATA_PATHS = ['src/data/catalog', 'src/data/moderation', 'src/data/author-names.json', 'src/data/external-blogs.ts', 'public/llms.txt'];
const BUN = process.execPath;
const PUBLISH_STEPS: Record<string, { cmd: string[]; display: string }> = {
    check: { cmd: [BUN, 'run', 'check-data'], display: 'bun run check-data' },
    'add-slugs': { cmd: [BUN, 'run', 'add-slugs'], display: 'bun run add-slugs' },
    build: { cmd: [BUN, 'run', 'build'], display: 'bun run build' },
    deploy: { cmd: [BUN, 'x', 'wrangler', 'deploy'], display: 'bunx wrangler deploy' },
    'build+deploy': { cmd: ['sh', '-c', `"${BUN}" run build && "${BUN}" x wrangler deploy`], display: 'bun run build && bunx wrangler deploy' },
    push: { cmd: ['git', 'push'], display: 'git push' },
};
/** Steps that rewrite the catalog (prepare-data runs add-slugs). */
const WRITES_CATALOG = new Set(['add-slugs', 'build', 'build+deploy']);
const publishSlot: Slot = { job: null, proc: null, onExit: reload };

function runPublish(body: Body) {
    if (publishSlot.proc) throw new HttpError(409, 'A publish step is already running');
    const step = str(body.step);
    const def = PUBLISH_STEPS[step];
    if (!def) throw new HttpError(400, `step must be one of ${Object.keys(PUBLISH_STEPS).join(', ')}`);
    if (WRITES_CATALOG.has(step) && (importSlot.proc || otherImports().length)) {
        throw new HttpError(409, 'An import is running — building now would race its catalog writes');
    }
    if (step === 'deploy' && !fs.existsSync(path.join(ROOT, 'dist/_data'))) throw new HttpError(400, 'No build in dist/ — run Build first');
    if (step === 'push') return startPush();
    return startCommand(publishSlot, def.cmd, def.display, { mode: step, scopes: [] });
}

/** git push in the publish slot; sets the upstream on a branch's first push. */
function startPush() {
    if (publishSlot.proc) throw new HttpError(409, 'A publish step is already running');
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD').out.trim();
    const cmd = git('rev-parse', '--abbrev-ref', '@{u}').ok ? ['git', 'push'] : ['git', 'push', '-u', 'origin', branch];
    return startCommand(publishSlot, cmd, cmd.join(' '), { mode: 'push', scopes: [] });
}

function git(...args: string[]) {
    const res = Bun.spawnSync(['git', ...args], { cwd: ROOT });
    return { ok: res.exitCode === 0, out: res.stdout.toString(), err: res.stderr.toString() };
}

/** Changed data files, as git status --porcelain entries (renames give both paths). */
function changedDataFiles() {
    return git('status', '--porcelain', '--untracked-files=all', '--', ...DATA_PATHS)
        .out.split('\n')
        .filter(Boolean)
        .map((line) => ({ status: line.slice(0, 2), paths: line.slice(3).split(' -> ').map((p) => p.replace(/^"|"$/g, '')) }));
}

/** Article ids added / removed vs HEAD, from the changed catalog files only. */
function catalogDelta(files: string[]) {
    const idsOf = (text: string | null) => {
        try {
            return text ? (JSON.parse(text) as Article[]).map((a) => a.id_str) : [];
        } catch {
            return [];
        }
    };
    const before = new Set<string>();
    const after = new Set<string>();
    for (const file of files.filter((f) => f.startsWith('src/data/catalog/') && f.endsWith('.json') && !f.endsWith('categories.json'))) {
        const head = git('show', `HEAD:${file}`);
        idsOf(head.ok ? head.out : null).forEach((id) => before.add(id));
        const abs = path.join(ROOT, file);
        idsOf(fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null).forEach((id) => after.add(id));
    }
    return {
        added: [...after].filter((id) => !before.has(id)).length,
        removed: [...before].filter((id) => !after.has(id)).length,
    };
}

function publishState(params: URLSearchParams) {
    return { job: publishSlot.job ? publicJob(publishSlot.job, Number(params.get('from')) || 0) : null };
}

function gitState() {
    const files = changedDataFiles();
    const numstat = new Map(
        git('diff', 'HEAD', '--numstat', '--', ...DATA_PATHS)
            .out.split('\n')
            .filter(Boolean)
            .map((l) => {
                const [add, del, file] = l.split('\t');
                return [file!, { add: Number(add) || 0, del: Number(del) || 0 }] as const;
            }),
    );
    const all = files.flatMap((f) => f.paths);
    const upstream = git('rev-list', '--left-right', '--count', '@{u}...HEAD');
    const [behind, ahead] = upstream.ok ? upstream.out.trim().split(/\s+/).map(Number) : [null, null];
    const dataSet = new Set(all);
    const others = git('status', '--porcelain', '-z', '--untracked-files=all')
        .out.split('\0')
        .filter((e) => /^[ MADRCU?!]{2} /.test(e))
        .map((e) => ({ status: e.slice(0, 2), path: e.slice(3) }))
        .filter((f) => !dataSet.has(f.path));
    return {
        branch: git('rev-parse', '--abbrev-ref', 'HEAD').out.trim(),
        last: git('log', '-1', '--format=%h %s (%cr)').out.trim(),
        ahead,
        behind,
        dataPaths: DATA_PATHS,
        shortstat: git('diff', 'HEAD', '--shortstat', '--', ...DATA_PATHS).out.trim(),
        delta: all.length <= 600 ? catalogDelta(all) : null,
        otherChanges: others.length,
        otherFiles: others.slice(0, 100),
        remote: git('remote', 'get-url', 'origin').out.trim(),
        files: files.slice(0, 300).map((f) => ({ status: f.status, path: f.paths.join(' → '), ...(numstat.get(f.paths.at(-1)!) ?? {}) })),
        totalFiles: files.length,
    };
}

/** Commits the data paths (or, with `all`, every change), then optionally starts git push. */
function commitData(body: Body) {
    const message = str(body.message).trim();
    if (!message) throw new HttpError(400, 'Write a commit message');
    if (importSlot.proc || otherImports().length) throw new HttpError(409, 'An import is running — commit when it has finished');
    if (publishSlot.proc) throw new HttpError(409, 'A publish step is running — commit when it has finished');
    let commit;
    if (body.all) {
        if (!git('status', '--porcelain').out.trim()) throw new HttpError(400, 'Nothing to commit');
        const add = git('add', '-A');
        if (!add.ok) throw new HttpError(500, add.err);
        commit = git('commit', '-m', message);
    } else {
        if (!changedDataFiles().length) throw new HttpError(400, 'No data changes to commit');
        const add = git('add', '-A', '--', ...DATA_PATHS);
        if (!add.ok) throw new HttpError(500, add.err);
        // --only semantics: commits just these paths, other staged work stays staged.
        const paths = [...new Set(changedDataFiles().flatMap((f) => f.paths))];
        commit = git('commit', '-m', message, '--', ...paths);
    }
    if (!commit.ok) throw new HttpError(500, commit.err || commit.out);
    if (body.push) startPush();
    return { ok: true, output: commit.out.trim(), pushing: !!body.push };
}

// ─── Data health ──────────────────────────────────────────────────────────────
// check-data's checks, per article, so they can be fixed from the page.

const HEALTH_KINDS = {
    missing_image: 'Missing image',
    bad_image: 'Bad image URL',
    missing_url: 'Missing source URL',
    wrong_file: 'Wrong month file',
    out_of_order: 'Out of order',
    missing_slug: 'Missing slug',
    duplicate_slug: 'Duplicate slug',
    duplicate_id: 'Duplicate id',
    bad_date: 'Bad created_at',
    empty_preview: 'Empty preview',
} as const;
type HealthKind = keyof typeof HEALTH_KINDS;

let healthCache: { at: number; items: { row: Row; file: string; kinds: HealthKind[] }[] } | null = null;

function scanHealth() {
    if (healthCache?.at === loadedAt) return healthCache.items;
    const scanned: { row: Row; file: string; kinds: HealthKind[] }[] = [];
    for (const cat of data.articles) {
        for (const file of bucketFiles(cat.category)) {
            let prev: Article | null = null;
            for (const article of JSON.parse(fs.readFileSync(file, 'utf-8')) as Article[]) {
                const kinds: HealthKind[] = [];
                const img = article.original_img_url;
                if (!img) kinds.push('missing_image');
                else if (!/^https?:\/\//.test(img) || !URL.canParse(img)) kinds.push('bad_image');
                if (!article.url) kinds.push('missing_url');
                if (`${bucketOf(article)}.json` !== path.basename(file)) kinds.push('wrong_file');
                if (prev && article.title.localeCompare(prev.title) < 0) kinds.push('out_of_order');
                if (!article.slug) kinds.push('missing_slug');
                if (!/^\d{4}-\d{2}-\d{2}$/.test(article.created_at ?? '')) kinds.push('bad_date');
                if (!article.preview_text?.trim()) kinds.push('empty_preview');
                scanned.push({ row: { category: cat.category, article }, file: `${cat.category}/${path.basename(file)}`, kinds });
                prev = article;
            }
        }
    }
    const count = (key: (a: Article) => string | undefined) => {
        const n = new Map<string, number>();
        for (const s of scanned) {
            const k = key(s.row.article);
            if (k) n.set(k, (n.get(k) ?? 0) + 1);
        }
        return n;
    };
    const slugs = count((a) => a.slug);
    const idCounts = count((a) => a.id_str);
    for (const s of scanned) {
        if (s.row.article.slug && slugs.get(s.row.article.slug)! > 1) s.kinds.push('duplicate_slug');
        if (idCounts.get(s.row.article.id_str)! > 1) s.kinds.push('duplicate_id');
    }
    const items = scanned.filter((s) => s.kinds.length);
    healthCache = { at: loadedAt, items };
    return items;
}

function listHealth(params: URLSearchParams) {
    const all = scanHealth();
    const kind = params.get('kind') ?? '';
    const category = params.get('category') ?? '';
    const page = Math.max(1, Number(params.get('page')) || 1);
    const counts = Object.fromEntries(Object.keys(HEALTH_KINDS).map((k) => [k, 0])) as Record<HealthKind, number>;
    for (const s of all) for (const k of s.kinds) counts[k]++;
    const list = all.filter((s) => (!kind || s.kinds.includes(kind as HealthKind)) && (!category || s.row.category === category));
    // Group duplicates next to each other.
    if (kind === 'duplicate_slug') list.sort((a, b) => (a.row.article.slug ?? '').localeCompare(b.row.article.slug ?? ''));
    if (kind === 'duplicate_id') list.sort((a, b) => a.row.article.id_str.localeCompare(b.row.article.id_str));
    return {
        kinds: HEALTH_KINDS,
        counts,
        totalArticles: all.length,
        total: list.length,
        page,
        pages: Math.max(1, Math.ceil(list.length / PAGE_SIZE)),
        ids: list.length <= 5000 ? list.map((s) => s.row.article.id_str) : null,
        items: list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((s) => ({ ...summary(s.row), file: s.file, kinds: s.kinds })),
    };
}

/** Rewrites the catalog through writeArticles(), which re-sorts and re-buckets every file. */
function rewriteCatalog() {
    let result = { written: 0, removed: 0 };
    mutate((d) => {
        result = writeArticles(d);
    });
    return result;
}

// ─── Social schedulers ────────────────────────────────────────────────────────
// x-schedule / linkedin-schedule (write a console snippet to paste on the site)
// and the TikTok slideshow generators (write PNG folders to upload by hand).

const SOCIAL = {
    x: { script: 'x-schedule.ts', snippet: '.x-schedule/snippet.js', post: 'https://x.com/home' },
    linkedin: { script: 'linkedin-schedule.ts', snippet: '.linkedin-schedule/snippet.js', post: 'https://www.linkedin.com/company/84134110/admin/page-posts/published/' },
    'tiktok-slides': { script: 'generate-tiktok-slideshow.ts', out: 'tiktok-slides' },
    'tiktok-books': { script: 'generate-tiktok-book-summary.ts', out: 'tiktok-slides/book-summaries' },
} as const;
type SocialTool = keyof typeof SOCIAL;
const socialSlot: Slot = { job: null, proc: null };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function intArg(body: Body, key: string, min: number, max: number): number | null {
    if (body[key] == null || body[key] === '') return null;
    const n = Number(body[key]);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${key} must be a whole number from ${min} to ${max}`);
    return n;
}

/** `--month M YYYY` from body.month = "YYYY-MM" (an <input type=month>). */
function monthArgs(body: Body): string[] {
    const m = /^(\d{4})-(\d{2})$/.exec(str(body.month));
    if (!m) throw new HttpError(400, 'Pick a month');
    return ['--month', String(Number(m[2])), m[1]!];
}

function socialArgs(tool: SocialTool, body: Body): string[] {
    const args: string[] = [];
    const span = str(body.span);
    const date = str(body.date);
    if (date && !DATE_RE.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');

    if (tool === 'x' || tool === 'linkedin') {
        if (span === 'day') args.push('--day');
        else if (span === 'next') args.push('--month');
        else if (span === 'month') args.push(...monthArgs(body));
        else throw new HttpError(400, 'span must be day, next or month');
        const articles = intArg(body, 'articles', 0, 12);
        const quizzes = intArg(body, 'quizzes', 0, 12);
        if (articles === 0) args.push('--no-articles');
        else if (articles) args.push('--articles', String(articles));
        if (quizzes === 0) args.push('--no-quiz');
        else if (quizzes) args.push('--quizzes', String(quizzes));
        if (tool === 'x' && body.book === false) args.push('--no-book');
        if (span === 'next') {
            const days = intArg(body, 'days', 1, 60);
            if (days) args.push('--days', String(days));
        }
        const category = str(body.category);
        if (category) {
            if (!data.articles.some((c) => c.category === category)) throw new HttpError(400, `Unknown category ${category}`);
            args.push('--category', category);
        }
        const since = str(body.since);
        if (since) {
            if (!DATE_RE.test(since)) throw new HttpError(400, 'since must be YYYY-MM-DD');
            args.push('--since', since);
        }
        if (date && span !== 'month') args.push('--date', date);
        if (body.random) args.push('--random');
    } else if (tool === 'tiktok-slides') {
        const count = intArg(body, 'count', 1, 12);
        if (count) args.push('--count', String(count));
        if (span === 'month') {
            args.push(...monthArgs(body));
            const time = str(body.time);
            if (time) {
                if (!TIME_RE.test(time)) throw new HttpError(400, 'time must be HH:MM');
                args.push('--time', time);
            }
        } else if (date) args.push('--date', date);
        if (body.force) args.push('--force');
    } else {
        const count = intArg(body, 'count', 1, 20);
        if (count) args.push('--count', String(count));
        const book = str(body.book).trim();
        if (book) args.push('--book', book);
        if (date) args.push('--date', date);
    }
    if (body.dryRun) args.push('--dry-run');
    return args;
}

function runSocial(body: Body) {
    if (socialSlot.proc) throw new HttpError(409, 'A social job is already running');
    const tool = str(body.tool) as SocialTool;
    if (!(tool in SOCIAL)) throw new HttpError(400, `tool must be one of ${Object.keys(SOCIAL).join(', ')}`);
    return startJob(socialSlot, fileURLToPath(new URL(SOCIAL[tool].script, import.meta.url)), socialArgs(tool, body), { mode: tool, scopes: [] });
}

/** Dated output folders of a TikTok generator, newest first, with their PNG counts. */
function socialOutputs(tool: 'tiktok-slides' | 'tiktok-books') {
    const dir = path.join(ROOT, SOCIAL[tool].out);
    if (!fs.existsSync(dir)) return [];
    const pngs = (d: string): number =>
        fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? pngs(path.join(d, e.name)) : e.name.endsWith('.png') ? 1 : 0), 0);
    return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && DATE_RE.test(e.name))
        .map((e) => e.name)
        .sort()
        .reverse()
        .slice(0, 14)
        .map((name) => ({ name, images: pngs(path.join(dir, name)) }));
}

function snippetInfo(tool: 'x' | 'linkedin') {
    const file = path.join(ROOT, SOCIAL[tool].snippet);
    if (!fs.existsSync(file)) return null;
    const st = fs.statSync(file);
    return { mtime: st.mtimeMs, size: st.size, post: SOCIAL[tool].post };
}

function socialState(params: URLSearchParams) {
    return {
        job: socialSlot.job ? publicJob(socialSlot.job, Number(params.get('from')) || 0) : null,
        snippets: { x: snippetInfo('x'), linkedin: snippetInfo('linkedin') },
        outputs: { 'tiktok-slides': socialOutputs('tiktok-slides'), 'tiktok-books': socialOutputs('tiktok-books') },
    };
}

function socialSnippet(params: URLSearchParams) {
    const tool = params.get('tool');
    if (tool !== 'x' && tool !== 'linkedin') throw new HttpError(400, 'tool must be x or linkedin');
    const file = path.join(ROOT, SOCIAL[tool].snippet);
    if (!fs.existsSync(file)) throw new HttpError(404, 'No snippet yet — run the scheduler first');
    return { text: fs.readFileSync(file, 'utf-8') };
}

/** Opens an output folder in Finder (only names socialOutputs() lists). */
function openOutput(body: Body) {
    const tool = str(body.tool);
    if (tool !== 'tiktok-slides' && tool !== 'tiktok-books') throw new HttpError(400, 'Unknown tool');
    const name = str(body.name);
    if (!socialOutputs(tool).some((o) => o.name === name)) throw new HttpError(404, 'No such folder');
    Bun.spawn(['open', path.join(ROOT, SOCIAL[tool].out, name)]);
    return { ok: true };
}

// ─── Generated media ──────────────────────────────────────────────────────────
// Folders of images/videos the social generators write (and the quiz repo's
// video maker), listed with their size so posted ones can be deleted to free
// disk space. history.json / used.json next to them (which keep items from
// being picked twice) are never touched.

const QUIZ_VIDEO_DIR = path.join(ROOT, '../elhellal-quiz/video');

interface MediaRoot {
    key: string;
    label: string;
    /** Absolute path. */
    dir: string;
    /** Date for items whose name has none (YYYY-MM-DD by name). */
    dates?: () => Map<string, string>;
}

const MEDIA_ROOTS: MediaRoot[] = [
    { key: 'x-posts', label: 'X book / lesson images', dir: path.join(ROOT, 'x-posts') },
    { key: 'tiktok-slides', label: 'TikTok article slideshows', dir: path.join(ROOT, 'tiktok-slides') },
    { key: 'tiktok-books', label: 'TikTok book summaries', dir: path.join(ROOT, 'tiktok-slides/book-summaries') },
    { key: 'tiktok-quotes', label: 'TikTok quotes', dir: path.join(ROOT, 'tiktok-slides/quotes') },
    {
        // ../elhellal-quiz/video/make.ts — `bun run video` (Shorts: NNN-<id>/) and `--long` (YouTube: long-<date>-…/).
        key: 'quiz-videos',
        label: 'Quiz videos (YouTube / Shorts / Reels)',
        dir: (process.env.QUIZ_VIDEOS_DIR || path.join(os.homedir(), 'Desktop/quiz-videos')).replace(/^~/, os.homedir()),
        dates: () => {
            // Shorts folders are numbered; used.json has the day each number was made.
            const map = new Map<string, string>();
            try {
                const used = JSON.parse(fs.readFileSync(path.join(QUIZ_VIDEO_DIR, 'used.json'), 'utf-8')) as { videos?: { n: number; id: string; date: string }[] };
                for (const v of used.videos ?? []) map.set(`${String(v.n).padStart(3, '0')}-${v.id}`, v.date);
            } catch {}
            return map;
        },
    },
];
const MEDIA_ROOT_DIRS = new Set(MEDIA_ROOTS.map((r) => r.dir));
/** Bookkeeping the generators need to not repeat themselves — never listed, never deleted. */
const MEDIA_KEEP = new Set(['history.json', 'used.json', '.DS_Store']);

function dirStats(dir: string) {
    let bytes = 0;
    let files = 0;
    const kinds: Record<string, number> = {};
    const add = (file: string) => {
        bytes += fs.statSync(file).size;
        files++;
        const ext = path.extname(file).slice(1).toLowerCase();
        if (ext && ext !== 'ds_store') kinds[ext] = (kinds[ext] ?? 0) + 1;
    };
    if (!fs.statSync(dir).isDirectory()) {
        add(dir);
        return { bytes, files, kinds };
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            const s = dirStats(p);
            bytes += s.bytes;
            files += s.files;
            for (const [k, n] of Object.entries(s.kinds)) kinds[k] = (kinds[k] ?? 0) + n;
        } else if (e.isFile()) add(p);
    }
    return { bytes, files, kinds };
}

/** Folders and loose files directly inside a root (other roots nested in it excluded), newest name first. */
function mediaFolders(root: MediaRoot) {
    if (!fs.existsSync(root.dir)) return [];
    const todayStr = today();
    const dates = root.dates?.() ?? new Map<string, string>();
    return fs
        .readdirSync(root.dir, { withFileTypes: true })
        .filter((e) => (e.isDirectory() || e.isFile()) && !MEDIA_KEEP.has(e.name) && !MEDIA_ROOT_DIRS.has(path.join(root.dir, e.name)))
        .map((e) => {
            const date = /\d{4}-\d{2}-\d{2}/.exec(e.name)?.[0] ?? dates.get(e.name);
            return { name: e.name, file: e.isFile(), date, past: !!date && date < todayStr, ...dirStats(path.join(root.dir, e.name)) };
        })
        .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.name.localeCompare(a.name));
}

function listMedia() {
    return {
        roots: MEDIA_ROOTS.map((r) => {
            const folders = mediaFolders(r);
            const rel = path.relative(ROOT, r.dir);
            return {
                key: r.key,
                label: r.label,
                dir: rel.startsWith('..') ? r.dir.replace(os.homedir(), '~') : rel,
                exists: fs.existsSync(r.dir),
                bytes: folders.reduce((n, f) => n + f.bytes, 0),
                folders,
            };
        }),
    };
}

function deleteMedia(body: Body) {
    if (socialSlot.proc) throw new HttpError(409, 'A social job is running and may be writing these folders — wait for it to finish');
    const root = MEDIA_ROOTS.find((r) => r.key === str(body.root));
    if (!root) throw new HttpError(400, 'Unknown folder group');
    const names = ids(body.names);
    if (!names.size) throw new HttpError(400, 'Nothing selected');
    const known = new Map(mediaFolders(root).map((f) => [f.name, f]));
    const missing = [...names].filter((n) => !known.has(n));
    if (missing.length) throw new HttpError(404, `Not found (reload): ${missing.join(', ')}`);
    let bytes = 0;
    for (const name of names) {
        fs.rmSync(path.join(root.dir, name), { recursive: true, force: true });
        bytes += known.get(name)!.bytes;
    }
    return { deleted: names.size, bytes };
}

// ─── Sibling sites ────────────────────────────────────────────────────────────
// quotes / books / biographies / quiz.elhellal.com live in sibling repos next to
// this one. The Sites tab browses and edits their data files, runs their
// scripts, builds and deploys them, and commits their data — each in its own repo.

const DEV_DIR = path.dirname(ROOT);
const sitesSlot: Slot = { job: null, proc: null };

interface SiteStep {
    label: string;
    cmd: string[];
    display: string;
    /** Rewrites the site's data files: edits to that site are refused while it runs. */
    writes?: boolean;
    env?: Record<string, string>;
    /** Extra CLI args the page may pass (validated by this pattern), e.g. Goodreads slugs. */
    args?: RegExp;
}
interface Site {
    title: string;
    dir: string;
    url: string;
    /** What the Sites tab edits and commits, relative to the repo. */
    data: string[];
    steps: Record<string, SiteStep>;
    /** Build/ship buttons; defaults to RELEASE_STEPS (wrangler deploy). */
    release?: Record<string, SiteStep>;
    /** File whose presence/mtime means "built" (default dist/_worker.js). */
    builtFile?: string;
}

const siteDir = (name: string) => path.join(DEV_DIR, name);
const runScript = (label: string, script: string, extra: Partial<SiteStep> = {}): SiteStep => ({ label, cmd: [BUN, 'run', script], display: `bun run ${script}`, ...extra });
const RELEASE_STEPS: Record<string, SiteStep> = {
    build: runScript('Build', 'build'),
    deploy: { label: 'Deploy', cmd: [BUN, 'x', 'wrangler', 'deploy'], display: 'bunx wrangler deploy' },
    'build+deploy': { label: 'Build & deploy', cmd: ['sh', '-c', `"${BUN}" run build && "${BUN}" x wrangler deploy`], display: 'bun run build && bunx wrangler deploy' },
};

const SITES: Record<string, Site> = {
    quotes: {
        title: 'Quotes',
        dir: siteDir('elhellal-quotes'),
        url: 'https://quotes.elhellal.com',
        data: ['src/data'],
        steps: {
            'check-data': runScript('Check data', 'check-data'),
            'sync-book-summaries': runScript('Sync book links', 'sync-book-summaries', { writes: true }),
            'sync-biographies': runScript('Sync biography links', 'sync-biographies', { writes: true }),
            'import-quotes': runScript('Import from Goodreads', 'import-quotes', { writes: true, args: /^[\w.-]+$/ }),
        },
    },
    books: {
        title: 'Books',
        dir: siteDir('elhellal-books'),
        url: 'https://books.elhellal.com',
        data: ['src/data', 'src/content'],
        steps: {},
    },
    biographies: {
        title: 'Biographies',
        dir: siteDir('elhellal-biographies'),
        url: 'https://biographies.elhellal.com',
        data: ['src/data'],
        steps: {
            'check-biography': { label: 'Check biographies', cmd: [BUN, 'scripts/check-biography.ts'], display: 'bun scripts/check-biography.ts' },
            'sync-summaries': runScript('Sync book links', 'sync-summaries', { writes: true }),
        },
    },
    quiz: {
        title: 'Quiz',
        dir: siteDir('elhellal-quiz'),
        url: 'https://quiz.elhellal.com',
        data: ['src/data'],
        steps: {
            // Its default quotes path predates the quotes repo split.
            'build-questions': {
                label: 'Build questions',
                cmd: [BUN, 'scripts/build-questions.mjs'],
                display: 'bun scripts/build-questions.mjs',
                writes: true,
                env: { QUOTES_JSON: path.join(siteDir('elhellal-quotes'), 'src/data/quotes.json') },
            },
            'd1-migrate': {
                label: 'Apply D1 migrations',
                cmd: [BUN, 'x', 'wrangler', 'd1', 'migrations', 'apply', 'elhellal-quiz', '--remote'],
                display: 'bunx wrangler d1 migrations apply elhellal-quiz --remote',
            },
        },
    },
    // Deployed by Cloudflare from GitHub: pushing main is the deploy.
    abderahmane: {
        title: 'Abderahmane',
        dir: siteDir('abderahmane'),
        url: 'https://abderahmane.elhellal.com',
        data: ['src/content'],
        steps: {},
        release: {
            build: runScript('Build', 'build'),
            push: { label: 'Push (deploys)', cmd: ['git', 'push', 'origin', 'main'], display: 'git push origin main' },
        },
        builtFile: 'dist/index.html',
    },
};

const releaseSteps = (s: Site) => s.release ?? RELEASE_STEPS;

function site(name: unknown): Site & { name: string } {
    const s = SITES[str(name)];
    if (!s) throw new HttpError(400, `site must be one of ${Object.keys(SITES).join(', ')}`);
    if (!fs.existsSync(s.dir)) throw new HttpError(404, `${s.dir} not found`);
    return { ...s, name: str(name) };
}

/** Refuses edits to `name`'s data while one of its data-writing scripts runs. */
function siteWritable(name: string) {
    const mode = sitesSlot.proc ? sitesSlot.job?.mode ?? '' : '';
    const [busy, step] = mode.split(':');
    if (busy === name && (SITES[name]!.steps[step!]?.writes || step === 'build' || step === 'build+deploy')) {
        throw new HttpError(409, `${SITES[name]!.title}: ${step} is running — edit when it has finished`);
    }
}

function runSite(body: Body) {
    if (sitesSlot.proc) throw new HttpError(409, `${sitesSlot.job?.mode} is already running`);
    const s = site(body.site);
    const stepName = str(body.step);
    const step = s.steps[stepName] ?? releaseSteps(s)[stepName];
    if (!step) throw new HttpError(400, `Unknown step ${stepName}`);
    if (stepName === 'deploy' && !fs.existsSync(path.join(s.dir, s.builtFile ?? 'dist/_worker.js'))) throw new HttpError(400, 'No build in dist/ — build first');
    if (stepName === 'push' && gitIn(s.dir, 'branch', '--show-current').out.trim() !== 'main') throw new HttpError(409, `${s.title} is not on main`);
    const args = splitList(body.args);
    if (args.length && !step.args) throw new HttpError(400, `${stepName} takes no arguments`);
    const bad = args.find((a) => !step.args!.test(a));
    if (bad) throw new HttpError(400, `Invalid argument ${bad}`);
    return startCommand(sitesSlot, [...step.cmd, ...args], [step.display, ...args].join(' '), { mode: `${s.name}:${stepName}`, scopes: [s.name] }, s.dir, step.env);
}

function sitesJob(params: URLSearchParams) {
    return { job: sitesSlot.job ? publicJob(sitesSlot.job, Number(params.get('from')) || 0) : null };
}

function gitIn(dir: string, ...args: string[]) {
    const res = Bun.spawnSync(['git', ...args], { cwd: dir });
    return { ok: res.exitCode === 0, out: res.stdout.toString(), err: res.stderr.toString() };
}

/** Changed data files. -z keeps Arabic file names unescaped; a rename is followed by its old path. */
function siteChanges(s: Site) {
    const parts = gitIn(s.dir, 'status', '--porcelain', '-z', '--untracked-files=all', '--', ...s.data).out.split('\0');
    const files: { status: string; path: string; paths: string[] }[] = [];
    for (let i = 0; i < parts.length; i++) {
        const entry = parts[i]!;
        if (!entry) continue;
        const status = entry.slice(0, 2);
        const paths = [entry.slice(3)];
        if (/[RC]/.test(status)) paths.unshift(parts[++i]!);
        files.push({ status, path: paths.join(' → '), paths });
    }
    return files;
}

// JSON data files, cached by mtime and written back in the style they were read in
// (2-space, one row per line, or minified) so diffs stay small.
type JsonStyle = 'two' | 'rows' | 'min';
const jsonCache = new Map<string, { mtime: number; data: any; style: JsonStyle; newline: boolean }>();

function readJson<T = any>(file: string): T {
    const mtime = fs.statSync(file).mtimeMs;
    const hit = jsonCache.get(file);
    if (hit?.mtime === mtime) return hit.data as T;
    const text = fs.readFileSync(file, 'utf-8');
    const style: JsonStyle = text.startsWith('[\n[') ? 'rows' : /^[[{]\n {2}\S/.test(text) ? 'two' : 'min';
    const data = JSON.parse(text);
    jsonCache.set(file, { mtime, data, style, newline: text.endsWith('\n') });
    return data as T;
}

function writeJson(file: string, data: unknown) {
    const hit = jsonCache.get(file);
    const style = hit?.style ?? 'two';
    const text =
        style === 'rows' ? `[\n${(data as unknown[]).map((r) => JSON.stringify(r)).join(',\n')}\n]` : style === 'min' ? JSON.stringify(data) : JSON.stringify(data, null, 2);
    fs.writeFileSync(file, text + (hit?.newline ?? true ? '\n' : ''));
    jsonCache.set(file, { mtime: fs.statSync(file).mtimeMs, data, style, newline: hit?.newline ?? true });
}

const QUOTES_JSON = path.join(SITES.quotes!.dir, 'src/data/quotes.json');
const BOOKS_JSON = path.join(SITES.books!.dir, 'src/data/books.json');
const SUMMARIES_DIR = path.join(SITES.books!.dir, 'src/content/summaries');
const BIOS_JSON = path.join(SITES.biographies!.dir, 'src/data/authors.json');
const QUIZ_DATA = path.join(SITES.quiz!.dir, 'src/data');
/** Translations of the Arabic bank (src/data/<lang>.json). */
const QUIZ_LANG_FILES = QUIZ_LANGS.filter((l) => l !== 'ar' && fs.existsSync(path.join(QUIZ_DATA, `${l}.json`)));

interface QuoteItem { id: string; text: string; likes?: number; [k: string]: unknown }
interface QuoteBook { slug: string; title: string; cover?: string; quotes: QuoteItem[]; [k: string]: unknown }
interface QuoteAuthor { slug: string; name: string; image?: string; quotes: QuoteItem[]; books: QuoteBook[]; [k: string]: unknown }

const quoteAuthors = () => readJson<{ authors: QuoteAuthor[] }>(QUOTES_JSON).authors;
const quoteCount = (a: QuoteAuthor) => a.quotes.length + a.books.reduce((n, b) => n + b.quotes.length, 0);

function siteCounts(name: string): Record<string, number> {
    const has = (f: string) => fs.existsSync(f);
    switch (name) {
        case 'quotes': {
            if (!has(QUOTES_JSON)) return {};
            const authors = quoteAuthors();
            return { authors: authors.length, books: authors.reduce((n, a) => n + a.books.length, 0), quotes: authors.reduce((n, a) => n + quoteCount(a), 0) };
        }
        case 'books': {
            if (!has(BOOKS_JSON)) return {};
            const books = readJson<{ slug: string }[]>(BOOKS_JSON);
            return { books: books.length, 'without a long summary': books.filter((b) => !has(path.join(SUMMARIES_DIR, `${b.slug}.md`))).length };
        }
        case 'biographies':
            return has(BIOS_JSON) ? { authors: readJson<unknown[]>(BIOS_JSON).length } : {};
        case 'abderahmane': {
            const count = (dir: string) => {
                const d = path.join(BLOG_DIR, 'src/content', dir);
                return has(d) ? fs.readdirSync(d).filter((f) => /\.mdx?$/.test(f)).length : 0;
            };
            return { articles: count('article'), books: count('books'), taammulat: count('taammulat') };
        }
        case 'quiz': {
            const bank = readJson<unknown[]>(path.join(QUIZ_DATA, 'bank.json'));
            const counts: Record<string, number> = { 'bank questions': bank.filter(Boolean).length };
            for (const l of QUIZ_LANG_FILES) counts[`${l} translated`] = readJson<{ bank: unknown[] }>(path.join(QUIZ_DATA, `${l}.json`)).bank.filter(Boolean).length;
            counts.pictures = readJson<unknown[]>(path.join(QUIZ_DATA, 'pictures.json')).length;
            return counts;
        }
    }
    return {};
}

function sitesOverview() {
    return Object.entries(SITES).map(([name, s]) => {
        if (!fs.existsSync(s.dir)) return { name, title: s.title, missing: true, dir: s.dir };
        const upstream = gitIn(s.dir, 'rev-list', '--left-right', '--count', '@{u}...HEAD');
        const [behind, ahead] = upstream.ok ? upstream.out.trim().split(/\s+/).map(Number) : [null, null];
        const files = siteChanges(s);
        let counts: Record<string, number> = {};
        let error = '';
        try {
            counts = siteCounts(name);
        } catch (err) {
            error = String(err);
        }
        return {
            name,
            title: s.title,
            url: s.url,
            dir: s.dir,
            data: s.data,
            steps: Object.entries(s.steps).map(([key, st]) => ({ key, label: st.label, args: !!st.args })),
            release: Object.entries(releaseSteps(s)).map(([key, st]) => ({ key, label: st.label, display: st.display })),
            counts,
            error,
            git: {
                branch: gitIn(s.dir, 'rev-parse', '--abbrev-ref', 'HEAD').out.trim(),
                last: gitIn(s.dir, 'log', '-1', '--format=%h %s (%cr)').out.trim(),
                ahead,
                behind,
                files: files.slice(0, 200),
                totalFiles: files.length,
                shortstat: gitIn(s.dir, 'diff', 'HEAD', '--shortstat', '--', ...s.data).out.trim(),
                otherChanges: gitIn(s.dir, 'status', '--porcelain').out.split('\n').filter(Boolean).length - files.length,
            },
            built: (() => {
                const f = path.join(s.dir, s.builtFile ?? 'dist/_worker.js');
                return fs.existsSync(f) ? fs.statSync(f).mtimeMs : null;
            })(),
        };
    });
}

function commitSite(body: Body) {
    const s = site(body.site);
    const message = str(body.message).trim();
    if (!message) throw new HttpError(400, 'Write a commit message');
    siteWritable(s.name);
    const files = siteChanges(s);
    if (!files.length) throw new HttpError(400, 'No data changes to commit');
    const add = gitIn(s.dir, 'add', '-A', '--', ...s.data);
    if (!add.ok) throw new HttpError(500, add.err);
    const paths = [...new Set(siteChanges(s).flatMap((f) => f.paths))];
    const commit = gitIn(s.dir, 'commit', '-m', message, '--', ...paths);
    if (!commit.ok) throw new HttpError(500, commit.err || commit.out);
    return { ok: true, output: commit.out.trim() };
}

// Quotes: quotes.json is author > (quotes | books > quotes); ids are unique across the file.

function findQuote(authors: QuoteAuthor[], id: string) {
    for (const author of authors) {
        let i = author.quotes.findIndex((q) => q.id === id);
        if (i > -1) return { author, book: null, list: author.quotes, i };
        for (const book of author.books) {
            i = book.quotes.findIndex((q) => q.id === id);
            if (i > -1) return { author, book, list: book.quotes, i };
        }
    }
    return null;
}

function listQuotes(params: URLSearchParams) {
    const authors = quoteAuthors();
    const q = (params.get('q') ?? '').trim().toLowerCase();
    const authorSlug = params.get('author') ?? '';
    const bookSlug = params.get('book') ?? '';
    const sort = params.get('sort') ?? 'likes';
    const items: { id: string; text: string; likes: number; author: string; authorName: string; book: string | null; bookTitle: string | null }[] = [];
    for (const a of authors) {
        if (authorSlug && a.slug !== authorSlug) continue;
        const add = (list: QuoteItem[], b: QuoteBook | null) => {
            if (bookSlug && b?.slug !== bookSlug) return;
            for (const x of list) {
                if (q && !x.text.toLowerCase().includes(q) && !x.id.includes(q)) continue;
                items.push({ id: x.id, text: x.text, likes: x.likes ?? 0, author: a.slug, authorName: a.name, book: b?.slug ?? null, bookTitle: b?.title ?? null });
            }
        };
        add(a.quotes, null);
        a.books.forEach((b) => add(b.quotes, b));
    }
    if (sort === 'likes') items.sort((x, y) => y.likes - x.likes);
    else if (sort === 'shortest') items.sort((x, y) => x.text.length - y.text.length);
    else if (sort === 'longest') items.sort((x, y) => y.text.length - x.text.length);
    const page = Math.max(1, Number(params.get('page')) || 1);
    const author = authors.find((a) => a.slug === authorSlug);
    return {
        total: items.length,
        page,
        pages: Math.max(1, Math.ceil(items.length / PAGE_SIZE)),
        items: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        authors: authors.map((a) => ({ slug: a.slug, name: a.name, count: quoteCount(a) })).sort((x, y) => y.count - x.count),
        books: author ? author.books.map((b) => ({ slug: b.slug, title: b.title, count: b.quotes.length })) : [],
    };
}

function editQuote(body: Body) {
    siteWritable('quotes');
    const text = str(body.text).trim();
    if (text.length < 4 || text.length > 500) throw new HttpError(400, 'Quote must be 4–500 characters (check-data rule)');
    const data = readJson<{ authors: QuoteAuthor[] }>(QUOTES_JSON);
    const hit = findQuote(data.authors, str(body.id));
    if (!hit) throw new HttpError(404, 'Quote not found');
    hit.list[hit.i]!.text = text;
    writeJson(QUOTES_JSON, data);
    return { ok: true };
}

function removeQuotes(body: Body) {
    siteWritable('quotes');
    const wanted = ids(body.ids);
    if (!wanted.size) throw new HttpError(400, 'No quotes given');
    const data = readJson<{ authors: QuoteAuthor[] }>(QUOTES_JSON);
    let removed = 0;
    const drop = (list: QuoteItem[]) => {
        const kept = list.filter((q) => !wanted.has(q.id));
        removed += list.length - kept.length;
        return kept;
    };
    for (const a of data.authors) {
        a.quotes = drop(a.quotes);
        for (const b of a.books) b.quotes = drop(b.quotes);
    }
    if (removed) writeJson(QUOTES_JSON, data);
    return { removed };
}

function removeQuoteAuthor(body: Body) {
    siteWritable('quotes');
    const slug = str(body.slug);
    if (str(body.confirm) !== slug) throw new HttpError(400, 'Removal not confirmed');
    const data = readJson<{ authors: QuoteAuthor[] }>(QUOTES_JSON);
    const i = data.authors.findIndex((a) => a.slug === slug);
    if (i < 0) throw new HttpError(404, 'Author not found');
    const [author] = data.authors.splice(i, 1);
    writeJson(QUOTES_JSON, data);
    return { removed: quoteCount(author!) };
}

// Books and biographies: arrays of entries keyed by slug, edited as whole JSON objects.

interface Collection {
    site: string;
    file: string;
    required: string[];
    stringLists?: string[];
    /** Optional markdown body per entry: <dir>/<slug>.md. */
    markdownDir?: string;
}
const COLLECTIONS: Record<string, Collection> = {
    books: { site: 'books', file: BOOKS_JSON, required: ['slug', 'title', 'author', 'authorSlug', 'summary'], stringLists: ['keyIdeas'], markdownDir: SUMMARIES_DIR },
    biographies: { site: 'biographies', file: BIOS_JSON, required: ['slug', 'name', 'summary'], stringLists: ['roles'] },
};

function collection(name: unknown) {
    const c = COLLECTIONS[str(name)];
    if (!c) throw new HttpError(400, `collection must be one of ${Object.keys(COLLECTIONS).join(', ')}`);
    return c;
}

const markdownPath = (c: Collection, slug: string) => path.join(c.markdownDir!, `${slug}.md`);

function listCollection(params: URLSearchParams) {
    const c = collection(params.get('coll'));
    const entries = readJson<Record<string, unknown>[]>(c.file);
    return {
        items: entries.map((entry) => {
            const slug = String(entry.slug);
            const md = c.markdownDir && fs.existsSync(markdownPath(c, slug)) ? fs.statSync(markdownPath(c, slug)).size : null;
            return { entry, markdown: c.markdownDir ? md : undefined };
        }),
    };
}

function saveEntry(body: Body) {
    const c = collection(body.coll);
    siteWritable(c.site);
    const original = str(body.slug);
    const entry = body.entry;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new HttpError(400, 'Entry must be a JSON object');
    const e = entry as Record<string, unknown>;
    const missing = c.required.filter((k) => typeof e[k] !== 'string' || !(e[k] as string).trim());
    if (missing.length) throw new HttpError(400, `Missing ${missing.join(', ')}`);
    for (const k of c.stringLists ?? []) {
        if (e[k] !== undefined && !(Array.isArray(e[k]) && (e[k] as unknown[]).every((x) => typeof x === 'string'))) throw new HttpError(400, `${k} must be a list of strings`);
    }
    const slug = e.slug as string;
    if (/[/\\]|^\.|\s/.test(slug)) throw new HttpError(400, 'Slug cannot contain spaces, slashes or start with a dot');
    const entries = readJson<Record<string, unknown>[]>(c.file);
    const at = original ? entries.findIndex((x) => x.slug === original) : -1;
    if (original && at < 0) throw new HttpError(404, `${original} not found`);
    if (slug !== original && entries.some((x) => x.slug === slug)) throw new HttpError(409, `${slug} already exists`);
    if (at > -1) entries[at] = e;
    else entries.push(e);
    if (c.markdownDir && original && slug !== original && fs.existsSync(markdownPath(c, original))) fs.renameSync(markdownPath(c, original), markdownPath(c, slug));
    writeJson(c.file, entries);
    return { ok: true, created: at < 0 };
}

function removeEntry(body: Body) {
    const c = collection(body.coll);
    siteWritable(c.site);
    const slug = str(body.slug);
    if (str(body.confirm) !== slug) throw new HttpError(400, 'Removal not confirmed');
    const entries = readJson<Record<string, unknown>[]>(c.file);
    const at = entries.findIndex((x) => x.slug === slug);
    if (at < 0) throw new HttpError(404, `${slug} not found`);
    entries.splice(at, 1);
    writeJson(c.file, entries);
    const md = c.markdownDir ? markdownPath(c, slug) : null;
    if (md && fs.existsSync(md)) fs.rmSync(md);
    return { ok: true };
}

function readMarkdown(params: URLSearchParams) {
    const c = collection(params.get('coll'));
    if (!c.markdownDir) throw new HttpError(400, 'This collection has no markdown');
    const slug = params.get('slug') ?? '';
    if (!readJson<Record<string, unknown>[]>(c.file).some((x) => x.slug === slug)) throw new HttpError(404, `${slug} not found`);
    const file = markdownPath(c, slug);
    return { text: fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null };
}

function saveMarkdown(body: Body) {
    const c = collection(body.coll);
    if (!c.markdownDir) throw new HttpError(400, 'This collection has no markdown');
    siteWritable(c.site);
    const slug = str(body.slug);
    if (!readJson<Record<string, unknown>[]>(c.file).some((x) => x.slug === slug)) throw new HttpError(404, `${slug} not found`);
    const text = str(body.text);
    const file = markdownPath(c, slug);
    if (!text.trim()) {
        if (fs.existsSync(file)) fs.rmSync(file);
        return { ok: true, deleted: true };
    }
    fs.writeFileSync(file, text.endsWith('\n') ? text : text + '\n');
    return { ok: true };
}

// Quiz bank: rows are [category, question, answer, [3 wrong]]; en/es translate them index by
// index as [question, answer, [3 wrong]] or null. Question ids are the row index (b<i>, t<i>),
// so rows are edited in place, never removed or reordered.

type BankRow = [string, string, string, string[]];
type TRow = [string, string, string[]] | null;
const QUIZ_CATS = ['geo', 'sci', 'hist', 'gen', 'lit', 'lang'];
const quizFile = (name: string) => path.join(QUIZ_DATA, `${name}.json`);

function listBank(params: URLSearchParams) {
    const bank = readJson<(BankRow | null)[]>(quizFile('bank'));
    const tr = Object.fromEntries(QUIZ_LANG_FILES.map((l) => [l, readJson<{ bank: TRow[] }>(quizFile(l)).bank]));
    const q = (params.get('q') ?? '').trim().toLowerCase();
    const cat = params.get('cat') ?? '';
    const untranslated = params.get('untranslated') === '1';
    const counts: Record<string, number> = {};
    const items = [];
    for (const [i, row] of bank.entries()) {
        if (!row) continue;
        counts[row[0]] = (counts[row[0]] ?? 0) + 1;
        if (cat && row[0] !== cat) continue;
        const translations = Object.fromEntries(QUIZ_LANG_FILES.map((l) => [l, tr[l]![i] ?? null]));
        if (untranslated && QUIZ_LANG_FILES.every((l) => translations[l])) continue;
        if (q && !JSON.stringify([row, translations]).toLowerCase().includes(q) && `b${i}` !== q) continue;
        items.push({ i, row, translations });
    }
    const page = Math.max(1, Number(params.get('page')) || 1);
    return { total: items.length, page, pages: Math.max(1, Math.ceil(items.length / PAGE_SIZE)), items: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), counts, cats: QUIZ_CATS, langs: QUIZ_LANG_FILES };
}

function checkAnswers(where: string, question: unknown, answer: unknown, wrong: unknown): [string, string, string[]] {
    const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const w = Array.isArray(wrong) ? wrong.map(s) : [];
    if (!s(question) || !s(answer)) throw new HttpError(400, `${where}: question and answer are required`);
    if (w.length !== 3 || w.some((x) => !x)) throw new HttpError(400, `${where}: needs exactly 3 wrong answers`);
    if (new Set([s(answer), ...w]).size !== 4) throw new HttpError(400, `${where}: the 4 answers must be distinct`);
    return [s(question), s(answer), w];
}

function editBank(body: Body) {
    siteWritable('quiz');
    const i = Number(body.i);
    const bank = readJson<(BankRow | null)[]>(quizFile('bank'));
    const row = Number.isInteger(i) ? bank[i] : null;
    if (!row) throw new HttpError(404, 'Question not found');
    const ar = (body.ar ?? {}) as Body;
    const cat = str(ar.cat) || row[0];
    if (!QUIZ_CATS.includes(cat)) throw new HttpError(400, `Unknown category ${cat}`);
    const [question, answer, wrong] = checkAnswers('ar', ar.q, ar.a, ar.w);
    if (bank.some((r, j) => j !== i && r?.[1] === question)) throw new HttpError(409, 'ar: another bank row already asks this question');
    const updates: [string, unknown][] = [];
    for (const l of QUIZ_LANG_FILES) {
        const t = (body.translations as Body | undefined)?.[l] as Body | null | undefined;
        if (t === undefined) continue;
        updates.push([l, t === null || (!str(t.q) && !str(t.a)) ? null : checkAnswers(l, t.q, t.a, t.w)]);
    }
    bank[i] = [cat, question, answer, wrong];
    writeJson(quizFile('bank'), bank);
    for (const [l, value] of updates) {
        const file = readJson<{ bank: TRow[] }>(quizFile(l));
        file.bank[i] = value as TRow;
        writeJson(quizFile(l), file);
    }
    return { ok: true };
}

// Player flags ("this question is wrong") live in the quiz's remote D1 database.
let reportsCache: { at: number; value: unknown } | null = null;

/** Runs SQL (one or more statements) on a remote D1 database; one result set per statement. */
async function d1Results(sql: string, db = 'elhellal-quiz', cwd = SITES.quiz!.dir) {
    const proc = Bun.spawn([BUN, 'x', 'wrangler', 'd1', 'execute', db, '--remote', '--json', '--command', sql], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, FORCE_COLOR: '0' },
    });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    let parsed: any;
    try {
        parsed = JSON.parse(out);
    } catch {
        throw new HttpError(502, `wrangler: ${out.trim().slice(0, 300) || 'no output'}`);
    }
    if (parsed.error) throw new HttpError(502, [parsed.error.text, ...(parsed.error.notes ?? []).map((n: { text: string }) => n.text)].join(' — '));
    return (parsed as { results: Record<string, any>[] }[]).map((r) => r.results);
}

async function d1(sql: string) {
    return (await d1Results(sql))[0]!;
}

/** What a stat id points at: Arabic ids are bare, other languages are `<lang>:<id>`. */
function describeQuizId(statId: string) {
    const [lang, id] = statId.includes(':') ? statId.split(':', 2) as [string, string] : ['ar', statId];
    const m = /^([bt])(\d+)$/.exec(id);
    if (!m) return { lang, id, kind: id.replace(/[\d-].*$/, '') || id };
    const i = +m[2]!;
    const row = readJson<(BankRow | null)[]>(quizFile('bank'))[i];
    const t = lang === 'ar' ? null : readJson<{ bank: TRow[] }>(quizFile(lang)).bank?.[i];
    return { lang, id, kind: m[1] === 't' ? 'true/false' : 'bank', i, row, translation: t ?? null };
}

async function quizReports(params: URLSearchParams) {
    if (reportsCache && Date.now() - reportsCache.at < 60_000 && params.get('fresh') !== '1') return reportsCache.value;
    let value;
    try {
        const rows = await d1('SELECT r.id, r.n, a.n AS answered, a.ok FROM reports r LEFT JOIN answers a ON a.id = r.id ORDER BY r.n DESC LIMIT 200');
        value = { reports: rows.map((r) => ({ ...r, ...describeQuizId(String(r.id)) })) };
    } catch (err) {
        if (!(err instanceof HttpError) || !/no such table: reports/.test(err.message)) throw err;
        value = { reports: [], missingTable: true };
    }
    reportsCache = { at: Date.now(), value };
    return value;
}

// ─── Functional-food leads ────────────────────────────────────────────────────
// news-medical.net "Functional Food" items queued by the abderahmane blog's
// /functional-food-leads skill (../abderahmane/.claude/skills/functional-food-leads).
// Writing and X publishing open an interactive Claude Code session in Terminal,
// so tools are approved as usual and the skill asks before posting to X. Leads,
// the articles they produced, deploys and X links are managed here directly.

const BLOG_DIR = siteDir('abderahmane');
const BLOG_URL = 'https://abderahmane.elhellal.com';
const LEADS_DIR = path.join(BLOG_DIR, '.claude/skills/functional-food-leads');
const LEADS_JSON = path.join(LEADS_DIR, 'leads.json');
const BLOG_ARTICLES = 'src/content/article';
const LEAD_STATUSES = ['pending', 'written', 'published', 'skipped'] as const;
const LEAD_URL_RE = /^https:\/\/www\.news-medical\.net\/news\/(\d{8})\/[^\s"'<>]+\.aspx$/;
const BLOG_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const leadSlot: Slot = { job: null, proc: null };

interface Lead {
    title: string;
    url: string;
    date: string;
    status: (typeof LEAD_STATUSES)[number];
    slug: string | null;
    x_url?: string;
}

const readLeads = () => readJson<Lead[]>(LEADS_JSON);
const articleFile = (slug: string) => path.join(BLOG_DIR, BLOG_ARTICLES, `${slug}.md`);

function blogSlug(v: unknown) {
    const slug = str(v);
    if (!BLOG_SLUG_RE.test(slug)) throw new HttpError(400, 'Invalid slug');
    return slug;
}

function leadByUrl(leads: Lead[], url: unknown) {
    const lead = leads.find((l) => l.url === str(url));
    if (!lead) throw new HttpError(404, 'Lead not found');
    return lead;
}

function leadUrls(leads: Lead[], v: unknown) {
    const urls = ids(v);
    if (!urls.size) throw new HttpError(400, 'Pick at least one lead');
    const picked = leads.filter((l) => urls.has(l.url));
    if (picked.length !== urls.size) throw new HttpError(404, 'Some leads were not found — reload');
    return picked;
}

function articleInfo(slug: string) {
    const file = articleFile(slug);
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf-8');
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    const field = (k: string) => {
        const m = fm && new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm[1]!);
        return m ? m[1]!.trim().replace(/^"(.*)"$/, '$1') : '';
    };
    const body = fm ? text.slice(fm[0].length) : text;
    return {
        title: field('title'),
        description: field('description'),
        pubDate: field('pubDate'),
        thumb: field('thumb') || null,
        draft: field('draft') === 'true',
        words: body.split(/\s+/).filter(Boolean).length,
        modified: fs.statSync(file).mtimeMs,
    };
}

/** Which article files are on origin/main, and which differ from HEAD (new, edited or deleted). */
function blogGitState() {
    const onMain = new Set(gitIn(BLOG_DIR, 'ls-tree', '-r', '--name-only', 'origin/main', '--', BLOG_ARTICLES).out.split('\n').filter(Boolean));
    const changed = new Map<string, string>();
    for (const entry of gitIn(BLOG_DIR, 'status', '--porcelain', '-z', '--untracked-files=all', '--', BLOG_ARTICLES).out.split('\0')) {
        if (entry) changed.set(entry.slice(3), entry.slice(0, 2).trim());
    }
    return { onMain, changed };
}

function listLeads(params: URLSearchParams) {
    if (!fs.existsSync(LEADS_JSON)) throw new HttpError(404, `${LEADS_JSON} not found`);
    const leads = readLeads();
    const status = params.get('status') ?? '';
    const q = (params.get('q') ?? '').trim().toLowerCase();
    const counts: Record<string, number> = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0]));
    for (const l of leads) counts[l.status] = (counts[l.status] ?? 0) + 1;
    const git = blogGitState();
    const matches = leads
        .map((lead, i) => ({ lead, n: i + 1 }))
        .filter(({ lead }) => (!status || lead.status === status) && (!q || `${lead.title} ${lead.slug ?? ''} ${lead.url}`.toLowerCase().includes(q)));
    const page = Math.max(1, Number(params.get('page')) || 1);
    const items = matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(({ lead, n }) => {
        const rel = lead.slug ? `${BLOG_ARTICLES}/${lead.slug}.md` : '';
        return {
            ...lead,
            n,
            article: lead.slug ? articleInfo(lead.slug) : null,
            onMain: rel ? git.onMain.has(rel) : false,
            change: rel ? git.changed.get(rel) ?? null : null,
        };
    });
    return {
        counts,
        total: matches.length,
        page,
        pages: Math.max(1, Math.ceil(matches.length / PAGE_SIZE)),
        items,
        savedPages: fs.existsSync(path.join(LEADS_DIR, 'pages')) ? fs.readdirSync(path.join(LEADS_DIR, 'pages')).filter((f) => f.endsWith('.html')).length : 0,
        blogUrl: BLOG_URL,
    };
}

/** Every blog article for the Sites tab, newest first, with its git state. */
function listBlogArticles(params: URLSearchParams) {
    const dir = path.join(BLOG_DIR, BLOG_ARTICLES);
    const q = (params.get('q') ?? '').trim().toLowerCase();
    const git = blogGitState();
    const leadSlugs = new Set(fs.existsSync(LEADS_JSON) ? readLeads().map((l) => l.slug).filter(Boolean) : []);
    const slugs = new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)));
    // Deleted but not yet committed articles still show, so they can be deployed.
    for (const rel of git.changed.keys()) if (rel.endsWith('.md') && !fs.existsSync(path.join(BLOG_DIR, rel))) slugs.add(path.basename(rel, '.md'));
    const all = [...slugs].map((slug) => {
        const rel = `${BLOG_ARTICLES}/${slug}.md`;
        return { slug, article: articleInfo(slug), onMain: git.onMain.has(rel), change: git.changed.get(rel) ?? null, lead: leadSlugs.has(slug) };
    });
    const matches = all
        .filter((x) => !q || `${x.slug} ${x.article?.title ?? ''} ${x.article?.description ?? ''}`.toLowerCase().includes(q))
        .sort((a, b) => Number(!!b.change) - Number(!!a.change) || (b.article?.pubDate ?? '').localeCompare(a.article?.pubDate ?? ''));
    const page = Math.max(1, Number(params.get('page')) || 1);
    return {
        total: matches.length,
        changed: all.filter((x) => x.change).length,
        page,
        pages: Math.max(1, Math.ceil(matches.length / PAGE_SIZE)),
        items: matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        blogUrl: BLOG_URL,
    };
}

function setLeadStatus(body: Body) {
    const status = str(body.status) as Lead['status'];
    if (status !== 'pending' && status !== 'skipped') throw new HttpError(400, 'status must be pending or skipped');
    const leads = readLeads();
    const picked = leadUrls(leads, body.urls);
    const withArticle = picked.find((l) => l.slug && fs.existsSync(articleFile(l.slug)));
    if (withArticle) throw new HttpError(409, `"${withArticle.title}" has an article — remove the article first`);
    for (const l of picked) {
        l.status = status;
        l.slug = null;
        delete l.x_url;
    }
    writeJson(LEADS_JSON, leads);
    return { changed: picked.length };
}

function addLead(body: Body) {
    const url = str(body.url).trim().replace(/[?#].*$/, '');
    const m = LEAD_URL_RE.exec(url);
    if (!m) throw new HttpError(400, 'Expected a https://www.news-medical.net/news/YYYYMMDD/….aspx URL');
    const leads = readLeads();
    if (leads.some((l) => l.url === url)) throw new HttpError(409, 'That lead is already in the list');
    const d = m[1]!;
    const fromUrl = decodeURIComponent(url.split('/').pop()!.replace(/\.aspx$/, '')).replace(/-/g, ' ');
    leads.push({ title: str(body.title).trim() || fromUrl, url, date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, status: 'pending', slug: null });
    leads.sort((a, b) => b.date.localeCompare(a.date));
    writeJson(LEADS_JSON, leads);
    return { ok: true };
}

function removeLeads(body: Body) {
    const leads = readLeads();
    const picked = new Set(leadUrls(leads, body.urls));
    const withArticle = [...picked].find((l) => l.slug && fs.existsSync(articleFile(l.slug)));
    if (withArticle) throw new HttpError(409, `"${withArticle.title}" has an article — remove the article first`);
    writeJson(LEADS_JSON, leads.filter((l) => !picked.has(l)));
    return { removed: picked.size };
}

function runLeadScrape() {
    if (leadSlot.proc) throw new HttpError(409, `${leadSlot.job?.mode} is already running`);
    const pages = fs.existsSync(path.join(LEADS_DIR, 'pages'));
    const args = pages ? ['--html-dir', 'pages'] : [];
    return startCommand(leadSlot, ['python3', 'scrape.py', ...args], ['python3 scrape.py', ...args].join(' '), { mode: 'scrape', scopes: [] }, LEADS_DIR);
}

function runBlogBuild() {
    if (leadSlot.proc) throw new HttpError(409, `${leadSlot.job?.mode} is already running`);
    return startCommand(leadSlot, [BUN, 'run', 'build'], 'bun run build', { mode: 'build', scopes: [] }, BLOG_DIR);
}

/** Commits just this article's file (new, edited or deleted) and pushes main, which deploys the blog. */
function deployArticle(body: Body) {
    if (leadSlot.proc) throw new HttpError(409, `${leadSlot.job?.mode} is already running`);
    const slug = blogSlug(body.slug);
    const rel = `${BLOG_ARTICLES}/${slug}.md`;
    const branch = gitIn(BLOG_DIR, 'branch', '--show-current').out.trim();
    if (branch !== 'main') throw new HttpError(409, `The blog repo is on ${branch || 'a detached HEAD'}, not main`);
    if (!blogGitState().changed.has(rel)) throw new HttpError(400, 'Nothing to deploy — the article matches the last commit');
    const exists = fs.existsSync(articleFile(slug));
    const message = str(body.message).trim() || (exists ? `Add new article ${slug}` : `Remove article ${slug}`);
    return startCommand(
        leadSlot,
        ['sh', '-c', 'git add -A -- "$1" && git commit -m "$2" -- "$1" && git push origin main', 'sh', rel, message],
        `git add -A -- ${rel} && git commit -m ${JSON.stringify(message)} && git push origin main`,
        { mode: `deploy ${slug}`, scopes: [slug] },
        BLOG_DIR,
    );
}

async function checkLive(params: URLSearchParams) {
    const slug = blogSlug(params.get('slug'));
    const info = articleInfo(slug);
    if (!info) throw new HttpError(404, 'No article file');
    const url = `${BLOG_URL}/article/${slug}/`;
    // The site answers 200 with a generic page for any path, so look for the title.
    const html = await fetch(url, { headers: { 'cache-control': 'no-cache' } }).then((r) => r.text()).catch(() => '');
    return { url, live: !!info.title && html.includes(info.title) };
}

function readBlogArticle(params: URLSearchParams) {
    const slug = blogSlug(params.get('slug'));
    if (!fs.existsSync(articleFile(slug))) throw new HttpError(404, 'No article file');
    return { text: fs.readFileSync(articleFile(slug), 'utf-8'), path: `${BLOG_ARTICLES}/${slug}.md` };
}

function saveBlogArticle(body: Body) {
    const slug = blogSlug(body.slug);
    if (!fs.existsSync(articleFile(slug))) throw new HttpError(404, 'No article file');
    const text = str(body.text).replace(/\r\n/g, '\n');
    if (!/^---\n[\s\S]*?\ntitle:[\s\S]*?\n---\n/.test(text)) throw new HttpError(400, 'The file must start with a --- frontmatter block that has a title');
    fs.writeFileSync(articleFile(slug), text.endsWith('\n') ? text : text + '\n');
    return { ok: true };
}

/** Deletes the article file and puts its lead back to pending or skipped. Deploy afterwards to take it off the site. */
function removeBlogArticle(body: Body) {
    const slug = blogSlug(body.slug);
    if (str(body.confirm) !== slug) throw new HttpError(400, 'Removal not confirmed');
    const status = str(body.status) === 'skipped' ? 'skipped' : 'pending';
    const leads = readLeads();
    const lead = leads.find((l) => l.slug === slug);
    if (fs.existsSync(articleFile(slug))) fs.rmSync(articleFile(slug));
    if (lead) {
        lead.status = status;
        lead.slug = null;
        delete lead.x_url;
        writeJson(LEADS_JSON, leads);
    }
    return { ok: true, live: gitIn(BLOG_DIR, 'cat-file', '-e', `origin/main:${BLOG_ARTICLES}/${slug}.md`).ok };
}

function setXUrl(body: Body) {
    const leads = readLeads();
    const lead = leadByUrl(leads, body.url);
    const x = str(body.x_url).trim();
    if (!x) {
        delete lead.x_url;
        if (lead.status === 'published') lead.status = 'written';
    } else {
        if (!/^https:\/\/(x|twitter)\.com\/\w+\/(status|article)\/\d+/.test(x)) throw new HttpError(400, 'Expected an x.com post or article URL');
        if (!lead.slug) throw new HttpError(400, 'This lead has no article yet');
        lead.x_url = x;
        lead.status = 'published';
    }
    writeJson(LEADS_JSON, leads);
    return { ok: true };
}

/** The skill's X paste step: the built <article> as rich text on the clipboard, plus the blog link. */
function copyForX(body: Body) {
    const slug = blogSlug(body.slug);
    const built = path.join(BLOG_DIR, 'dist/article', slug, 'index.html');
    if (!fs.existsSync(built)) throw new HttpError(400, 'Not built yet — run "Build blog" first');
    if (fs.statSync(built).mtimeMs < fs.statSync(articleFile(slug)).mtimeMs) throw new HttpError(400, 'The article changed since the last build — run "Build blog" first');
    const article = /<article[\s\S]*?<\/article>/.exec(fs.readFileSync(built, 'utf-8'))?.[0];
    if (!article) throw new HttpError(500, 'No <article> in the built page');
    const clean = article
        .replace(/<(script|style)[\s\S]*?<\/\1>/g, '')
        .replace(/\s(?:class|style|id|data-[\w-]+)=("[^"]*"|'[^']*')/g, '');
    const link = `${BLOG_URL}/article/${slug}`;
    const html = `<html dir="rtl"><meta charset="utf-8"><body>${clean}<p>نُشر أولا على مدونتي: ${link}</p></body></html>`;
    const rtf = Bun.spawnSync(['textutil', '-convert', 'rtf', '-format', 'html', '-stdin', '-stdout'], { stdin: Buffer.from(html) });
    if (rtf.exitCode !== 0) throw new HttpError(500, rtf.stderr.toString() || 'textutil failed');
    const copy = Bun.spawnSync(['pbcopy', '-Prefer', 'rtf'], { stdin: rtf.stdout });
    if (copy.exitCode !== 0) throw new HttpError(500, 'pbcopy failed');
    return { ok: true, thumb: articleInfo(slug)?.thumb ?? null };
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Opens Terminal on the blog repo running an interactive `claude <prompt>`. */
function openClaude(prompt: string, flags: string[] = []) {
    const command = `cd ${shellQuote(BLOG_DIR)} && claude ${flags.join(' ')} ${shellQuote(prompt)}`.replace(/ {2,}/g, ' ');
    const script = `tell application "Terminal"\nactivate\ndo script "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
    const res = Bun.spawnSync(['osascript', '-e', script]);
    if (res.exitCode !== 0) throw new HttpError(500, res.stderr.toString() || 'Could not open Terminal');
    return { ok: true, command };
}

function writeLeads(body: Body) {
    const picked = leadUrls(readLeads(), body.urls);
    const taken = picked.find((l) => l.slug && fs.existsSync(articleFile(l.slug)));
    if (taken) throw new HttpError(409, `"${taken.title}" already has an article`);
    const [first, ...rest] = picked.map((l) => l.url);
    const prompt = rest.length
        ? `/functional-food-leads write ${first} — then run Mode write the same way, one at a time, for each of these leads too: ${rest.join(' ')}`
        : `/functional-food-leads write ${first}`;
    return openClaude(prompt);
}

function publishLead(body: Body) {
    const slug = blogSlug(body.slug);
    if (!fs.existsSync(articleFile(slug))) throw new HttpError(404, 'No article file');
    return openClaude(`/functional-food-leads publish ${slug}`, ['--chrome']);
}

function leadJob(params: URLSearchParams) {
    return { job: leadSlot.job ? publicJob(leadSlot.job, Number(params.get('from')) || 0) : null };
}

// ─── Stats ────────────────────────────────────────────────────────────────────
// Everything is by created_at (the post's publish date): the catalog doesn't
// record when an article was imported.

const DAY = 86_400_000;

/** Monday of the article's week, YYYY-MM-DD. */
function weekOf(date: string) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
}

let mostReadCache: { at: number; value: unknown } | null = null;

/** The views worker's leaderboard, mapped to titles. */
async function mostRead() {
    if (mostReadCache && Date.now() - mostReadCache.at < 60_000) return mostReadCache.value;
    let value: unknown;
    try {
        const res = await fetch(`${SITE}/api/most-read?limit=25`, { signal: AbortSignal.timeout(6000) });
        const body = (await res.json()) as { items?: { slug: string; count: number }[] };
        const bySlug = new Map(rows().map((r) => [r.article.slug, r]));
        value = {
            items: (body.items ?? []).map((e) => {
                const r = bySlug.get(e.slug);
                return { ...e, title: r?.article.title, screen_name: r?.article.screen_name, category: r?.category };
            }),
        };
    } catch (err) {
        value = { error: `Could not reach ${SITE}/api/most-read: ${err}` };
    }
    mostReadCache = { at: Date.now(), value };
    return value;
}

async function statsDashboard() {
    const now = Date.now();
    const todayStr = today();
    const blogSlugs = new Set(registeredBlogs().map((b) => b.slug));
    const sourceOf = (a: Article) => {
        if (blogSlugs.has(a.screen_name)) return 'blogs';
        const host = URL.parse(a.url ?? '')?.hostname ?? '';
        return host === 'substack.com' || host.endsWith('.substack.com') ? 'substack' : 'other';
    };
    const ago = (date: string) => (now - Date.parse(`${date}T00:00:00Z`)) / DAY;

    const WEEKS = 26;
    const firstWeek = weekOf(new Date(now - (WEEKS - 1) * 7 * DAY).toISOString().slice(0, 10));
    const weeks = new Map<string, { week: string; total: number; substack: number; blogs: number; other: number }>();
    for (let i = 0; i < WEEKS; i++) {
        const week = new Date(Date.parse(`${firstWeek}T00:00:00Z`) + i * 7 * DAY).toISOString().slice(0, 10);
        weeks.set(week, { week, total: 0, substack: 0, blogs: 0, other: 0 });
    }
    const sources = { substack: { total: 0, last30: 0, authors: new Set<string>() }, blogs: { total: 0, last30: 0, authors: new Set<string>() }, other: { total: 0, last30: 0, authors: new Set<string>() } };
    const categories = new Map<string, { category: string; title: string; total: number; last7: number; last30: number }>();
    const authors = new Map<string, { screen_name: string; total: number; last90: number; latest: string; source: string; image?: string | undefined }>();
    let future = 0;

    for (const cat of data.articles) categories.set(cat.category, { category: cat.category, title: cat.title, total: 0, last7: 0, last30: 0 });
    for (const r of rows()) {
        const a = r.article;
        const src = sourceOf(a);
        const valid = DATE_RE.test(a.created_at ?? '');
        const age = valid ? ago(a.created_at) : Infinity;
        if (valid && a.created_at > todayStr) future++;
        const c = categories.get(r.category)!;
        c.total++;
        if (age < 7) c.last7++;
        if (age < 30) c.last30++;
        sources[src].total++;
        sources[src].authors.add(a.screen_name);
        if (age < 30) sources[src].last30++;
        const w = valid ? weeks.get(weekOf(a.created_at)) : undefined;
        if (w) {
            w.total++;
            w[src]++;
        }
        let au = authors.get(a.screen_name);
        if (!au) authors.set(a.screen_name, (au = { screen_name: a.screen_name, total: 0, last90: 0, latest: '', source: src }));
        au.total++;
        if (age < 90) au.last90++;
        if (valid && a.created_at > au.latest) au.latest = a.created_at;
        au.image ??= a.profile_image_url_https;
    }

    const authorList = [...authors.values()];
    return {
        total: rows().length,
        future,
        weeks: [...weeks.values()],
        sources: Object.entries(sources).map(([source, s]) => ({ source, total: s.total, last30: s.last30, authors: s.authors.size })),
        categories: [...categories.values()].sort((a, b) => b.total - a.total),
        topAuthors: authorList.sort((a, b) => b.total - a.total).slice(0, 25),
        // Regular writers (5+ articles) whose newest post is over 60 days old.
        stale: authorList
            .filter((a) => a.total >= 5 && a.latest && ago(a.latest) > 60)
            .sort((a, b) => b.total - a.total)
            .slice(0, 60)
            .map((a) => ({ ...a, daysSilent: Math.floor(ago(a.latest)) })),
        totalAuthors: authors.size,
        mostRead: await mostRead(),
    };
}

// ─── Server ───────────────────────────────────────────────────────────────────

class HttpError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

// ─── Push notifications ──────────────────────────────────────────────────────
// Subscribers live in the push Worker's remote D1 database (workers/push/).
// A send here only queues rows in its outbox; the Worker's cron trigger
// delivers them, PUSH_BATCH every 5 minutes.

const PUSH_DIR = path.join(ROOT, 'workers', 'push');
const PUSH_BATCH = 40;
const pushD1 = (sql: string) => d1Results(sql, 'elhellal-push', PUSH_DIR);
const sqlText = (value: string) => `'${value.replace(/'/g, "''")}'`;

function pushTarget(category: string) {
    return category ? `categories = '*' OR categories LIKE ${sqlText(`%,${category},%`)}` : '1';
}

async function pushStats() {
    const [totals, categoryRows, events, outbox, broadcasts] = await pushD1(
        [
            "SELECT COUNT(*) AS total, COALESCE(SUM(frequency = 'daily'), 0) AS daily, COALESCE(SUM(frequency = 'weekly'), 0) AS weekly, COALESCE(SUM(categories = '*'), 0) AS everything FROM subscriptions",
            "SELECT categories FROM subscriptions WHERE categories != '*'",
            "SELECT day, name, n FROM events WHERE day >= date('now', '-14 day') ORDER BY day DESC",
            'SELECT COUNT(*) AS pending FROM outbox',
            'SELECT * FROM broadcasts ORDER BY id DESC LIMIT 15',
        ].join('; ')
    );
    const byCategory = new Map<string, number>();
    for (const row of categoryRows ?? []) {
        for (const c of String(row.categories).split(',').filter(Boolean)) byCategory.set(c, (byCategory.get(c) ?? 0) + 1);
    }
    return {
        totals: totals?.[0],
        categories: [...byCategory].sort((a, b) => b[1] - a[1]).map(([category, n]) => ({ category, n })),
        events,
        pending: outbox?.[0]?.pending ?? 0,
        batch: PUSH_BATCH,
        broadcasts,
    };
}

async function pushSend(body: Body) {
    const title = String(body.title ?? '').trim();
    const text = String(body.body ?? '').trim();
    const url = String(body.url ?? '/').trim() || '/';
    const category = String(body.category ?? '').trim();
    if (!title || title.length > 80) throw new HttpError(400, 'Title is required (80 characters max)');
    if (!text || text.length > 240) throw new HttpError(400, 'Body is required (240 characters max)');
    if (!url.startsWith('/') && !url.startsWith('https://elhellal.com/')) throw new HttpError(400, 'URL must be a path on elhellal.com');
    if (category && !/^[a-z0-9-]{1,40}$/.test(category)) throw new HttpError(400, 'Invalid category');

    const now = Date.now();
    const payload = JSON.stringify({ title, body: text, url, tag: `broadcast-${now}` });
    const where = pushTarget(category);
    const [count] = await pushD1(
        [
            `SELECT COUNT(*) AS n FROM subscriptions WHERE ${where}`,
            `INSERT INTO broadcasts (title, body, url, target, queued, created_at) SELECT ${sqlText(title)}, ${sqlText(text)}, ${sqlText(url)}, ${sqlText(category || '*')}, COUNT(*), ${now} FROM subscriptions WHERE ${where}`,
            `INSERT INTO outbox (endpoint, payload, created_at) SELECT endpoint, ${sqlText(payload)}, ${now} FROM subscriptions WHERE ${where}`,
        ].join('; ')
    );
    return { queued: count?.[0]?.n ?? 0 };
}

async function pushClearOutbox() {
    await pushD1('DELETE FROM outbox');
    return { ok: true };
}

const POST: Record<string, (body: Body) => unknown | Promise<unknown>> = {
    '/api/remove': removeAction,
    '/api/authors/block': blockAuthor,
    '/api/authors/unblock': unblockAuthor,
    '/api/restore': restoreArticle,
    '/api/edit': editArticle,
    '/api/decide': decide,
    '/api/reload': () => (reload(), { ok: true }),
    '/api/pins/run': runPins,
    '/api/pins/stop': () => stopJob(pinSlot),
    '/api/import/run': runImport,
    '/api/import/stop': () => stopJob(importSlot),
    '/api/candidates/add': addCandidates,
    '/api/candidates/remove': removeCandidates,
    '/api/candidates/merge': () => ({ added: mergeDiscovery() }),
    '/api/discover/run': runDiscover,
    '/api/discover/stop': () => stopJob(discoverSlot),
    '/api/publish/run': runPublish,
    '/api/publish/stop': () => stopJob(publishSlot),
    '/api/publish/commit': commitData,
    '/api/health/rewrite': rewriteCatalog,
    '/api/social/run': runSocial,
    '/api/social/stop': () => stopJob(socialSlot),
    '/api/social/open': openOutput,
    '/api/media/delete': deleteMedia,
    '/api/sites/run': runSite,
    '/api/sites/stop': () => stopJob(sitesSlot),
    '/api/sites/commit': commitSite,
    '/api/quotes/edit': editQuote,
    '/api/quotes/remove': removeQuotes,
    '/api/quotes/remove-author': removeQuoteAuthor,
    '/api/entries/save': saveEntry,
    '/api/entries/remove': removeEntry,
    '/api/entries/markdown': saveMarkdown,
    '/api/quiz/bank/edit': editBank,
    '/api/leads/status': setLeadStatus,
    '/api/leads/add': addLead,
    '/api/leads/remove': removeLeads,
    '/api/leads/scrape': runLeadScrape,
    '/api/leads/build': runBlogBuild,
    '/api/leads/deploy': deployArticle,
    '/api/leads/stop': () => stopJob(leadSlot),
    '/api/leads/article': saveBlogArticle,
    '/api/leads/article/remove': removeBlogArticle,
    '/api/leads/x-url': setXUrl,
    '/api/leads/copy-x': copyForX,
    '/api/leads/write': writeLeads,
    '/api/leads/publish': publishLead,
    '/api/push/send': pushSend,
    '/api/push/clear': pushClearOutbox,
};

const GET: Record<string, (params: URLSearchParams) => unknown | Promise<unknown>> = {
    '/api/stats': stats,
    '/api/articles': listArticles,
    '/api/authors': listAuthors,
    '/api/review': listReview,
    '/api/blocked': listBlocked,
    '/api/pins/status': pinStatus,
    '/api/pins/job': pinJobState,
    '/api/import/job': importState,
    '/api/candidates': listCandidates,
    '/api/discover/job': discoverState,
    '/api/publish/job': publishState,
    '/api/publish/git': gitState,
    '/api/health': listHealth,
    '/api/social/job': socialState,
    '/api/social/snippet': socialSnippet,
    '/api/media': listMedia,
    '/api/dashboard': statsDashboard,
    '/api/sites': sitesOverview,
    '/api/sites/job': sitesJob,
    '/api/quotes': listQuotes,
    '/api/entries': listCollection,
    '/api/entries/markdown': readMarkdown,
    '/api/quiz/bank': listBank,
    '/api/quiz/reports': quizReports,
    '/api/leads': listLeads,
    '/api/blog/articles': listBlogArticles,
    '/api/leads/job': leadJob,
    '/api/leads/live': checkLive,
    '/api/leads/article': readBlogArticle,
    '/api/push/stats': pushStats,
};

Bun.serve({
    hostname: '127.0.0.1',
    port: PORT,
    async fetch(req: Request) {
        const url = new URL(req.url);
        // Reject other hostnames (DNS rebinding) and cross-site writes: browsers
        // won't send the custom header cross-origin without a preflight we never answer.
        if (!HOSTS.has(req.headers.get('host') ?? '')) return new Response('Forbidden', { status: 403 });
        try {
            if (req.method === 'GET' && url.pathname === '/') {
                return new Response(Bun.file(PAGE), { headers: { 'content-type': 'text/html; charset=utf-8' } });
            }
            if (req.method === 'GET' && GET[url.pathname]) return json(await GET[url.pathname]!(url.searchParams));
            if (req.method === 'POST' && POST[url.pathname]) {
                const origin = req.headers.get('origin');
                if (req.headers.get('x-admin') !== '1' || (origin && !HOSTS.has(URL.parse(origin)?.host ?? ''))) {
                    return new Response('Forbidden', { status: 403 });
                }
                const body = ((await req.json().catch(() => ({}))) ?? {}) as Body;
                return json(await POST[url.pathname]!(body));
            }
            return new Response('Not found', { status: 404 });
        } catch (err) {
            if (err instanceof HttpError) return json({ error: err.message }, err.status);
            console.error(err);
            return json({ error: String(err) }, 500);
        }
    },
});

console.log(`🛠️  Admin panel: http://localhost:${PORT}`);
console.log('   Changes are written to src/data/ immediately — review with `git diff`.');
