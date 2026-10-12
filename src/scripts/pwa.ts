/**
 * The installable-app side of the site, loaded once by Layout.astro:
 *
 *  - registers the service worker (public/sw.js) once the page is idle, so it
 *    never competes with first paint
 *  - mirrors bookmarks into the worker's offline "saved" cache
 *  - remembers recently read articles for /offline/
 *  - offers installing the app (pwa-install.ts)
 *  - drives the installed app's shell: tab bar, back button, "more" sheet,
 *    and "recently read" on the home page
 *  - has the installed app save the home page's top articles for offline
 *    reading once a day
 *  - subscribes the installed app to the daily digest: silently when
 *    notifications are already allowed, otherwise through a one-tap banner
 *    (iOS only asks for permission from a tap)
 *  - checks the installed app in once a day (/api/push/ping), which is how the
 *    admin panel counts installs and active installs
 */

import { shardOf } from '../lib/article-page';
import { getBookmarks } from '../utils/bookmarks';
import { currentSubscription, pushSupport, subscribe } from '../lib/push-client';
import { hideBanner, isIos, isStandalone, onInstallPageLoad, setupInstall, trackPwaEvent } from './pwa-install';
import { readInstallState, readRecent, rememberRecent, updateInstallState } from './pwa-store';

/** Top articles on the home page the installed app keeps for offline reading. */
const DAILY_ARTICLES = 12;
const RECENT_SHOWN = 6;

// ─── Service worker ──────────────────────────────────────────────────────────

/** An article page and the data shard the site Worker fills it from. */
function addArticle(urls: Set<string>, slug: string) {
    urls.add(`/articles/${encodeURIComponent(slug)}/`);
    urls.add(`/_data/articles/${shardOf(slug)}.json`);
}

function savedUrls(): string[] {
    const urls = new Set(['/saved/']);
    for (const slug of getBookmarks()) addArticle(urls, slug);
    return [...urls];
}

/**
 * Once a day, the installed app's home page hands the service worker its top
 * articles to keep (its "daily" cache), so there's something new to read offline.
 */
function syncDaily() {
    const day = new Date().toISOString().slice(0, 10);
    if (location.pathname !== '/' || readInstallState().dailyOn === day || !navigator.onLine) return;
    // The feed renders on idle: give it a moment.
    setTimeout(async () => {
        if (location.pathname !== '/') return;
        const urls = new Set<string>();
        for (const a of document.querySelectorAll<HTMLAnchorElement>('main a[href^="/articles/"]')) {
            const slug = a.pathname.match(/^\/articles\/([^/]+)\/$/)?.[1];
            if (slug) addArticle(urls, decodeURIComponent(slug));
            if (urls.size >= DAILY_ARTICLES * 2) break;
        }
        if (!urls.size || !navigator.serviceWorker?.controller) return;
        const reg = await navigator.serviceWorker.ready;
        reg.active?.postMessage({ type: 'sync-daily', urls: ['/', ...urls] });
        updateInstallState({ dailyOn: day });
    }, 8000);
}

async function syncSaved() {
    const reg = await navigator.serviceWorker.ready;
    reg.active?.postMessage({ type: 'sync-saved', urls: savedUrls() });
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
    const register = () => {
        navigator.serviceWorker
            .register('/sw.js')
            .then(syncSaved)
            .catch(() => {});
    };
    const whenIdle = () =>
        'requestIdleCallback' in window ? requestIdleCallback(register, { timeout: 5000 }) : setTimeout(register, 2000);
    if (document.readyState === 'complete') whenIdle();
    else window.addEventListener('load', whenIdle, { once: true });

    window.addEventListener('bookmarks:changed', () => {
        if (navigator.serviceWorker.controller) syncSaved();
    });
}

// ─── Notifications in the installed app ──────────────────────────────────────

const NOTIFY_DISMISS_DAYS = 7;
const NOTIFY_SESSION_KEY = 'elhellal_notify_banner_shown';
const BELL_ICON = `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`;

let subscribing = false;

async function enableNotifications() {
    if (subscribing) return;
    subscribing = true;
    try {
        await subscribe({ categories: '*', frequency: 'daily' });
        trackPwaEvent('subscribed');
    } catch {
        // denied, dismissed or offline: the banner's dismissal covers it
        updateInstallState({ notifyDismissedAt: Date.now() });
    } finally {
        subscribing = false;
    }
}

function showNotifyBanner() {
    if (document.getElementById('pwa-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'pwa-banner';
    banner.className = 'pwa-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'تفعيل الإشعارات');
    banner.innerHTML = `
        <span class="pwa-banner-icon pwa-banner-bell">${BELL_ICON}</span>
        <div class="pwa-banner-text">
            <strong>فعّل الإشعارات</strong>
            <span>أفضل المقالات الجديدة مرة في اليوم، ويمكنك تغيير ذلك متى شئت.</span>
        </div>
        <div class="pwa-banner-actions">
            <button type="button" class="pwa-banner-install">تفعيل</button>
            <button type="button" class="pwa-banner-close" aria-label="إغلاق">لاحقاً</button>
        </div>`;
    banner.querySelector('.pwa-banner-install')?.addEventListener('click', () => {
        hideBanner();
        enableNotifications();
    });
    banner.querySelector('.pwa-banner-close')?.addEventListener('click', () => {
        updateInstallState({ notifyDismissedAt: Date.now() });
        trackPwaEvent('notify-dismissed');
        hideBanner();
    });
    document.body.append(banner);
    try {
        sessionStorage.setItem(NOTIFY_SESSION_KEY, '1');
    } catch {}
}

async function setupAppNotifications() {
    if (!isStandalone() || !import.meta.env.PROD || pushSupport() !== 'ok') return;
    if (Notification.permission === 'denied' || location.pathname.startsWith('/notifications')) return;
    if (await currentSubscription()) return;
    if (Notification.permission === 'granted') return enableNotifications();
    const { notifyDismissedAt } = readInstallState();
    if (notifyDismissedAt && Date.now() - notifyDismissedAt < NOTIFY_DISMISS_DAYS * 86_400_000) return;
    try {
        if (sessionStorage.getItem(NOTIFY_SESSION_KEY)) return;
    } catch {}
    showNotifyBanner();
}

// ─── Install count ───────────────────────────────────────────────────────────

function platform(): string {
    if (isIos()) return 'ios';
    if (/Android/.test(navigator.userAgent)) return 'android';
    if (/Windows|Macintosh|Linux|CrOS/.test(navigator.userAgent)) return 'desktop';
    return 'other';
}

/** Once a day per installed app: an anonymous random id, the platform, and whether notifications are on. */
async function pingInstall() {
    if (!isStandalone() || !import.meta.env.PROD) return;
    const day = new Date().toISOString().slice(0, 10);
    let state = readInstallState();
    if (state.pingedOn === day) return;
    if (!state.appId) state = updateInstallState({ appId: crypto.randomUUID() });
    const push = pushSupport() === 'ok' && Notification.permission === 'granted' && !!(await currentSubscription().catch(() => null));
    const res = await fetch('/api/push/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: state.appId, platform: platform(), push }),
        keepalive: true,
    });
    if (res.ok) updateInstallState({ pingedOn: day, installed: true });
}

// ─── App shell (installed app) ───────────────────────────────────────────────

function setMoreOpen(open: boolean) {
    document.documentElement.toggleAttribute('data-more-open', open);
    document.getElementById('app-more')?.setAttribute('aria-expanded', String(open));
}

function updateAppShell() {
    const path = location.pathname;
    for (const tab of document.querySelectorAll<HTMLAnchorElement>('.app-tabbar a[data-tab]')) {
        const target = tab.dataset.tab!;
        const current = target === '/' ? path === '/' : path.startsWith(target);
        if (current) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
    }
    const back = document.getElementById('app-back');
    if (back) back.hidden = path === '/';
    setMoreOpen(false);
}

function setupAppShell() {
    // Astro's view transitions copy the new page's <html> attributes over ours.
    document.addEventListener('astro:before-swap', (e) => {
        const next = (e as Event & { newDocument: Document }).newDocument.documentElement;
        next.toggleAttribute('data-standalone', document.documentElement.hasAttribute('data-standalone'));
    });
    document.addEventListener('click', (e) => {
        const target = e.target as Element;
        if (target.closest?.('#app-back')) {
            // Opened straight onto a page (a notification, a shared link): back goes home.
            // Astro numbers its view-transition history entries in history.state.index.
            const inApp = (history.state?.index ?? 0) > 0 || document.referrer.startsWith(location.origin);
            if (inApp) history.back();
            else location.assign('/');
            return;
        }
        if (target.closest?.('#app-more')) {
            setMoreOpen(!document.documentElement.hasAttribute('data-more-open'));
            return;
        }
        if (document.documentElement.hasAttribute('data-more-open') && !target.closest?.('#site-footer')) {
            setMoreOpen(false);
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') setMoreOpen(false);
    });
}

/** The installed app's home page lists the last articles read ([data-app-recent], index.astro). */
function renderRecent() {
    const section = document.querySelector<HTMLElement>('[data-app-recent]');
    const list = section?.querySelector('ul');
    if (!section || !list) return;
    const recent = readRecent().slice(0, RECENT_SHOWN);
    list.replaceChildren(
        ...recent.map((page) => {
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.href = page.url;
            a.textContent = page.title;
            li.append(a);
            return li;
        })
    );
    section.hidden = !isStandalone() || recent.length === 0;
}

// ─── Every page ──────────────────────────────────────────────────────────────

function onPageLoad() {
    const standalone = isStandalone();
    document.documentElement.toggleAttribute('data-standalone', standalone);
    if (standalone) (navigator as Navigator & { clearAppBadge?: () => Promise<void> }).clearAppBadge?.().catch(() => {});
    updateAppShell();

    if (/^\/articles\/[^/]+\/$/.test(location.pathname)) {
        const title = document.querySelector('h1')?.textContent?.trim() || document.title.replace(/ \| الهلال$/, '');
        rememberRecent({ url: location.pathname, title });
    }

    onInstallPageLoad();
    if (standalone) {
        renderRecent();
        syncDaily();
    }
    setupAppNotifications().catch(() => {});
    pingInstall().catch(() => {});
}

registerServiceWorker();
setupInstall();
setupAppShell();
document.addEventListener('astro:page-load', onPageLoad);
