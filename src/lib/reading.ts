/**
 * The reader's own reading life, kept on this device (localStorage): which
 * articles they opened and read, the days they read on (the streak), who and
 * what they follow, the achievements they earned, and today's five articles
 * (/today/). src/scripts/reading.ts records it; the home page, /today/, /me/
 * and the push Worker's reminders read it.
 *
 * Everything that derives something from the state (streak, stats, badges,
 * affinity) is a pure function of it, so it's testable without a browser.
 * Reads and writes tolerate storage being unavailable.
 */

const KEY = 'elhellal_reading';
const MAX_READS = 400;
const DAY_MS = 86_400_000;
/** One missed day per this many days is forgiven (a "freeze"). */
export const FREEZE_EVERY_DAYS = 7;
/** Seconds on an article page that count it as read, if the reader doesn't click through first. */
export const READ_AFTER_SECONDS = 20;
export const DAILY_COUNT = 5;

export interface ReadEntry {
    /** slug */
    s: string;
    /** title */
    t: string;
    /** category key */
    c: string;
    /** author (screen_name) */
    a?: string | undefined;
    /** cover image (already resized) */
    i?: string | undefined;
    /** tag slugs */
    g?: string[] | undefined;
    /** last opened (ms) */
    at: number;
    /** furthest scroll, 0–1 */
    p: number;
    /** seconds the page was in view */
    sec: number;
    /** counted as read: the local day it was */
    done?: number | undefined;
    /** clicked through to the original post */
    out?: boolean | undefined;
    /** reading time of the original post, when known */
    m?: number | undefined;
}

export interface Follow {
    kind: 'author' | 'tag';
    /** screen_name or tag slug */
    id: string;
    label: string;
}

export interface TodayPick {
    s: string;
    t: string;
    c: string;
    i?: string | undefined;
    p?: string | undefined;
    a?: string | undefined;
    m?: number | undefined;
}

export interface ReadingState {
    reads: ReadEntry[];
    /** local day number → articles read that day */
    days: Record<number, number>;
    follows: Follow[];
    /** achievement id → local day earned */
    badges: Record<string, number>;
    /** today's five (/today/): fixed for the day once dealt */
    today?: { day: number; picks: TodayPick[] };
    /** local days the reader got through all of today's five */
    dailyDone: number[];
    /** articles opened through /random/ */
    randoms: number;
    /** longest streak so far */
    best: number;
    /** the reader turned the streak (chip, toasts, reminders) off */
    streakOff?: boolean;
}

function empty(): ReadingState {
    return { reads: [], days: {}, follows: [], badges: {}, dailyDone: [], randoms: 0, best: 0 };
}

/** Days since the epoch on the reader's local calendar (what explore.astro's quiz uses too). */
export function localDay(date = new Date()): number {
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

export function readState(): ReadingState {
    try {
        const raw = localStorage.getItem(KEY);
        if (raw) return { ...empty(), ...(JSON.parse(raw) as Partial<ReadingState>) };
    } catch {
        // blocked or corrupt
    }
    return empty();
}

export function writeState(state: ReadingState) {
    try {
        localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
        // full or blocked
    }
    try {
        window.dispatchEvent(new CustomEvent('reading:changed'));
    } catch {}
}

export function updateState(change: (state: ReadingState) => void): ReadingState {
    const state = readState();
    change(state);
    writeState(state);
    return state;
}

// ─── History ─────────────────────────────────────────────────────────────────

/** Records opening an article; keeps progress from earlier visits. */
export function openEntry(state: ReadingState, page: Omit<ReadEntry, 'at' | 'p' | 'sec'>, now = Date.now()): ReadEntry {
    const previous = state.reads.find((r) => r.s === page.s);
    const entry: ReadEntry = { p: 0, sec: 0, ...previous, ...page, at: now };
    state.reads = [entry, ...state.reads.filter((r) => r.s !== page.s)].slice(0, MAX_READS);
    return entry;
}

/** Counts an entry as read today. Returns false when it already was. */
export function markDone(state: ReadingState, slug: string, day: number): boolean {
    const entry = state.reads.find((r) => r.s === slug);
    if (!entry || entry.done) return false;
    entry.done = day;
    state.days[day] = (state.days[day] ?? 0) + 1;
    // Keep a year of days: enough for every streak badge.
    for (const d of Object.keys(state.days)) if (Number(d) < day - 400) delete state.days[Number(d)];
    state.best = Math.max(state.best, streak(state, day).current);
    return true;
}

/** Opened in the last two weeks but not read yet: "أكمل القراءة". */
export function unfinished(state: ReadingState, now = Date.now()): ReadEntry[] {
    return state.reads.filter((r) => !r.done && now - r.at < 14 * DAY_MS);
}

export function readSlugs(state: ReadingState): Set<string> {
    return new Set(state.reads.filter((r) => r.done).map((r) => r.s));
}

// ─── Streak ──────────────────────────────────────────────────────────────────

export interface Streak {
    /** days in the run, today included once it's read */
    current: number;
    /** today already counts */
    today: boolean;
    /** a missed day in the run was forgiven */
    frozen: boolean;
}

/**
 * The run of reading days ending today (or yesterday, while today is still
 * open). One missed day every FREEZE_EVERY_DAYS is bridged, so a single
 * off day doesn't wipe out a long streak.
 */
export function streak(state: Pick<ReadingState, 'days'>, today: number): Streak {
    const has = (d: number) => (state.days[d] ?? 0) > 0;
    let current = 0;
    let frozen = false;
    let lastFreeze = Infinity;
    let d = has(today) ? today : today - 1;
    while (d > today - 2000) {
        if (has(d)) {
            current++;
            d--;
        } else if (lastFreeze - d >= FREEZE_EVERY_DAYS && has(d - 1) && (current > 0 || d === today - 1)) {
            lastFreeze = d;
            frozen = true;
            d--;
        } else break;
    }
    return { current, today: has(today), frozen };
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export interface Stats {
    reads: number;
    /** time on article pages plus the reading time of originals clicked through to */
    minutes: number;
    categories: Array<[string, number]>;
    authors: number;
    activeDays: number;
}

export function stats(state: ReadingState, sinceDay = -Infinity): Stats {
    const done = state.reads.filter((r) => r.done !== undefined && r.done >= sinceDay);
    const byCategory = new Map<string, number>();
    for (const r of done) byCategory.set(r.c, (byCategory.get(r.c) ?? 0) + 1);
    const seconds = done.reduce((sum, r) => sum + r.sec + (r.out && r.m ? r.m * 60 : 0), 0);
    return {
        reads: done.length,
        minutes: Math.round(seconds / 60),
        categories: [...byCategory].sort((a, b) => b[1] - a[1]),
        authors: new Set(done.map((r) => r.a).filter(Boolean)).size,
        activeDays: Object.entries(state.days).filter(([d, n]) => Number(d) >= sinceDay && n > 0).length,
    };
}

/** How much the reader leans toward a category, author or tag: drives /today/ and related ordering. */
export interface Affinity {
    category: Map<string, number>;
    author: Map<string, number>;
    tag: Map<string, number>;
}

export function affinity(state: ReadingState): Affinity {
    const result: Affinity = { category: new Map(), author: new Map(), tag: new Map() };
    const bump = (map: Map<string, number>, key: string | undefined, by: number) => {
        if (key) map.set(key, (map.get(key) ?? 0) + by);
    };
    // Recent reads weigh more; an opened-but-unread article still says something.
    state.reads.slice(0, 200).forEach((r, i) => {
        const w = (r.done ? 1 : 0.3) * (1 - i / 300);
        bump(result.category, r.c, w);
        bump(result.author, r.a, w);
        for (const g of r.g ?? []) bump(result.tag, g, w / 2);
    });
    for (const f of state.follows) bump(f.kind === 'author' ? result.author : result.tag, f.id, 5);
    return result;
}

// ─── Follows ─────────────────────────────────────────────────────────────────

export function isFollowing(state: ReadingState, kind: Follow['kind'], id: string): boolean {
    return state.follows.some((f) => f.kind === kind && f.id === id);
}

export function toggleFollow(state: ReadingState, follow: Follow): boolean {
    const on = isFollowing(state, follow.kind, follow.id);
    state.follows = on
        ? state.follows.filter((f) => !(f.kind === follow.kind && f.id === follow.id))
        : [...state.follows, follow].slice(-100);
    return !on;
}

// ─── Achievements ────────────────────────────────────────────────────────────

export interface Badge {
    id: string;
    icon: string;
    title: string;
    text: string;
}

export interface BadgeInputs {
    /** saved articles (src/utils/bookmarks.ts) */
    saved: number;
    /** the Explore tab's quiz streak */
    quizStreak: number;
    /** local hour of the read just recorded */
    hour?: number;
}

type Rule = Badge & { earned: (s: ReadingState, st: Stats, x: BadgeInputs) => boolean };

const RULES: Rule[] = [
    { id: 'first', icon: '🌙', title: 'البداية', text: 'قرأت مقالك الأول', earned: (_, st) => st.reads >= 1 },
    { id: 'reads-10', icon: '📖', title: 'قارئ', text: '10 مقالات', earned: (_, st) => st.reads >= 10 },
    { id: 'reads-50', icon: '📚', title: 'قارئ نهم', text: '50 مقالاً', earned: (_, st) => st.reads >= 50 },
    { id: 'reads-100', icon: '🏛️', title: 'مكتبة متنقلة', text: '100 مقال', earned: (_, st) => st.reads >= 100 },
    { id: 'reads-365', icon: '👑', title: 'سنة من القراءة', text: '365 مقالاً', earned: (_, st) => st.reads >= 365 },
    { id: 'streak-3', icon: '🔥', title: 'شرارة', text: '3 أيام متتالية', earned: (s) => s.best >= 3 },
    { id: 'streak-7', icon: '🔥', title: 'أسبوع كامل', text: '7 أيام متتالية', earned: (s) => s.best >= 7 },
    { id: 'streak-30', icon: '☄️', title: 'شهر من القراءة', text: '30 يوماً متتالية', earned: (s) => s.best >= 30 },
    { id: 'streak-100', icon: '🌕', title: 'بدر', text: '100 يوم متتالية', earned: (s) => s.best >= 100 },
    { id: 'cats-5', icon: '🧭', title: 'متنقل', text: 'قرأت في 5 تصنيفات', earned: (_, st) => st.categories.length >= 5 },
    { id: 'cats-12', icon: '🗺️', title: 'موسوعي', text: 'قرأت في 12 تصنيفاً', earned: (_, st) => st.categories.length >= 12 },
    { id: 'authors-25', icon: '✍️', title: 'صديق الكتّاب', text: 'قرأت لـ25 كاتباً', earned: (_, st) => st.authors >= 25 },
    { id: 'authors-100', icon: '🖋️', title: 'مجلس الكتّاب', text: 'قرأت لـ100 كاتب', earned: (_, st) => st.authors >= 100 },
    { id: 'follow-5', icon: '⭐', title: 'متابع', text: 'تتابع 5 كتّاب أو وسوم', earned: (s) => s.follows.length >= 5 },
    { id: 'daily-1', icon: '✅', title: 'ورد اليوم', text: 'أنهيت مقالات اليوم الخمسة', earned: (s) => s.dailyDone.length >= 1 },
    { id: 'daily-7', icon: '🏅', title: 'مواظب', text: 'أنهيت ورد اليوم 7 مرات', earned: (s) => s.dailyDone.length >= 7 },
    { id: 'random-10', icon: '🎲', title: 'مغامر', text: '10 مقالات عشوائية', earned: (s) => s.randoms >= 10 },
    { id: 'saved-10', icon: '🔖', title: 'جامع', text: 'حفظت 10 مقالات', earned: (_, __, x) => x.saved >= 10 },
    { id: 'quiz-7', icon: '🧠', title: 'عقل حاضر', text: 'سؤال اليوم 7 أيام متتالية', earned: (_, __, x) => x.quizStreak >= 7 },
    { id: 'night', icon: '🦉', title: 'سهران', text: 'قرأت بعد منتصف الليل', earned: (_, __, x) => x.hour !== undefined && x.hour < 4 },
    { id: 'dawn', icon: '🌅', title: 'مبكّر', text: 'قرأت قبل السابعة صباحاً', earned: (_, __, x) => x.hour !== undefined && x.hour >= 4 && x.hour < 7 },
];

export const BADGES: Badge[] = RULES.map(({ earned: _, ...badge }) => badge);

/** Records newly earned achievements and returns them. */
export function awardBadges(state: ReadingState, inputs: BadgeInputs, day: number): Badge[] {
    const st = stats(state);
    const fresh: Badge[] = [];
    for (const rule of RULES) {
        if (state.badges[rule.id] !== undefined || !rule.earned(state, st, inputs)) continue;
        state.badges[rule.id] = day;
        const { earned: _, ...badge } = rule;
        fresh.push(badge);
    }
    return fresh;
}

// ─── Today's five ────────────────────────────────────────────────────────────

/** Small deterministic PRNG (mulberry32): the same picks all day. */
function random(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export interface Candidate extends TodayPick {
    /** tag slugs */
    g?: string[] | undefined;
    /** created_at */
    d: string;
}

/**
 * Deals today's DAILY_COUNT articles from the recent ones: unread, one per
 * category, leaning toward what the reader follows and reads (the rest of
 * the choice is random per day, so there's always something unexpected).
 */
export function dealToday(state: ReadingState, candidates: Candidate[], day: number): TodayPick[] {
    const read = new Set(state.reads.map((r) => r.s));
    const aff = affinity(state);
    const rand = random(day * 2654435761);
    const scored = candidates
        .filter((c) => !read.has(c.s))
        .map((c) => {
            const tagScore = (c.g ?? []).reduce((sum, g) => sum + (aff.tag.get(g) ?? 0), 0);
            const score =
                Math.log1p(aff.category.get(c.c) ?? 0) +
                Math.log1p(aff.author.get(c.a ?? '') ?? 0) * 1.5 +
                Math.log1p(tagScore) +
                (c.p ? 0.3 : 0) +
                rand() * 1.5;
            return { c, score };
        })
        .sort((a, b) => b.score - a.score);

    const picks: TodayPick[] = [];
    const categories = new Set<string>();
    for (const pass of [true, false]) {
        for (const { c } of scored) {
            if (picks.length >= DAILY_COUNT) break;
            if (picks.some((p) => p.s === c.s)) continue;
            // First pass: one per category, for variety.
            if (pass && categories.has(c.c)) continue;
            categories.add(c.c);
            picks.push({ s: c.s, t: c.t, c: c.c, i: c.i, p: c.p, a: c.a, m: c.m });
        }
    }
    return picks;
}

/** How many of today's five the reader has read. */
export function todayProgress(state: ReadingState, day: number): { done: number; total: number } {
    if (state.today?.day !== day) return { done: 0, total: DAILY_COUNT };
    const read = readSlugs(state);
    return { done: state.today.picks.filter((p) => read.has(p.s)).length, total: state.today.picks.length };
}
