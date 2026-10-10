/**
 * Service worker for elhellal.com — makes the installed app work offline and
 * receives push notifications (workers/push/).
 *
 * Caching, by request:
 *   pages (HTML)          network first (falls back to the cache after
 *                         NETWORK_TIMEOUT_MS on a slow connection), then any
 *                         cached copy, then /offline/
 *   /_data/ shards        network first, then the cache — never stale-first,
 *                         since a fresh page must not read last build's shards
 *   /_astro/, /fonts/     cache first (content-hashed / renamed on change)
 *   cover images          cache first, CORS-fetched so the cache holds real
 *                         (not opaque, quota-padded) responses; an SVG
 *                         placeholder when offline
 *   /api/, ads, the rest  untouched
 *
 * Saved articles (src/utils/bookmarks.ts) are mirrored into their own cache,
 * which is never trimmed: the page sends the full list of their URLs
 * ({ type: 'sync-saved' }, src/scripts/pwa.ts) whenever bookmarks change.
 *
 * scripts/build-worker-data.ts stamps the build id below into dist/sw.js, so
 * every deploy installs a new worker and refreshes the precache. Pages are
 * network first, so the new worker takes over at once (skipWaiting) without
 * an "update available" prompt.
 */

const VERSION = '__BUILD_ID__';
const PRECACHE = `precache-${VERSION}`;
const PAGES = 'pages';
const DATA = 'data';
const STATIC = 'static';
const IMAGES = 'images';
const SAVED = 'saved';
const LIMITS = { [PAGES]: 80, [DATA]: 150, [STATIC]: 200, [IMAGES]: 300 };
const NETWORK_TIMEOUT_MS = 4000;

const PRECACHE_URLS = [
    '/',
    '/saved/',
    '/offline/',
    '/manifest.json',
    '/xarticles.svg',
    '/icon-192.png',
    '/fonts/rom-regular-latin.woff2',
    '/fonts/rom-bold-latin.woff2',
    '/fonts/rom-mono-latin.woff2',
];

const IMAGE_HOSTS = /(^|\.)(substackcdn\.com|xarticl\.es|elhellal\.com|unsplash\.com)$/;

const OFFLINE_IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 225"><rect width="400" height="225" fill="#1a1a1a"/><path d="M200 82a30 30 0 1 0 22 52 24 24 0 1 1-22-52z" fill="#444"/></svg>`;

self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(PRECACHE);
            await cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: 'reload' })));
            // The precached pages' scripts (CSS is inlined), so they run offline too.
            const assets = new Set();
            for (const url of PRECACHE_URLS.filter((u) => u.endsWith('/'))) {
                const html = await (await cache.match(url)).text();
                for (const m of html.matchAll(/["'](\/_astro\/[^"'?#]+)/g)) assets.add(m[1]);
            }
            const statics = await caches.open(STATIC);
            await Promise.all([...assets].map((url) => statics.add(url).catch(() => {})));
            await self.skipWaiting();
        })()
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            const names = await caches.keys();
            await Promise.all(
                names.filter((n) => n.startsWith('precache-') && n !== PRECACHE).map((n) => caches.delete(n))
            );
            if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
            await self.clients.claim();
        })()
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    if (url.origin === self.location.origin) {
        const p = url.pathname;
        if (p.startsWith('/api/') || p === '/sw.js') return;
        if (p.startsWith('/_astro/') || p.startsWith('/fonts/')) {
            event.respondWith(cacheFirst(event, STATIC));
        } else if (p.startsWith('/_data/')) {
            event.respondWith(networkFirst(event, DATA));
        } else if (isPage(req, url)) {
            event.respondWith(page(event));
        } else if (req.destination === 'image') {
            event.respondWith(image(event));
        }
        return;
    }

    if (req.destination === 'image' && IMAGE_HOSTS.test(url.hostname)) {
        event.respondWith(image(event));
    }
});

function isPage(req, url) {
    if (req.mode === 'navigate') return true;
    // Astro's client router fetches the next page with a plain fetch().
    return url.pathname.endsWith('/') && (req.headers.get('Accept') || '').includes('text/html');
}

function isHtml(res) {
    return (res.headers.get('Content-Type') || '').includes('text/html');
}

/** Resolves to undefined after ms, so a slow network can lose to the cache. */
function timeout(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function trim(cacheName) {
    const limit = LIMITS[cacheName];
    if (!limit) return;
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    // Keys come back in insertion order: drop the oldest.
    for (const key of keys.slice(0, Math.max(0, keys.length - limit))) await cache.delete(key);
}

/** Caches res under url; also refreshes the saved copy of a bookmarked page or shard. */
async function store(cacheName, url, res) {
    const saved = await caches.open(SAVED);
    if (await saved.match(url)) await saved.put(url, res.clone());
    const cache = await caches.open(cacheName);
    await cache.put(url, res);
    await trim(cacheName);
}

/**
 * Starts the network request and caches a copy of the response when keep(res)
 * says so, keeping the worker alive until that write is done.
 */
function fetchAndStore(event, request, cacheName, url, keep) {
    let saving = Promise.resolve();
    const network = request.then((res) => {
        if (keep(res)) saving = store(cacheName, url, res.clone());
        return res;
    });
    event.waitUntil(network.then(() => saving).catch(() => {}));
    return network;
}

async function page(event) {
    const req = event.request;
    const network = fetchAndStore(
        event,
        Promise.resolve(event.preloadResponse).then((preloaded) => preloaded || fetch(req)),
        PAGES,
        stripSearch(req.url),
        // A redirected response can't answer a navigation later, and error
        // pages aren't worth keeping.
        (res) => res.ok && !res.redirected && res.type === 'basic' && isHtml(res)
    );
    try {
        const first = await Promise.race([network, timeout(NETWORK_TIMEOUT_MS)]);
        if (first) return first;
        // Slow network: answer from the cache if we can, else keep waiting.
        return (await caches.match(req, { ignoreSearch: true })) || (await network);
    } catch {
        const copy = await caches.match(req, { ignoreSearch: true });
        if (copy) return copy;
        if (req.mode === 'navigate') {
            const offline = await caches.match('/offline/');
            if (offline) return offline;
        }
        return Response.error();
    }
}

async function networkFirst(event, cacheName) {
    const req = event.request;
    const network = fetchAndStore(event, fetch(req), cacheName, req.url, (res) => res.ok);
    try {
        const first = await Promise.race([network, timeout(NETWORK_TIMEOUT_MS)]);
        if (first) return first;
    } catch {
        // fall through to the cache
    }
    const copy = await caches.match(req);
    if (copy) return copy;
    return network.catch(() => new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } }));
}

async function cacheFirst(event, cacheName) {
    const req = event.request;
    const copy = await caches.match(req);
    if (copy) return copy;
    return fetchAndStore(event, fetch(req), cacheName, req.url, (res) => res.ok);
}

async function image(event) {
    const req = event.request;
    const copy = await caches.match(req.url);
    if (copy) return copy;
    try {
        // <img> requests are no-cors; their opaque responses would each count
        // ~7 MB against the storage quota. The image CDNs send CORS headers,
        // so fetch a readable copy instead.
        return await fetchAndStore(event, fetch(req.url, { mode: 'cors', credentials: 'omit' }), IMAGES, req.url, (res) => res.ok);
    } catch {
        try {
            return await fetch(req);
        } catch {
            return new Response(OFFLINE_IMAGE, { headers: { 'Content-Type': 'image/svg+xml' } });
        }
    }
}

function stripSearch(href) {
    const url = new URL(href);
    return url.origin + url.pathname;
}

// ─── Saved articles ──────────────────────────────────────────────────────────

self.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'sync-saved' && Array.isArray(msg.urls)) {
        event.waitUntil(syncSaved(msg.urls));
    }
});

async function syncSaved(urls) {
    const cache = await caches.open(SAVED);
    const wanted = new Set(urls.map((u) => stripSearch(new URL(u, self.location.origin).href)));
    const have = new Set();
    for (const req of await cache.keys()) {
        if (wanted.has(req.url)) have.add(req.url);
        else await cache.delete(req);
    }
    const missing = [...wanted].filter((u) => !have.has(u));
    // A few at a time: a first sync can be hundreds of bookmarks.
    for (let i = 0; i < missing.length; i += 4) {
        await Promise.all(
            missing.slice(i, i + 4).map(async (url) => {
                try {
                    const fromCache = await caches.match(url, { ignoreSearch: true });
                    const res = fromCache || (await fetch(url));
                    if (res.ok && !res.redirected) await cache.put(url, res.clone());
                } catch {
                    // offline — the next sync retries
                }
            })
        );
    }
}

// ─── Push notifications ──────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch {
        data = { body: event.data ? event.data.text() : '' };
    }
    event.waitUntil(
        (async () => {
            await self.registration.showNotification(data.title || 'الهلال', {
                body: data.body || '',
                icon: '/icon-192.png',
                badge: '/badge-96.png',
                image: data.image,
                dir: 'rtl',
                lang: 'ar',
                tag: data.tag || 'elhellal',
                data: { url: data.url || '/' },
            });
            if (data.count && self.navigator.setAppBadge) {
                await self.navigator.setAppBadge(data.count).catch(() => {});
            }
        })()
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
    event.waitUntil(
        (async () => {
            fetch('/api/push/event', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'click' }),
            }).catch(() => {});
            const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            const same = windows.find((c) => c.url === url);
            if (same) return same.focus();
            const open = windows[0];
            if (open && 'navigate' in open) {
                await open.focus();
                return open.navigate(url);
            }
            return self.clients.openWindow(url);
        })()
    );
});

// The push service rotated the subscription: subscribe again and move the
// stored preferences over to the new endpoint.
self.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil(
        (async () => {
            const old = event.oldSubscription;
            const key = old && old.options && old.options.applicationServerKey;
            const sub = event.newSubscription || (key && (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })));
            if (!sub) return;
            await fetch('/api/push/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subscription: sub.toJSON(), oldEndpoint: old && old.endpoint }),
            });
        })()
    );
});
