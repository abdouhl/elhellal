/**
 * The reading habit, on every page (loaded by Layout.astro through pwa.ts):
 *
 *  - article pages: records the visit in the reader's history
 *    (src/lib/reading.ts), counts it as read after READ_AFTER_SECONDS in view
 *    or a click through to the original, and then grows the streak, awards
 *    achievements (with a toast each) and tells the push Worker, so it can
 *    remind before a streak breaks and send the weekly recap
 *  - "follow" buttons for authors and tags (article, author and tag pages),
 *    mirrored to the push Worker so digests include what's followed
 *  - related articles reordered toward the reader, read ones last
 *  - the home page's "today's five" card, "continue reading" and "from who
 *    you follow" rows
 *  - the header's 🔥 streak chip
 *  - the installed app's icon badge: today's unread picks while it's closed;
 *    on Android, the service worker refreshes it daily (periodic sync)
 *  - shaking the phone on the home page or /today/ opens a random article
 */

import {
    affinity,
    awardBadges,
    DAILY_COUNT,
    isFollowing,
    localDay,
    markDone,
    openEntry,
    READ_AFTER_SECONDS,
    readSlugs,
    readState,
    stats,
    streak,
    todayProgress,
    toggleFollow,
    unfinished,
    updateState,
    type Badge,
    type Follow,
    type ReadingState,
} from '../lib/reading';
import { listingKey, listingShardOf, type ListingRecord } from '../lib/listing-page';
import type { FeedCard } from '../lib/feed';
import { getBookmarks } from '../utils/bookmarks';
import { isStandalone } from './pwa-install';
import '../styles/reading.css';

// ─── Toasts ──────────────────────────────────────────────────────────────────

const toasts: Array<{ icon: string; title: string; text: string; href?: string | undefined }> = [];
let toasting = false;

function toast(icon: string, title: string, text: string, href?: string) {
    toasts.push({ icon, title, text, href });
    if (!toasting) nextToast();
}

function nextToast() {
    const t = toasts.shift();
    if (!t) {
        toasting = false;
        return;
    }
    toasting = true;
    const el = document.createElement(t.href ? 'a' : 'div');
    el.className = 'reading-toast';
    el.setAttribute('role', 'status');
    if (t.href) (el as HTMLAnchorElement).href = t.href;
    el.innerHTML = `<span class="reading-toast-icon"></span><span><strong></strong><small></small></span>`;
    el.querySelector('.reading-toast-icon')!.textContent = t.icon;
    el.querySelector('strong')!.textContent = t.title;
    el.querySelector('small')!.textContent = t.text;
    document.body.append(el);
    requestAnimationFrame(() => el.classList.add('is-in'));
    setTimeout(() => {
        el.classList.remove('is-in');
        setTimeout(() => {
            el.remove();
            nextToast();
        }, 300);
    }, 3200);
}

function streakWord(n: number): string {
    if (n === 1) return 'يوم واحد';
    if (n === 2) return 'يومان';
    return n <= 10 ? `${n} أيام` : `${n} يوماً`;
}

// ─── Push Worker ─────────────────────────────────────────────────────────────

async function pushEndpoint(): Promise<string | null> {
    try {
        const reg = await navigator.serviceWorker?.getRegistration();
        const sub = await reg?.pushManager?.getSubscription();
        return sub?.endpoint ?? null;
    } catch {
        return null;
    }
}

function post(path: string, body: unknown) {
    return fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
    }).catch(() => {});
}

/** Today's read and the last week's numbers: the Worker's streak reminder and Friday recap. */
export async function reportRead(state: ReadingState) {
    const endpoint = await pushEndpoint();
    if (!endpoint) return;
    const today = localDay();
    const week = stats(state, today - 6);
    await post('/api/push/read', {
        endpoint,
        day: today,
        streak: state.streakOff ? 0 : streak(state, today).current,
        week: { reads: week.reads, minutes: week.minutes, top: week.categories[0]?.[0] ?? '' },
    });
}

/** Mirrors the follows to the push Worker, so digests include them. */
export async function reportFollows(state: ReadingState) {
    const endpoint = await pushEndpoint();
    if (!endpoint) return;
    await post('/api/push/follows', { endpoint, follows: state.follows.map((f) => `${f.kind}:${f.id}`) });
}

// ─── Article pages ───────────────────────────────────────────────────────────

let pageAbort: AbortController | null = null;

function quizStreak(): number {
    try {
        const q = JSON.parse(localStorage.getItem('explore-quiz') || '{}') as { day?: number; streak?: number };
        return q.day !== undefined && q.day >= localDay() - 1 ? q.streak ?? 0 : 0;
    } catch {
        return 0;
    }
}

function celebrate(before: number, state: ReadingState, badges: Badge[]) {
    const today = localDay();
    const s = streak(state, today);
    if (!state.streakOff && s.current > before) {
        toast('🔥', s.current === 1 ? 'بدأت سلسلتك' : `${streakWord(s.current)} متتالية`, s.frozen ? 'سامحناك في يوم فاتك هذا الأسبوع' : 'عُد غداً لتكبر سلسلتك', '/me/');
    }
    const p = todayProgress(state, today);
    if (state.today?.day === today && p.done === p.total && !state.dailyDone.includes(today)) {
        updateState((st) => st.dailyDone.push(today));
        toast('✅', 'أنهيت ورد اليوم', 'خمسة مقالات جديدة تنتظرك غداً', '/today/');
    }
    for (const b of badges) toast(b.icon, `إنجاز جديد: ${b.title}`, b.text, '/me/#badges');
}

function finish(slug: string, out = false) {
    const today = localDay();
    let before = 0;
    let counted = false;
    let badges: Badge[] = [];
    const state = updateState((st) => {
        before = streak(st, today).current;
        const entry = st.reads.find((r) => r.s === slug);
        if (entry && out) entry.out = true;
        counted = markDone(st, slug, today);
        if (counted) badges = awardBadges(st, { saved: getBookmarks().length, quizStreak: quizStreak(), hour: new Date().getHours() }, today);
    });
    if (!counted) return;
    celebrate(before, state, badges);
    reportRead(state);
}

function trackArticle() {
    const article = document.querySelector<HTMLElement>('article[data-read-slug]');
    const slug = article?.dataset.readSlug;
    if (!article || !slug || slug.startsWith('{{')) return;
    const signal = pageAbort!.signal;

    const minutesText = document.querySelector('.meta-minutes')?.textContent ?? '';
    const minutes = Number(minutesText.match(/\d+/)?.[0] ?? (minutesText.startsWith('دقيقتان') ? 2 : minutesText.startsWith('دقيقة') ? 1 : 0));
    const tags = [...document.querySelectorAll<HTMLAnchorElement>('.article-keywords a.keyword-tag')]
        .map((a) => decodeURIComponent(a.pathname.match(/^\/tags\/([^/]+)/)?.[1] ?? ''))
        .filter(Boolean);
    const title = document.querySelector('h1.article-title')?.textContent?.trim() ?? document.title;
    const category = article.dataset.readCategory || '';

    let previousProgress = 0;
    updateState((st) => {
        previousProgress = st.reads.find((r) => r.s === slug && !r.done)?.p ?? 0;
        openEntry(st, {
            s: slug,
            t: title,
            c: category,
            a: article.dataset.readAuthor || undefined,
            i: article.dataset.readImage || undefined,
            g: tags.length ? tags.slice(0, 8) : undefined,
            m: minutes || undefined,
        });
    });

    // Back where they left off, unless they came back with the browser's own scroll restore.
    if (previousProgress > 0.3 && previousProgress < 0.95 && window.scrollY < 50) {
        requestAnimationFrame(() =>
            window.scrollTo({ top: previousProgress * document.documentElement.scrollHeight - innerHeight, behavior: 'smooth' })
        );
    }

    let seconds = 0;
    let progress = 0;
    let counted = readState().reads.find((r) => r.s === slug)?.done !== undefined;
    let baseSeconds = readState().reads.find((r) => r.s === slug)?.sec ?? 0;
    const save = () =>
        updateState((st) => {
            const entry = st.reads.find((r) => r.s === slug);
            if (!entry) return;
            entry.sec += seconds;
            entry.p = Math.max(entry.p, progress);
            baseSeconds = entry.sec;
            seconds = 0;
        });
    const timer = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        seconds++;
        if (!counted && baseSeconds + seconds >= READ_AFTER_SECONDS) {
            counted = true;
            save();
            finish(slug);
        } else if (seconds % 5 === 0) save();
    }, 1000);
    signal.addEventListener('abort', () => {
        clearInterval(timer);
        save();
    });

    const onScroll = () => {
        const doc = document.documentElement;
        progress = Math.max(progress, Math.min(1, (window.scrollY + innerHeight) / doc.scrollHeight));
    };
    window.addEventListener('scroll', onScroll, { passive: true, signal });
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && save(), { signal });
    article.querySelector('a.btn-read')?.addEventListener(
        'click',
        () => {
            counted = true;
            save();
            finish(slug, true);
        },
        { signal }
    );

    reorderRelated();
}

/** Related articles: authors the reader likes first, already-read ones last and marked. */
function reorderRelated() {
    const grid = document.querySelector('.related-grid');
    if (!grid) return;
    const state = readState();
    const read = readSlugs(state);
    const aff = affinity(state);
    const cards = [...grid.querySelectorAll<HTMLAnchorElement>('a.related-card')];
    const score = (a: HTMLAnchorElement) => {
        const slug = decodeURIComponent(a.pathname.match(/^\/articles\/([^/]+)/)?.[1] ?? '');
        const author = a.querySelector('.related-author')?.textContent?.replace(/^@/, '') ?? '';
        if (read.has(slug)) {
            a.dataset.read = '';
            return -10;
        }
        return aff.author.get(author) ?? 0;
    };
    const scored = cards.map((a, i) => ({ a, s: score(a), i }));
    scored.sort((x, y) => y.s - x.s || x.i - y.i);
    grid.append(...scored.map((x) => x.a));
}

// ─── Follow buttons ──────────────────────────────────────────────────────────

function followButton(follow: Follow, compact = false): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `follow-btn${compact ? ' follow-btn-compact' : ''}`;
    const sync = () => {
        const on = isFollowing(readState(), follow.kind, follow.id);
        btn.setAttribute('aria-pressed', String(on));
        btn.textContent = on ? '✓ تتابعه' : '+ تابِع';
        btn.title = on ? `إلغاء متابعة ${follow.label}` : `تابِع ${follow.label}: يظهر جديده في رئيستك وورد يومك`;
    };
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        let on = false;
        let badges: Badge[] = [];
        const state = updateState((st) => {
            on = toggleFollow(st, follow);
            badges = awardBadges(st, { saved: getBookmarks().length, quizStreak: quizStreak() }, localDay());
        });
        sync();
        if (on) toast('⭐', `تتابع الآن ${follow.label}`, 'ستجد جديده في الرئيسية وورد اليوم', '/me/#follows');
        for (const b of badges) toast(b.icon, `إنجاز جديد: ${b.title}`, b.text, '/me/#badges');
        reportFollows(state);
    });
    sync();
    return btn;
}

function setupFollowButtons() {
    const path = decodeURIComponent(location.pathname);
    const article = document.querySelector<HTMLElement>('article[data-read-author]');
    const author = article?.dataset.readAuthor;
    if (article && author && !author.startsWith('{{') && !document.querySelector('.follow-btn')) {
        const label = document.querySelector('.article-sidebar .author-handle')?.textContent?.trim() || `@${author}`;
        const follow: Follow = { kind: 'author', id: author, label };
        document.querySelector('.article-meta .meta-author')?.after(followButton(follow, true));
        document.querySelector('.article-sidebar .author-row')?.append(followButton(follow));
        return;
    }
    const authorPage = path.match(/^\/authors\/([^/]+)\/$/);
    if (authorPage && authorPage[1] !== '__shell__') {
        const label = document.querySelector('.author-identity h1')?.textContent?.trim() || authorPage[1]!;
        document.querySelector('.author-identity')?.append(followButton({ kind: 'author', id: authorPage[1]!, label }));
        return;
    }
    const tagPage = path.match(/^\/tags\/([^/]+)\/$/);
    if (tagPage && tagPage[1] !== '__shell__') {
        const label = document.querySelector('.tag-header h1')?.textContent?.trim().replace(/^#/, '') || tagPage[1]!;
        document.querySelector('.tag-header')?.append(followButton({ kind: 'tag', id: tagPage[1]!, label }));
    }
}

// ─── Header streak chip ──────────────────────────────────────────────────────

function renderStreakChip() {
    const chip = document.getElementById('streak-chip');
    if (!chip) return;
    const state = readState();
    const s = streak(state, localDay());
    chip.hidden = state.streakOff || s.current === 0;
    chip.classList.toggle('is-pending', !s.today);
    chip.querySelector('span')!.textContent = String(s.current);
    const run = s.current === 1 ? 'بدأت سلسلتك' : `${streakWord(s.current)} متتالية`;
    chip.title = s.today ? run : `اقرأ مقالاً اليوم لتبقى سلسلتك (${streakWord(s.current)})`;
}

// ─── Home page ───────────────────────────────────────────────────────────────

function rowItem(href: string, title: string, image?: string, note?: string, progress?: number): HTMLLIElement {
    const li = document.createElement('li');
    li.innerHTML = `<a class="habit-card"><span class="habit-card-cover"><img alt="" loading="lazy" width="240" height="135" /></span><strong></strong><small></small></a>`;
    const a = li.querySelector('a')!;
    a.href = href;
    li.querySelector('strong')!.textContent = title;
    const small = li.querySelector('small')!;
    if (note) small.textContent = note;
    else small.remove();
    const img = li.querySelector('img')!;
    if (image) {
        img.src = image;
        img.onerror = () => img.remove();
    } else img.remove();
    if (progress !== undefined) {
        const bar = document.createElement('span');
        bar.className = 'habit-progress';
        bar.style.setProperty('--p', String(Math.max(0.08, progress)));
        a.querySelector('.habit-card-cover')!.append(bar);
    }
    return li;
}

function renderTodayCard(state: ReadingState) {
    const card = document.querySelector<HTMLElement>('[data-habit-today]');
    if (!card) return;
    const today = localDay();
    const p = todayProgress(state, today);
    const s = streak(state, today);
    const dots = card.querySelector('[data-dots]')!;
    dots.replaceChildren(
        ...Array.from({ length: p.total || DAILY_COUNT }, (_, i) => {
            const dot = document.createElement('span');
            if (i < p.done) dot.className = 'is-done';
            return dot;
        })
    );
    const text = card.querySelector('[data-text]')!;
    const cta = card.querySelector('[data-cta]')!;
    if (p.done >= p.total) {
        text.textContent = 'أنهيت ورد اليوم. خمسة مقالات جديدة غداً.';
        cta.textContent = 'راجِعها';
    } else if (p.done > 0) {
        text.textContent = `قرأت ${p.done} من ${p.total}. أكمل وردك.`;
        cta.textContent = 'أكمل';
    } else {
        text.textContent = 'خمسة مقالات جديدة اخترناها لك اليوم، من مواضيع مختلفة.';
        cta.textContent = 'ابدأ';
    }
    const streakEl = card.querySelector<HTMLElement>('[data-streak]')!;
    streakEl.hidden = state.streakOff || s.current === 0;
    streakEl.textContent = `🔥 ${s.current}`;
    card.hidden = false;
}

function renderContinue(state: ReadingState) {
    const section = document.querySelector<HTMLElement>('[data-habit-continue]');
    const list = section?.querySelector('ul');
    if (!section || !list) return;
    const items = unfinished(state).slice(0, 8);
    list.replaceChildren(...items.map((r) => rowItem(`/articles/${encodeURIComponent(r.s)}/`, r.t, r.i, undefined, r.p)));
    section.hidden = items.length === 0;
}

const FOLLOW_CACHE = 'elhellal_following_feed';

async function followingCards(state: ReadingState): Promise<FeedCard[]> {
    const key = state.follows.map((f) => `${f.kind}:${f.id}`).join('|');
    try {
        const cached = JSON.parse(sessionStorage.getItem(FOLLOW_CACHE) || 'null') as { key: string; cards: FeedCard[] } | null;
        if (cached?.key === key) return cached.cards;
    } catch {}
    const lists = await Promise.all(
        state.follows.slice(-12).map(async (f) => {
            const k = listingKey(f.kind, f.id);
            try {
                const res = await fetch(`/_data/listings/${listingShardOf(k)}.json`);
                const shard = (await res.json()) as Record<string, ListingRecord>;
                return shard[k]?.cards.slice(0, 10) ?? [];
            } catch {
                return [];
            }
        })
    );
    const seen = new Set<string>();
    const cards = lists
        .flat()
        .filter((c) => c.slug && !seen.has(c.slug) && seen.add(c.slug))
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 30);
    try {
        sessionStorage.setItem(FOLLOW_CACHE, JSON.stringify({ key, cards }));
    } catch {}
    return cards;
}

async function renderFollowing(state: ReadingState) {
    const section = document.querySelector<HTMLElement>('[data-habit-following]');
    const list = section?.querySelector('ul');
    if (!section || !list || state.follows.length === 0) return;
    const read = readSlugs(state);
    const cards = (await followingCards(state)).filter((c) => !read.has(c.slug!)).slice(0, 12);
    list.replaceChildren(
        ...cards.map((c) => rowItem(`/articles/${encodeURIComponent(c.slug!)}/`, c.title, c.img && resizeCover(c.img), c.author ? `@${c.author}` : undefined))
    );
    section.hidden = cards.length === 0;
}

let resizeCover = (url: string) => url;

async function renderHome() {
    if (location.pathname !== '/') return;
    const { resizeImage, isImageUrl } = await import('../lib/images');
    resizeCover = (url) => (isImageUrl(url) ? resizeImage(url, 320) : url);
    const state = readState();
    renderTodayCard(state);
    renderContinue(state);
    renderFollowing(state).catch(() => {});
}

// ─── App icon badge ──────────────────────────────────────────────────────────

type BadgeNavigator = Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

/** While the installed app is in the background, its icon shows today's unread picks. */
function setupAppBadge() {
    const nav = navigator as BadgeNavigator;
    if (!nav.setAppBadge) return;
    document.addEventListener('visibilitychange', () => {
        if (!isStandalone()) return;
        if (document.visibilityState === 'visible') {
            nav.clearAppBadge?.().catch(() => {});
            return;
        }
        const state = readState();
        const p = todayProgress(state, localDay());
        const left = p.total - p.done;
        if (left > 0) nav.setAppBadge!(left).catch(() => {});
        // The service worker's daily refresh (periodic sync) needs to know when the app was last used.
        navigator.serviceWorker?.controller?.postMessage({ type: 'last-visit', day: localDay(), left });
    });
}

async function registerPeriodicSync() {
    if (!isStandalone() || !import.meta.env.PROD) return;
    try {
        const reg = (await navigator.serviceWorker?.ready) as ServiceWorkerRegistration & {
            periodicSync?: { register: (tag: string, opts: { minInterval: number }) => Promise<void> };
        };
        if (!reg?.periodicSync) return;
        const status = await navigator.permissions.query({ name: 'periodic-background-sync' as PermissionName });
        if (status.state === 'granted') await reg.periodicSync.register('daily-refresh', { minInterval: 12 * 3600_000 });
    } catch {
        // unsupported (everything but Chromium's installed apps)
    }
}

// ─── Shake for a random article ──────────────────────────────────────────────

const SHAKE_FORCE = 28;

function setupShake() {
    // iOS asks for motion permission; only Android-style browsers fire it freely.
    const motion = window.DeviceMotionEvent as unknown as { requestPermission?: unknown } | undefined;
    if (!motion || typeof motion.requestPermission === 'function') return;
    let hits: number[] = [];
    window.addEventListener('devicemotion', (e) => {
        if (!isStandalone() || (location.pathname !== '/' && location.pathname !== '/today/')) return;
        const a = e.accelerationIncludingGravity;
        if (!a || a.x === null || a.y === null || a.z === null) return;
        if (Math.hypot(a.x, a.y, a.z) < SHAKE_FORCE) return;
        const now = Date.now();
        hits = [...hits.filter((t) => now - t < 800), now];
        if (hits.length >= 3) {
            hits = [];
            navigator.vibrate?.(30);
            location.assign('/random/?from=shake');
        }
    });
}

// ─── Every page ──────────────────────────────────────────────────────────────

function onPageLoad() {
    pageAbort?.abort();
    pageAbort = new AbortController();
    trackArticle();
    setupFollowButtons();
    renderStreakChip();
    renderHome().catch(() => {});
}

document.addEventListener('astro:page-load', onPageLoad);
document.addEventListener('astro:before-swap', () => pageAbort?.abort());
window.addEventListener('reading:changed', renderStreakChip);
setupAppBadge();
setupShake();
registerPeriodicSync();
