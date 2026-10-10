/**
 * The installable-app side of the site, loaded once by Layout.astro:
 *
 *  - registers the service worker (public/sw.js) once the page is idle, so it
 *    never competes with first paint
 *  - mirrors bookmarks into the worker's offline "saved" cache
 *  - remembers recently read articles for /offline/
 *  - shows an install banner (or, on iOS, how to add to the home screen) to
 *    returning readers, and the header's install button (touch devices) and
 *    the footer's install link wherever installing is possible
 *  - drives the installed app's shell: tab bar, back button, "more" sheet
 *  - subscribes the installed app to the daily digest: silently when
 *    notifications are already allowed, otherwise through a one-tap banner
 *    (iOS only asks for permission from a tap)
 */

import { shardOf } from '../lib/article-page';
import { getBookmarks } from '../utils/bookmarks';
import { currentSubscription, pushSupport, subscribe } from '../lib/push-client';
import { readInstallState, rememberRecent, updateInstallState } from './pwa-store';

interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Article pages read before the banner shows. */
const READS_BEFORE_BANNER = 2;
const DISMISS_DAYS = 14;
const BANNER_SESSION_KEY = 'elhellal_install_banner_shown';

let installEvent: BeforeInstallPromptEvent | null = null;

const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

const isIos = () =>
    /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function trackPwaEvent(name: string) {
    fetch('/api/push/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
        keepalive: true,
    }).catch(() => {});
}

// ─── Service worker ──────────────────────────────────────────────────────────

function savedUrls(): string[] {
    const urls = new Set(['/saved/']);
    for (const slug of getBookmarks()) {
        urls.add(`/articles/${encodeURIComponent(slug)}/`);
        urls.add(`/_data/articles/${shardOf(slug)}.json`);
    }
    return [...urls];
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

// ─── Install banner ──────────────────────────────────────────────────────────

const SHARE_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>`;

function canInstall() {
    return !isStandalone() && (installEvent !== null || isIos());
}

function hideBanner() {
    document.getElementById('pwa-banner')?.remove();
}

function showBanner() {
    if (document.getElementById('pwa-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'pwa-banner';
    banner.className = 'pwa-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'تثبيت تطبيق الهلال');
    const ios = !installEvent && isIos();
    banner.innerHTML = `
        <img src="/icon-192.png" width="44" height="44" alt="" class="pwa-banner-icon" />
        <div class="pwa-banner-text">
            <strong>ثبّت تطبيق الهلال</strong>
            <span>${
                ios
                    ? `اضغط على زر المشاركة ${SHARE_ICON} ثم «إضافة إلى الشاشة الرئيسية».`
                    : 'اقرأ مقالاتك المحفوظة دون اتصال، وافتح الهلال بلمسة واحدة.'
            }</span>
        </div>
        <div class="pwa-banner-actions">
            ${ios ? '' : '<button type="button" class="pwa-banner-install">تثبيت</button>'}
            <button type="button" class="pwa-banner-close" aria-label="إغلاق">لاحقاً</button>
        </div>`;
    banner.querySelector('.pwa-banner-install')?.addEventListener('click', promptInstall);
    banner.querySelector('.pwa-banner-close')?.addEventListener('click', () => {
        updateInstallState({ dismissedAt: Date.now() });
        trackPwaEvent('banner-dismissed');
        hideBanner();
    });
    document.body.append(banner);
    try {
        sessionStorage.setItem(BANNER_SESSION_KEY, '1');
    } catch {}
}

async function promptInstall() {
    if (!installEvent) {
        // iOS has no install prompt: the banner is the instructions.
        showBanner();
        return;
    }
    hideBanner();
    const event = installEvent;
    installEvent = null;
    await event.prompt();
    const { outcome } = await event.userChoice;
    trackPwaEvent(outcome === 'accepted' ? 'install-accepted' : 'install-dismissed');
    if (outcome === 'dismissed') updateInstallState({ dismissedAt: Date.now() });
    updateInstallLink();
}

function maybeShowBanner(force = false) {
    if (!canInstall()) return;
    const state = readInstallState();
    if (state.installed) return;
    if (state.dismissedAt && Date.now() - state.dismissedAt < DISMISS_DAYS * 86_400_000) return;
    try {
        if (sessionStorage.getItem(BANNER_SESSION_KEY)) return;
    } catch {}
    if (force || state.reads >= READS_BEFORE_BANNER) showBanner();
}

function updateInstallLink() {
    const show = canInstall() && !readInstallState().installed;
    const cta = document.getElementById('pwa-install-cta');
    if (cta) cta.hidden = !show;
    const link = document.getElementById('pwa-install-link');
    if (!link) return;
    link.hidden = !show;
    if (link.previousElementSibling?.classList.contains('footer-separator')) {
        (link.previousElementSibling as HTMLElement).hidden = !show;
    }
}

function setupInstall() {
    window.addEventListener('beforeinstallprompt', (e) => {
        // Our own banner replaces Chrome's mini-infobar.
        e.preventDefault();
        installEvent = e as BeforeInstallPromptEvent;
        updateInstallLink();
        maybeShowBanner();
    });
    window.addEventListener('appinstalled', () => {
        updateInstallState({ installed: true });
        trackPwaEvent('installed');
        installEvent = null;
        hideBanner();
        updateInstallLink();
    });
    // Saving an article is a good moment: offline reading is the pitch.
    window.addEventListener('bookmarks:changed', () => maybeShowBanner(true));
    document.addEventListener('click', (e) => {
        const trigger = (e.target as Element).closest?.('#pwa-install-link, #pwa-install-cta');
        if (trigger) {
            e.preventDefault();
            trackPwaEvent(trigger.id === 'pwa-install-cta' ? 'cta-clicked' : 'link-clicked');
            promptInstall();
        }
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

// ─── Every page ──────────────────────────────────────────────────────────────

function onPageLoad() {
    const standalone = isStandalone();
    document.documentElement.toggleAttribute('data-standalone', standalone);
    if (standalone) (navigator as Navigator & { clearAppBadge?: () => Promise<void> }).clearAppBadge?.().catch(() => {});
    updateAppShell();

    if (/^\/articles\/[^/]+\/$/.test(location.pathname)) {
        const title = document.querySelector('h1')?.textContent?.trim() || document.title.replace(/ \| الهلال$/, '');
        rememberRecent({ url: location.pathname, title });
        updateInstallState({ reads: readInstallState().reads + 1 });
    }

    updateInstallLink();
    maybeShowBanner();
    setupAppNotifications().catch(() => {});
}

registerServiceWorker();
setupInstall();
setupAppShell();
document.addEventListener('astro:page-load', onPageLoad);
