#!/usr/bin/env bun
/**
 * Local admin panel for the catalog: search, edit, move and remove articles,
 * block authors, and settle the moderation script's "review" verdicts.
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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Article, ArticlesConfig } from '../src/types/index.ts';
import { readArticles, writeArticles } from '../src/lib/articles-store.ts';
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
/** Written by the old importers until the P6 cutover; migrate-to-catalog copies it over the catalog. */
const LEGACY_FILE = path.join(process.cwd(), 'src/data/articles.json');

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
        // Until the P6 cutover, migrate-to-catalog copies articles.json over the catalog;
        // it skips blocklisted articles, but edits and moves made here would be lost.
        legacyFile: fs.existsSync(LEGACY_FILE),
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

// ─── Server ───────────────────────────────────────────────────────────────────

class HttpError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

const POST: Record<string, (body: Body) => unknown> = {
    '/api/remove': removeAction,
    '/api/authors/block': blockAuthor,
    '/api/authors/unblock': unblockAuthor,
    '/api/restore': restoreArticle,
    '/api/edit': editArticle,
    '/api/decide': decide,
    '/api/reload': () => (reload(), { ok: true }),
};

const GET: Record<string, (params: URLSearchParams) => unknown> = {
    '/api/stats': stats,
    '/api/articles': listArticles,
    '/api/authors': listAuthors,
    '/api/review': listReview,
    '/api/blocked': listBlocked,
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
            if (req.method === 'GET' && GET[url.pathname]) return json(GET[url.pathname]!(url.searchParams));
            if (req.method === 'POST' && POST[url.pathname]) {
                const origin = req.headers.get('origin');
                if (req.headers.get('x-admin') !== '1' || (origin && !HOSTS.has(URL.parse(origin)?.host ?? ''))) {
                    return new Response('Forbidden', { status: 403 });
                }
                const body = ((await req.json().catch(() => ({}))) ?? {}) as Body;
                return json(POST[url.pathname]!(body));
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
