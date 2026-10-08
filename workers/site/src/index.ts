/**
 * Site Worker for elhellal.com.
 *
 * Static files are served by Cloudflare's asset layer without running this
 * Worker (free, no request quota). The Worker runs for /articles/* (see
 * run_worker_first in wrangler.jsonc) and for non-navigation requests to
 * paths with no file — on the free plan that's 100k requests/day and 10ms
 * CPU per request, so everything here is deliberately cheap:
 *
 *   /articles/<slug>/  → one shard read from static assets + string template
 *                        fill (src/lib/shell-template.ts), cached at the edge;
 *                        slugs not in the data fall through to the assets
 *                        (prerendered personal-blog posts, else the 404 page)
 *   anything else      → handed back to the asset layer
 *
 * The article shell and shard data are produced by `bun run build`
 * (scripts/build-worker-data.ts).
 */

import shell from '../../../.worker-build/article-shell.html';
import meta from '../../../.worker-build/meta.json';
import { articleTemplateData, shardOf, type ArticleShard } from '../../../src/lib/article-page';
import { fillTemplate } from '../../../src/lib/shell-template';

interface Env {
    ASSETS: Fetcher;
}

const ARTICLE_PATH = /^\/articles\/([^/]+)(\/?)$/;
const PAGE_CACHE_SECONDS = 60 * 60 * 24;

async function notFound(request: Request, env: Env): Promise<Response> {
    // The asset layer answers unknown paths with dist/404.html and a 404 status.
    return env.ASSETS.fetch(new Request(new URL('/404-not-found/', request.url), request));
}

async function renderArticle(request: Request, env: Env, slug: string): Promise<Response> {
    const shardUrl = new URL(`/_data/articles/${shardOf(slug)}.json`, request.url);
    const shardRes = await env.ASSETS.fetch(new Request(shardUrl));
    if (!shardRes.ok) return notFound(request, env);

    const shard = (await shardRes.json()) as ArticleShard;
    const record = shard[slug];
    // Not a data article: maybe a prerendered one (personal-blog posts), else the 404 page.
    if (!record) return env.ASSETS.fetch(request);

    const html = fillTemplate(shell, articleTemplateData(record));
    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': `public, max-age=300, s-maxage=${PAGE_CACHE_SECONDS}`,
        },
    });
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        const match = url.pathname.match(ARTICLE_PATH);
        if (!match || (request.method !== 'GET' && request.method !== 'HEAD')) {
            return env.ASSETS.fetch(request);
        }

        // Canonical article URLs end with a slash (as the static pages did).
        if (!match[2]) {
            url.pathname += '/';
            return Response.redirect(url.toString(), 301);
        }

        let slug: string;
        try {
            slug = decodeURIComponent(match[1]!);
        } catch {
            return notFound(request, env);
        }

        // Cache key includes the build id: a deploy changes the shell's asset
        // hashes and the data, so pages cached by the previous build must miss.
        const cacheKey = new Request(`https://cache.elhellal.internal/${meta.buildId}${url.pathname}`);
        const cache = caches.default;
        const cached = await cache.match(cacheKey);
        if (cached) return cached;

        const response = await renderArticle(request, env, slug);
        if (response.status === 200) {
            ctx.waitUntil(cache.put(cacheKey, response.clone()));
        }
        return response;
    },
} satisfies ExportedHandler<Env>;
