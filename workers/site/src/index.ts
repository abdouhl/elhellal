/**
 * Site Worker for elhellal.com.
 *
 * Static files are served by Cloudflare's asset layer without running this
 * Worker (free, no request quota). The Worker runs for /articles/*, /tags/*
 * and /authors/* (see run_worker_first in wrangler.jsonc) and for
 * non-navigation requests to paths with no file — on the free plan that's
 * 100k requests/day and 10ms CPU per request, so everything here is
 * deliberately cheap, and every page is cached at the edge:
 *
 *   /articles/<slug>/     → one shard from dist/_data/articles/ + string
 *                           template fill (src/lib/shell-template.ts)
 *   /tags/<slug>/,
 *   /authors/<name>/      → one shard from dist/_data/listings/ + template
 *                           fill + a server render of the MasonryFeed island
 *                           (≤ LISTING_INITIAL cards)
 *   names not in the data → the asset layer (prerendered personal-blog posts
 *                           and writers, the tag/author indexes, else 404)
 *   anything else         → the asset layer
 *
 * The shells and shard data are produced by `bun run build`
 * (scripts/build-worker-data.ts).
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import articleShell from '../../../.worker-build/article-shell.html';
import tagShell from '../../../.worker-build/tag-shell.html';
import authorShell from '../../../.worker-build/author-shell.html';
import meta from '../../../.worker-build/meta.json';
import MasonryFeed from '../../../src/components/MasonryFeed';
import { articleTemplateData, shardOf, type ArticleShard } from '../../../src/lib/article-page';
import {
    listingFeedProps,
    listingKey,
    listingShardOf,
    listingTemplateData,
    type ListingKind,
    type ListingShard,
} from '../../../src/lib/listing-page';
import { serializeIslandProps } from '../../../src/lib/island-props';
import { escapeHtml, fillTemplate } from '../../../src/lib/shell-template';

interface Env {
    ASSETS: Fetcher;
}

const PAGE_PATH = /^\/(articles|tags|authors)\/([^/]+)(\/?)$/;
const LISTING_KIND: Record<string, ListingKind> = { tags: 'tag', authors: 'author' };
const LISTING_SHELL: Record<ListingKind, string> = { tag: tagShell, author: authorShell };
const PAGE_CACHE_SECONDS = 60 * 60 * 24;

async function notFound(request: Request, env: Env): Promise<Response> {
    // The asset layer answers unknown paths with dist/404.html and a 404 status.
    return env.ASSETS.fetch(new Request(new URL('/404-not-found/', request.url), request));
}

async function readShard<T>(request: Request, env: Env, path: string): Promise<T | null> {
    const res = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
    return res.ok ? ((await res.json()) as T) : null;
}

function htmlResponse(html: string): Response {
    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': `public, max-age=300, s-maxage=${PAGE_CACHE_SECONDS}`,
        },
    });
}

async function renderArticle(request: Request, env: Env, slug: string): Promise<Response> {
    const shard = await readShard<ArticleShard>(request, env, `/_data/articles/${shardOf(slug)}.json`);
    if (!shard) return notFound(request, env);
    const record = shard[slug];
    // Not a data article: maybe a prerendered one (personal-blog posts), else the 404 page.
    if (!record) return env.ASSETS.fetch(request);
    return htmlResponse(fillTemplate(articleShell, articleTemplateData(record)));
}

async function renderListing(request: Request, env: Env, kind: ListingKind, name: string): Promise<Response> {
    const key = listingKey(kind, name);
    const shard = await readShard<ListingShard>(request, env, `/_data/listings/${listingShardOf(key)}.json`);
    if (!shard) return notFound(request, env);
    const record = shard[key];
    // Not in the data: a prerendered page (personal-blog writers), else the 404 page.
    if (!record) return env.ASSETS.fetch(request);

    const props = listingFeedProps(record, meta.categoryTitles);
    return htmlResponse(
        fillTemplate(LISTING_SHELL[kind], {
            ...listingTemplateData(record),
            feedProps: escapeHtml(serializeIslandProps(props)),
            feedHtml: renderToString(createElement(MasonryFeed, props)),
        })
    );
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const match = url.pathname.match(PAGE_PATH);
        if (!match || (request.method !== 'GET' && request.method !== 'HEAD')) {
            return env.ASSETS.fetch(request);
        }
        const [, section, encodedName, slash] = match;

        // Canonical page URLs end with a slash (as the static pages did).
        if (!slash) {
            url.pathname += '/';
            return Response.redirect(url.toString(), 301);
        }

        let name: string;
        try {
            name = decodeURIComponent(encodedName!);
        } catch {
            return notFound(request, env);
        }

        // Cache key includes the build id: a deploy changes the shells' asset
        // hashes and the data, so pages cached by the previous build must miss.
        const cacheKey = new Request(`https://cache.elhellal.internal/${meta.buildId}${url.pathname}`);
        // DOM's CacheStorage type (needed for the server-rendered components)
        // hides workerd's `default` cache.
        const cache = (caches as CacheStorage & { default: Cache }).default;
        const cached = await cache.match(cacheKey);
        if (cached) return cached;

        const kind = LISTING_KIND[section!];
        const response = kind
            ? await renderListing(request, env, kind, name)
            : await renderArticle(request, env, name);
        if (response.status === 200) {
            ctx.waitUntil(cache.put(cacheKey, response.clone()));
        }
        return response;
    },
} satisfies ExportedHandler<Env>;
