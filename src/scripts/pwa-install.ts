/**
 * Getting readers to install the app (loaded by pwa.ts). Every browser gets
 * the way in it can actually use:
 *
 *  - Chrome / Edge / Samsung: the native prompt (beforeinstallprompt)
 *  - iOS Safari, and Chrome / Edge / Firefox on iOS 16.4+: a step-by-step
 *    sheet for "Add to Home Screen", with an arrow toward the share button
 *  - in-app browsers (Facebook, Instagram, TikTok, X, Telegram…), which can't
 *    install anything: a way out to Chrome (an intent: link) or Safari
 *    (x-safari-https:, iOS 17+), with manual steps and "copy link" as backup
 *  - Firefox on Android: the browser menu's "Install"
 *
 * Where it's offered: the header button (touch devices), the footer link,
 * [data-install-card] cards (home feed, end of articles), the /app/ page, and
 * a banner at moments with intent — a second article read, a third day back,
 * a bookmark, 3+ saved articles on /saved/, going offline or a slow network,
 * or straight away in an in-app browser. Every step is counted
 * (/api/push/event) so the admin's App & push tab shows the funnel.
 */

import { getBookmarks } from '../utils/bookmarks';
import { readInstallState, updateInstallState } from './pwa-store';

interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** How this browser can install the app; 'none' hides every install offer. */
export type InstallPath = 'prompt' | 'ios-safari' | 'ios-browser' | 'open-safari' | 'open-chrome' | 'android-menu' | 'none';

/** Why the banner is showing: picks its pitch. */
type Reason = 'reads' | 'return' | 'saved' | 'offline' | 'inapp';

/** Article pages read before the banner shows. */
const READS_BEFORE_BANNER = 2;
/** Distinct days visited before the banner shows. */
const DAYS_BEFORE_BANNER = 3;
const SAVED_BEFORE_BANNER = 3;
const DISMISS_DAYS = 14;
const BANNER_SESSION_KEY = 'elhellal_install_banner_shown';

let installEvent: BeforeInstallPromptEvent | null = null;

const ua = () => navigator.userAgent;

export const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

export const isIos = () => /iPad|iPhone|iPod/.test(ua()) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isAndroid = () => /Android/.test(ua());
const isIpad = () => /iPad/.test(ua()) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Social and messaging apps' built-in browsers, and Android WebViews. */
const IN_APP = /FBAN|FBAV|FB_IAB|FBIOS|Instagram|musical_ly|Bytedance|TikTok|Twitter|LinkedInApp|Snapchat|Pinterest|Line\/|MicroMessenger|GSA\/|Telegram|; wv\)/;

/** Third-party iOS browsers, which can add to the home screen from iOS 16.4. */
const IOS_BROWSER = /CriOS|EdgiOS|FxiOS|OPiOS/;

function iosVersion(): number {
    const m = ua().match(/OS (\d+)_(\d+)/);
    return m ? Number(m[1]) + Number(m[2]) / 100 : 0;
}

/** Safari's own version (Version/26.0): iOS 26 froze the OS version in the user agent at 18. */
function safariVersion(): number {
    const m = ua().match(/Version\/(\d+)/);
    return m ? Number(m[1]) : 0;
}

export function installPath(): InstallPath {
    if (isStandalone()) return 'none';
    // Browser first: an in-app browser that did fire beforeinstallprompt would install into itself.
    if (isAndroid() && IN_APP.test(ua())) return 'open-chrome';
    if (installEvent) return 'prompt';
    if (isIos()) {
        // WKWebViews (in-app browsers) leave out Safari's "Safari/" token.
        if (IN_APP.test(ua()) || !/Safari\//.test(ua())) return 'open-safari';
        if (IOS_BROWSER.test(ua())) return iosVersion() >= 16.04 ? 'ios-browser' : 'open-safari';
        return 'ios-safari';
    }
    // Firefox never fires beforeinstallprompt; its menu has "Install".
    if (isAndroid() && /Firefox\//.test(ua())) return 'android-menu';
    return 'none';
}

const inAppBrowser = (path = installPath()) => path === 'open-safari' || path === 'open-chrome';

export function canInstall(): boolean {
    return installPath() !== 'none' && !readInstallState().installed;
}

export function trackPwaEvent(name: string) {
    fetch('/api/push/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
        keepalive: true,
    }).catch(() => {});
}

function escapeHtml(text: string) {
    return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ─── Leaving an in-app browser ───────────────────────────────────────────────

function pageUrl() {
    const url = new URL(location.href);
    url.searchParams.set('source', 'inapp');
    return url;
}

/** Opens this page in Chrome; browsers without Chrome fall back to the same URL. */
function chromeUrl() {
    const url = pageUrl();
    return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url.href)};end`;
}

/** iOS 17+ opens x-safari-https: links in Safari; older versions and some apps ignore it. */
function safariUrl() {
    return `x-safari-${pageUrl().href}`;
}

async function copyLink(button: HTMLButtonElement) {
    const url = new URL(location.href);
    url.searchParams.delete('source');
    try {
        await navigator.clipboard.writeText(url.href);
    } catch {
        const input = document.createElement('input');
        input.value = url.href;
        document.body.append(input);
        input.select();
        document.execCommand('copy');
        input.remove();
    }
    button.textContent = 'تم نسخ الرابط ✓';
}

// ─── Step-by-step sheet ──────────────────────────────────────────────────────

const ICON = {
    share: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>`,
    add: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M12 8v8M8 12h8"/></svg>`,
    dots: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>`,
    kebab: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`,
    menu: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`,
    check: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>`,
    arrow: `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v16M5 13l7 7 7-7"/></svg>`,
};

interface Guide {
    title: string;
    intro?: string;
    steps: [icon: string, text: string][];
    /** Where the browser's own button is: the arrow points at it. */
    arrow?: 'up' | 'down';
    actions?: string;
    note?: string;
}

const IOS_NOTE = 'على iPhone وiPad لا تصل الإشعارات إلا عبر التطبيق المثبّت.';

function iosShareStep(): [string, string] {
    if (/CriOS/.test(ua())) return [ICON.share, `اضغط زر المشاركة ${ICON.share} بجانب شريط العنوان.`];
    if (/EdgiOS/.test(ua())) return [ICON.dots, `اضغط ${ICON.dots} أسفل الشاشة، ثم «مشاركة» ${ICON.share}.`];
    if (/FxiOS/.test(ua())) return [ICON.menu, `اضغط ${ICON.menu} ثم «مشاركة» ${ICON.share}.`];
    // Safari 26 tucked Share into the ⋯ menu beside the address bar.
    if (safariVersion() >= 26) return [ICON.dots, `اضغط ${ICON.dots} بجانب شريط العنوان، ثم «مشاركة» ${ICON.share}.`];
    return [ICON.share, `اضغط زر المشاركة ${ICON.share} في شريط Safari.`];
}

function guideFor(path: InstallPath): Guide | null {
    switch (path) {
        case 'ios-safari':
        case 'ios-browser':
            return {
                title: 'أضف الهلال إلى شاشتك الرئيسية',
                intro: 'ثلاث خطوات، دون متجر تطبيقات ودون أي مساحة تُذكر.',
                steps: [
                    iosShareStep(),
                    [ICON.add, `مرّر للأسفل واختر «إضافة إلى الشاشة الرئيسية» ${ICON.add}.`],
                    [ICON.check, 'اضغط «إضافة»، وسيظهر الهلال بين تطبيقاتك.'],
                ],
                // Safari's bar sits at the bottom on iPhone and at the top on iPad; Chrome's at the top.
                arrow: /CriOS/.test(ua()) || (path === 'ios-safari' && isIpad()) ? 'up' : 'down',
                note: IOS_NOTE,
            };
        case 'open-safari':
            return {
                title: 'افتح الهلال في Safari لتثبيته',
                intro: 'المتصفح المدمج في هذا التطبيق لا يستطيع تثبيت التطبيقات.',
                steps: [
                    [ICON.dots, `اضغط ${ICON.dots} أو زر المشاركة ${ICON.share} في أعلى الصفحة أو أسفلها.`],
                    [ICON.share, 'اختر «فتح في Safari» أو «فتح في المتصفح».'],
                    [ICON.add, 'ثم أضف الهلال إلى شاشتك الرئيسية من Safari.'],
                ],
                actions: `<a class="pwa-sheet-primary" href="${escapeHtml(safariUrl())}" data-inapp-open>افتح في Safari</a>
                    <button type="button" class="pwa-sheet-secondary" data-copy-link>انسخ الرابط</button>`,
                note: IOS_NOTE,
            };
        case 'open-chrome':
            return {
                title: 'افتح الهلال في المتصفح لتثبيته',
                intro: 'المتصفح المدمج في هذا التطبيق لا يستطيع تثبيت التطبيقات.',
                steps: [
                    [ICON.kebab, `اضغط ${ICON.kebab} في أعلى الصفحة.`],
                    [ICON.share, 'اختر «فتح في المتصفح» أو «فتح في Chrome».'],
                    [ICON.check, 'ثم اضغط «تثبيت التطبيق».'],
                ],
                actions: `<a class="pwa-sheet-primary" href="${escapeHtml(chromeUrl())}" data-inapp-open>افتح في Chrome</a>
                    <button type="button" class="pwa-sheet-secondary" data-copy-link>انسخ الرابط</button>`,
            };
        case 'android-menu':
            return {
                title: 'ثبّت تطبيق الهلال',
                steps: [
                    [ICON.kebab, `اضغط ${ICON.kebab} في أعلى المتصفح أو أسفله.`],
                    [ICON.add, 'اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».'],
                    [ICON.check, 'اضغط «تثبيت»، وسيظهر الهلال بين تطبيقاتك.'],
                ],
            };
        default:
            return null;
    }
}

function closeSheet() {
    document.getElementById('pwa-sheet')?.remove();
    document.removeEventListener('keydown', onSheetKey);
}

function onSheetKey(e: KeyboardEvent) {
    if (e.key === 'Escape') closeSheet();
}

export function showGuide(path: InstallPath) {
    const guide = guideFor(path);
    if (!guide) return;
    closeSheet();
    hideBanner();
    const sheet = document.createElement('div');
    sheet.id = 'pwa-sheet';
    sheet.className = 'pwa-sheet';
    sheet.innerHTML = `
        <div class="pwa-sheet-backdrop" data-sheet-close></div>
        <div class="pwa-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="pwa-sheet-title">
            <div class="pwa-sheet-head">
                <img src="/icon-192.png" width="48" height="48" alt="" />
                <div>
                    <strong id="pwa-sheet-title">${guide.title}</strong>
                    ${guide.intro ? `<span>${guide.intro}</span>` : ''}
                </div>
            </div>
            <ol class="pwa-sheet-steps">
                ${guide.steps.map(([icon, text]) => `<li><span class="pwa-sheet-step-icon">${icon}</span><span>${text}</span></li>`).join('')}
            </ol>
            ${guide.note ? `<p class="pwa-sheet-note">${guide.note}</p>` : ''}
            <div class="pwa-sheet-actions">
                ${guide.actions ?? ''}
                <button type="button" class="pwa-sheet-secondary" data-sheet-close>حسناً</button>
            </div>
        </div>
        ${guide.arrow ? `<div class="pwa-sheet-arrow pwa-sheet-arrow--${guide.arrow}" aria-hidden="true">${ICON.arrow}</div>` : ''}`;
    sheet.addEventListener('click', (e) => {
        const target = e.target as Element;
        if (target.closest('[data-sheet-close]')) closeSheet();
        const copy = target.closest<HTMLButtonElement>('[data-copy-link]');
        if (copy) {
            trackPwaEvent('inapp-opened');
            copyLink(copy);
        }
        if (target.closest('[data-inapp-open]')) trackPwaEvent('inapp-opened');
    });
    document.addEventListener('keydown', onSheetKey);
    document.body.append(sheet);
    sheet.querySelector<HTMLElement>('.pwa-sheet-panel button, .pwa-sheet-panel a')?.focus({ preventScroll: true });
    trackPwaEvent('guide-shown');
}

// ─── Installing ──────────────────────────────────────────────────────────────

/** Whatever installing means in this browser. */
export async function promptInstall() {
    const path = installPath();
    if (path !== 'prompt') {
        // Android in-app browsers go straight to Chrome; the rest need steps.
        if (path === 'open-chrome') {
            trackPwaEvent('inapp-opened');
            location.href = chromeUrl();
        } else showGuide(path === 'none' && isAndroid() ? 'android-menu' : path);
        return;
    }
    hideBanner();
    const event = installEvent!;
    installEvent = null;
    await event.prompt();
    const { outcome } = await event.userChoice;
    trackPwaEvent(outcome === 'accepted' ? 'install-accepted' : 'install-dismissed');
    if (outcome === 'dismissed') updateInstallState({ dismissedAt: Date.now() });
    updateInstallOffers();
}

// ─── Banner ──────────────────────────────────────────────────────────────────

const PITCH: Record<Reason, string> = {
    reads: 'اقرأ مقالاتك المحفوظة دون اتصال، وافتح الهلال بلمسة واحدة.',
    return: 'عُدت إلينا! افتح الهلال من شاشتك الرئيسية مباشرة، دون بحث.',
    saved: 'مقالاتك المحفوظة تبقى في التطبيق وتُقرأ دون إنترنت.',
    offline: 'تطبيق الهلال يعمل حتى دون اتصال بالإنترنت.',
    inapp: 'المتصفح المدمج هنا لا يثبّت التطبيقات: افتح الهلال في متصفحك لتثبيته.',
};

export function hideBanner() {
    document.getElementById('pwa-banner')?.remove();
}

function showBanner(reason: Reason) {
    if (document.getElementById('pwa-banner') || document.getElementById('pwa-sheet')) return;
    const path = installPath();
    const leave = inAppBrowser(path);
    const banner = document.createElement('div');
    banner.id = 'pwa-banner';
    banner.className = 'pwa-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'تثبيت تطبيق الهلال');
    let pitch = leave ? PITCH.inapp : PITCH[reason];
    if (isIos() && !leave) pitch += ' وتصلك أفضل المقالات بإشعار يومي.';
    const action = leave ? 'افتح في المتصفح' : path === 'prompt' ? 'تثبيت' : 'كيف؟';
    banner.innerHTML = `
        <img src="/icon-192.png" width="44" height="44" alt="" class="pwa-banner-icon" />
        <div class="pwa-banner-text">
            <strong>ثبّت تطبيق الهلال</strong>
            <span>${pitch}</span>
        </div>
        <div class="pwa-banner-actions">
            <button type="button" class="pwa-banner-install">${action}</button>
            <button type="button" class="pwa-banner-close" aria-label="إغلاق">لاحقاً</button>
        </div>`;
    banner.querySelector('.pwa-banner-install')?.addEventListener('click', () => {
        trackPwaEvent('banner-clicked');
        promptInstall();
    });
    banner.querySelector('.pwa-banner-close')?.addEventListener('click', () => {
        updateInstallState({ dismissedAt: Date.now() });
        trackPwaEvent('banner-dismissed');
        hideBanner();
    });
    document.body.append(banner);
    trackPwaEvent(leave ? 'inapp-shown' : isIos() ? 'banner-shown-ios' : 'banner-shown');
    try {
        sessionStorage.setItem(BANNER_SESSION_KEY, '1');
    } catch {}
}

/** Shows the banner for `reason`, unless it was already shown this session or dismissed lately. */
function offerBanner(reason: Reason) {
    if (!canInstall()) return;
    const { dismissedAt } = readInstallState();
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_DAYS * 86_400_000) return;
    try {
        if (sessionStorage.getItem(BANNER_SESSION_KEY)) return;
    } catch {}
    showBanner(reason);
}

function slowConnection() {
    const c = (navigator as Navigator & { connection?: { effectiveType?: string; saveData?: boolean } }).connection;
    return !!c && (c.saveData === true || c.effectiveType === 'slow-2g' || c.effectiveType === '2g');
}

/** The banner's page-load triggers, most telling first. */
function maybeShowBanner() {
    const state = readInstallState();
    if (inAppBrowser()) return offerBanner('inapp');
    if (location.pathname === '/saved/' && getBookmarks().length >= SAVED_BEFORE_BANNER) return offerBanner('saved');
    if ((state.visitDays?.length ?? 0) >= DAYS_BEFORE_BANNER) return offerBanner('return');
    if (slowConnection() && state.reads >= 1) return offerBanner('offline');
    if (state.reads >= READS_BEFORE_BANNER) offerBanner('reads');
}

// ─── Install buttons and cards ───────────────────────────────────────────────

const CARD_TEXT: Record<string, [title: string, text: string]> = {
    article: ['أعجبك المقال؟', 'اقرأ المزيد في تطبيق الهلال: يفتح بلمسة من شاشتك الرئيسية، ويحفظ مقالاتك للقراءة دون إنترنت.'],
    home: ['الهلال على شاشتك الرئيسية', 'أسرع من الموقع، يعمل دون إنترنت، ولا يحتاج متجر تطبيقات.'],
};

function updateInstallOffers() {
    const show = canInstall();
    const path = installPath();
    const leave = inAppBrowser(path);
    const cta = document.getElementById('pwa-install-cta');
    if (cta) cta.hidden = !show;
    const link = document.getElementById('pwa-install-link');
    if (link) {
        link.hidden = !show;
        if (link.previousElementSibling?.classList.contains('footer-separator')) {
            (link.previousElementSibling as HTMLElement).hidden = !show;
        }
    }
    for (const card of document.querySelectorAll<HTMLElement>('[data-install-card]')) {
        const [title, text] = CARD_TEXT[card.dataset.installCard!] ?? CARD_TEXT.home!;
        card.querySelector('.install-card-title')!.textContent = title;
        card.querySelector('.install-card-text')!.textContent = leave ? PITCH.inapp : text + (isIos() ? ' وتصلك أفضل المقالات بإشعار يومي.' : '');
        card.querySelector('.install-card-button')!.textContent = leave ? 'افتح في المتصفح' : path === 'prompt' ? 'ثبّت التطبيق' : 'كيف أثبّته؟';
        card.hidden = !show;
    }
}

/** What each install trigger counts as. */
const TRIGGER_EVENTS: Record<string, string> = {
    header: 'cta-clicked',
    footer: 'link-clicked',
    card: 'card-clicked',
    app: 'app-clicked',
};

export function setupInstall() {
    window.addEventListener('beforeinstallprompt', (e) => {
        // Our own banner replaces Chrome's mini-infobar.
        e.preventDefault();
        installEvent = e as BeforeInstallPromptEvent;
        updateInstallOffers();
        maybeShowBanner();
    });
    window.addEventListener('appinstalled', () => {
        updateInstallState({ installed: true });
        trackPwaEvent('installed');
        installEvent = null;
        hideBanner();
        closeSheet();
        updateInstallOffers();
    });
    // Saving an article is a good moment: offline reading is the pitch.
    window.addEventListener('bookmarks:changed', () => offerBanner('saved'));
    window.addEventListener('offline', () => offerBanner('offline'));
    document.addEventListener('click', (e) => {
        const trigger = (e.target as Element).closest?.<HTMLElement>('[data-install-trigger]');
        if (!trigger) return;
        e.preventDefault();
        const event = TRIGGER_EVENTS[trigger.dataset.installTrigger!];
        if (event) trackPwaEvent(event);
        promptInstall();
    });
}

/** Every page load: count the visit, refresh the install offers, and maybe show the banner. */
export function onInstallPageLoad() {
    const day = new Date().toISOString().slice(0, 10);
    const { visitDays = [] } = readInstallState();
    if (!visitDays.includes(day)) updateInstallState({ visitDays: [...visitDays, day].slice(-7) });
    if (/^\/articles\/[^/]+\/$/.test(location.pathname)) {
        updateInstallState({ reads: readInstallState().reads + 1 });
    }
    updateInstallOffers();
    if (!readInstallState().installed) maybeShowBanner();
}
