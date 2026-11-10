#!/usr/bin/env bun
/**
 * X (Twitter) scheduler — الهلال
 * ------------------------------
 * Schedules a day (or month) of posts through x.com's own "Schedule post" dialog,
 * using the session you are logged into in Chrome (no API keys):
 *   - 4 articles   with an image card (title + hook, x-posts/cards/). Each gets a hook
 *                  style — the author's opening lines, the tldr, an AI-written hook
 *                  (--ai-hooks), or no link at all (~20%: X shows link posts to fewer
 *                  people). Most-read and best-performing categories go first; one per
 *                  category and author a day. Links carry ?utm_source=x&utm_content=<id>
 *                  so the views worker counts the readers each post sends
 *   - 2 quizzes    the question + choices as text and as a card, reply prompt + link
 *   - 1 quote      from ../elhellal-quotes, as a card
 *   - 1 book       "الكتاب / الدرس" (1-book.png + 2-lesson.png from x-posts/<date>/…)
 *   - biographies  "ذكرى ميلاد/رحيل" on an author's anniversary, plus Mondays and Thursdays
 *   - roundup      Saturdays: the week's picks in one post
 *   - re-posts     past winners (top fifth by x-stats) come back after 60 days with a new hook
 *
 * Times are in the audience's clock (--tz, default Asia/Riyadh), shifted a few random
 * minutes off the hour, and converted to this Mac's clock for X. Fridays open with a
 * religion/fiqh article; during Ramadan the slots move to after iftar and late night.
 * When `bun run x-stats --report` has written .x-schedule/insights.json, categories,
 * quiz types and hook styles that did well get picked more.
 *
 *   bun run x-schedule --day | --month [M YYYY]     plan + write the snippet
 *   bun run x-schedule --rebuild                    rewrite the snippet from an edited .x-schedule/plan.json
 *   bun run x-run                                   one click: schedule it in a Chrome window (see x-run.ts)
 *
 * Or paste the snippet into the x.com DevTools console as before (copied to the
 * clipboard, saved to .x-schedule/snippet.js); with image posts a blue button asks
 * for the elhellal/x-posts folder.
 *
 * Options:
 *   --articles 6 / --quizzes 3 / --quotes 2         posts per day (spread over the day)
 *   --times 10:00,14:30 / --quiz-times / --quote-times / --book-times / --bio-times
 *                                                   exact slots, audience clock
 *   --no-articles --no-quiz --no-quotes --no-book --no-bio --no-roundup --no-recycle
 *   --tz Asia/Riyadh | local                        clock the times are in
 *   --no-jitter                                     exact times
 *   --ramadan auto|on|off                           Ramadan slots (default auto)
 *   --no-cards                                      no image cards
 *   --no-link-share 0.2                             share of articles posted without a link
 *   --ai-hooks                                      write article hooks with Claude (cached)
 *   --no-insights                                   ignore insights.json
 *   --auto-times                                    move the worst article hour to the best unused one
 *   --date / --days / --category / --since / --random / --dry-run / --show
 *
 * Items queued are remembered in .x-schedule/posted.json; the snippet reports what it
 * really scheduled (~/Downloads/elhellal-x-<batch>.json or .x-schedule/reports/) and
 * the next run puts the rest back. Each post is kept in .x-schedule/log.json for x-stats.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Article, Category } from "../src/types";
import { readArticles } from "../src/lib/articles-store.ts";
import { loadAuthorNames } from "./lib/author-names.ts";
import { renderCards, type Card } from "./lib/x-cards.ts";
import { factorOf, loadInsights } from "./lib/x-insights.ts";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, ".x-schedule");
const STATE_FILE = join(OUT_DIR, "posted.json");
const SNIPPET_FILE = join(OUT_DIR, "snippet.js");
const LOG_FILE = join(OUT_DIR, "log.json"); // what each queued post was — joined by x-stats
const PENDING_FILE = join(OUT_DIR, "pending.json"); // batches whose snippet hasn't reported back yet
const PLAN_FILE = join(OUT_DIR, "plan.json"); // the latest batch, editable in the admin panel
const HOOKS_FILE = join(OUT_DIR, "hooks.json"); // AI hooks by article id
const REPORTS_DIR = join(OUT_DIR, "reports"); // reports written by x-run.ts
const SITE = "https://elhellal.com";
const QUIZ_SITE = "https://quiz.elhellal.com";
const QUOTES_SITE = "https://quotes.elhellal.com";
const BIO_SITE = "https://biographies.elhellal.com";
const QUIZ_REPO = join(ROOT, "../elhellal-quiz");
const QUOTES_REPO = join(ROOT, "../elhellal-quotes");
const BIO_FILE = join(ROOT, "../elhellal-biographies/src/data/authors.json");
const X_POSTS = join(ROOT, "x-posts");
const CARDS_DIR = join(X_POSTS, "cards");

// X counts every link as 23 chars; Arabic/Latin weigh 1, most other scripts and emoji 2.
const MAX_WEIGHT = 280;
const URL_WEIGHT = 23;

// ── args ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
};
const dryRun = flag("dry-run");

type Kind = "article" | "quiz" | "book" | "quote" | "bio" | "roundup";
type Item = { id: string; at: string; kind: Kind; text: string; media?: string[]; category?: string; author?: string; style?: string };

mkdirSync(OUT_DIR, { recursive: true });
const readJson = <T>(file: string, fallback: T): T => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback);
const posted: Record<string, string> = readJson(STATE_FILE, {});
type LogEntry = { at: string; kind: string; batch: string; category?: string; author?: string; style?: string; text: string };
const log: Record<string, LogEntry> = readJson(LOG_FILE, {});
const pending: Record<string, string[]> = readJson(PENDING_FILE, {});
const saveState = () => {
    writeFileSync(STATE_FILE, JSON.stringify(posted, null, 2));
    writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
    writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2));
};

// ── reconcile earlier batches ──────────────────────────────────────────
// Items are reserved in posted.json when a snippet is made. The snippet reports the ids it really
// scheduled; anything it didn't get to goes back in the pool.
{
    const dirs = [join(homedir(), "Downloads"), REPORTS_DIR].filter(existsSync);
    const files = dirs.flatMap((d) => readdirSync(d).map((f) => ({ d, f })));
    for (const [batch, ids] of Object.entries(pending)) {
        // A resumed run downloads again ("… (1).json"), so take the union of every report.
        const reports = files.filter(({ f }) => f.startsWith(`elhellal-x-${batch}`) && f.endsWith(".json"));
        if (!reports.length) {
            console.log(`(batch ${batch}: ${ids.length} posts reserved, waiting for its snippet's report)`);
            continue;
        }
        const done = new Set<string>(reports.flatMap(({ d, f }) => JSON.parse(readFileSync(join(d, f), "utf8")).done ?? []));
        const missed = ids.filter((id) => !done.has(id));
        for (const id of missed) {
            delete posted[id];
            delete log[id];
        }
        delete pending[batch];
        console.log(`Batch ${batch}: ${done.size} scheduled${missed.length ? `, ${missed.length} not — back in the pool` : ""}.`);
    }
    if (!dryRun) saveState();
}

if (flag("rebuild")) {
    await rebuild();
    process.exit(0);
}

const mode = flag("month") ? "month" : flag("day") ? "day" : undefined;
if (!mode) {
    console.error("Usage: bun run x-schedule --day | --month [M YYYY] | --rebuild  (see the header of scripts/x-schedule.ts for options)");
    process.exit(1);
}

// ── clocks ─────────────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const TZ = (opt("tz") ?? "Asia/Riyadh") === "local" ? Intl.DateTimeFormat().resolvedOptions().timeZone : (opt("tz") ?? "Asia/Riyadh");
try {
    new Intl.DateTimeFormat("en", { timeZone: TZ });
} catch {
    throw new Error(`Unknown --tz ${TZ}`);
}

/** Offset of `tz` from UTC at instant `ms`, in ms. */
function tzOffset(ms: number, tz: string): number {
    const p = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
            .formatToParts(new Date(ms))
            .map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(ms / 1000) * 1000;
}
/** "YYYY-MM-DD" + "HH:MM" in the audience's clock → instant. */
function zoned(day: string, time: string): number {
    const [y, m, d] = day.split("-").map(Number);
    const [h, mi] = time.split(":").map(Number);
    const guess = Date.UTC(y!, m! - 1, d!, h!, mi!);
    let ms = guess - tzOffset(guess, TZ);
    ms = guess - tzOffset(ms, TZ); // again, in case the guess crossed a DST change
    return ms;
}
/** Instant → "YYYY-MM-DDTHH:MM" on this Mac's clock (what X's dialog and the snippet use). */
const localStamp = (ms: number) => {
    const d = new Date(ms);
    return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const todayInTz = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const addDays = (day: string, n: number) => {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};
const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = Sunday … 5 = Friday
const islamic = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", { month: "numeric", timeZone: "UTC" });
const isRamadan = (day: string) => {
    const m = opt("ramadan") ?? "auto";
    return m === "on" ? true : m === "off" ? false : islamic.format(new Date(`${day}T12:00:00Z`)) === "9";
};

// ── slot times (audience clock) ────────────────────────────────────────
const DEFAULTS = {
    normal: { article: "10:00,14:30,19:30,22:30", quiz: "13:00,17:30", quote: "12:00", book: "21:30", bio: "16:30", roundup: "21:00" },
    // Iftar is ~17:30–18:30 in the Gulf; people read in the afternoon and from iftar to suhoor.
    ramadan: { article: "14:00,20:30,22:30,23:45", quiz: "16:00,21:45", quote: "15:00", book: "23:15", bio: "17:00", roundup: "22:00" },
} as const;
type SlotKind = keyof (typeof DEFAULTS)["normal"];
const OFF: Record<SlotKind, string> = { article: "no-articles", quiz: "no-quiz", quote: "no-quotes", book: "no-book", bio: "no-bio", roundup: "no-roundup" };
const TIMES_OPT: Record<SlotKind, string> = { article: "times", quiz: "quiz-times", quote: "quote-times", book: "book-times", bio: "bio-times", roundup: "roundup-times" };
const COUNT_OPT: Partial<Record<SlotKind, [string, number, number]>> = { article: ["articles", 9, 23], quiz: ["quizzes", 11, 22], quote: ["quotes", 11, 21] };

function checkTimes(list: string[], name: string) {
    for (const t of list) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`Bad time "${t}" in --${name}, use HH:MM (24h)`);
    return list;
}
// `n` posts a day spread evenly over [from, to] hours, nudged off times another kind already uses.
function spread(n: number, taken: string[], from: number, to: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
        let m = n === 1 ? Math.round((from + to) / 2) * 60 : from * 60 + Math.round(((to - from) * 60 * i) / (n - 1) / 5) * 5;
        while (taken.includes(hm(m)) || out.includes(hm(m))) m += 10;
        out.push(hm(m));
    }
    return out;
}
function timesFor(kind: SlotKind, ramadan: boolean, taken: string[]): string[] {
    if (flag(OFF[kind])) return [];
    const given = opt(TIMES_OPT[kind]);
    if (given) return checkTimes(given.split(",").map((t) => t.trim()), TIMES_OPT[kind]);
    const count = COUNT_OPT[kind];
    const n = count ? opt(count[0]) : undefined;
    if (count && n !== undefined) {
        if (!/^\d+$/.test(n) || Number(n) > 24) throw new Error(`--${count[0]} takes a number of posts per day (0-24)`);
        if (Number(n) === 0) return [];
        if (!ramadan) return spread(Number(n), taken, count[1], count[2]);
    }
    if (count && n !== undefined) return spread(Number(n), taken, 13, 23); // Ramadan: afternoon to late night
    return DEFAULTS[ramadan ? "ramadan" : "normal"][kind].split(",");
}

const insights = flag("no-insights") ? null : loadInsights();
const factor = factorOf(insights);
if (insights) console.log(`Using insights from ${insights.updated.slice(0, 10)} (${insights.posts} posts, baseline ${insights.baseline}).`);

// --auto-times: swap the article hour that did worst for the best hour no slot uses (both need ≥4 posts).
function autoTimes(list: string[]): string[] {
    if (!flag("auto-times") || !insights) return list;
    const hours = Object.entries(insights.groups.hour).filter(([, g]) => g.n >= 4);
    if (hours.length < 3) return list;
    // insights hours are on this Mac's clock; compare through today's offset
    const localHour = (t: string) => pad(new Date(zoned(todayInTz(), t)).getHours());
    const scored = list.map((t) => ({ t, f: insights.groups.hour[localHour(t)]?.factor ?? 1 }));
    const worst = scored.sort((a, b) => a.f - b.f)[0]!;
    const used = new Set(list.map(localHour));
    const best = hours.filter(([h]) => !used.has(h)).sort((a, b) => b[1].factor - a[1].factor)[0];
    if (!best || best[1].factor <= worst.f + 0.15) return list;
    const shift = Number(best[0]) - Number(localHour(worst.t));
    const moved = hm((((Number(worst.t.slice(0, 2)) + shift + 24) % 24) * 60) + Number(worst.t.slice(3)));
    console.log(`--auto-times: ${worst.t} (${worst.f}×) → ${moved} (${best[1].factor}×), audience clock`);
    return list.map((t) => (t === worst.t ? moved : t));
}

// Deterministic "random" from a string, so a rerun of the same plan gives the same jitter/styles.
function hash(s: string): number {
    let h = 2166136261;
    for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    return h;
}
const rand = (s: string) => hash(s) / 2 ** 32;

// ── which days, which slots ────────────────────────────────────────────
const monthArgs = (() => {
    const i = argv.indexOf("--month");
    const m = Number(argv[i + 1]);
    const y = Number(argv[i + 2]);
    if (i < 0 || !/^\d{1,2}$/.test(argv[i + 1] ?? "")) return undefined;
    if (m < 1 || m > 12 || !/^\d{4}$/.test(argv[i + 2] ?? "")) throw new Error("Use --month <1-12> <YYYY>, e.g. --month 10 2026");
    return { m, y };
})();
const days = monthArgs ? new Date(monthArgs.y, monthArgs.m, 0).getDate() : mode === "month" ? Number(opt("days") ?? 30) : 1;

// X needs a schedule time a few minutes ahead; keep a margin for the run itself.
const earliest = Date.now() + 15 * 60_000;
type Slot = { at: string; ms: number; day: string; kind: SlotKind };
const takenStamps = new Set(Object.values(posted)); // never two posts in the same minute

function daySlots(day: string): Slot[] {
    const ramadan = isRamadan(day);
    const taken: string[] = [];
    const out: Slot[] = [];
    const wd = weekday(day);
    for (const kind of ["book", "article", "quiz", "quote", "bio", "roundup"] as SlotKind[]) {
        let list = timesFor(kind, ramadan, taken);
        if (kind === "article") list = autoTimes(list);
        if (kind === "roundup" && wd !== 6) list = []; // Saturday, the end of the weekend
        if (kind === "bio" && !opt("bio-times") && wd !== 1 && wd !== 4 && !anniversaryOn(day).length) list = [];
        taken.push(...list);
        for (const t of list) {
            // A few minutes off the round time; posts at exactly :00 look automated.
            let ms = zoned(day, t);
            if (!flag("no-jitter")) ms += Math.round((rand(`${day}${kind}${t}`) * 14 - 4)) * 60_000;
            let at = localStamp(ms);
            while (takenStamps.has(at)) at = localStamp((ms += 60_000));
            takenStamps.add(at);
            if (ms > earliest) out.push({ at, ms, day, kind });
        }
    }
    return out;
}

function firstDay(): string {
    if (monthArgs) return `${monthArgs.y}-${pad(monthArgs.m)}-01`;
    const given = opt("date");
    if (given) return given;
    const today = todayInTz();
    // --day: today if all of today's slots are still ahead, otherwise tomorrow
    if (mode === "day") {
        const probe = DEFAULTS[isRamadan(today) ? "ramadan" : "normal"];
        const first = [opt("times"), probe.article, probe.quiz, probe.quote].filter(Boolean).join(",").split(",").sort()[0]!;
        if (zoned(today, first) > earliest) return today;
    }
    return addDays(today, 1);
}

// ── biographies (needed by daySlots for anniversaries) ─────────────────
type Bio = { slug: string; name: string; image?: string; tagline: string; born?: { year?: number } | null; died?: { year?: number } | null; summary: string; sections?: { text: string }[] };
const bios: Bio[] = flag("no-bio") || !existsSync(BIO_FILE) ? [] : (() => {
    const d = JSON.parse(readFileSync(BIO_FILE, "utf8"));
    return Array.isArray(d) ? d : (d.authors ?? []);
})();
const MONTHS: Record<string, number> = {
    يناير: 1, فبراير: 2, مارس: 3, أبريل: 4, ابريل: 4, إبريل: 4, مايو: 5, يونيو: 6, يونيه: 6, يوليو: 7, يوليه: 7, أغسطس: 8, اغسطس: 8, سبتمبر: 9, أكتوبر: 10, اكتوبر: 10, نوفمبر: 11, ديسمبر: 12,
    "كانون الثاني": 1, شباط: 2, آذار: 3, نيسان: 4, أيار: 5, حزيران: 6, تموز: 7, آب: 8, أيلول: 9, "تشرين الأول": 10, "تشرين الثاني": 11, "كانون الأول": 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
/** "13 أبريل 1953" somewhere in the biography → "04-13" for that year. */
function dayOfYear(b: Bio, year: number | undefined): string | undefined {
    if (!year) return undefined;
    const text = [b.summary, ...(b.sections ?? []).map((s) => s.text)].join(" ");
    const m = new RegExp(`(\\d{1,2})\\s+(${MONTH_RE})\\s+(?:عام\\s+|سنة\\s+)?${year}`).exec(text);
    return m && Number(m[1]) <= 31 ? `${pad(MONTHS[m[2]!]!)}-${pad(Number(m[1]))}` : undefined;
}
const anniversaries = bios.flatMap((b) => [
    ...(dayOfYear(b, b.born?.year) ? [{ b, md: dayOfYear(b, b.born?.year)!, what: "born" as const }] : []),
    ...(dayOfYear(b, b.died?.year) ? [{ b, md: dayOfYear(b, b.died?.year)!, what: "died" as const }] : []),
]);
function anniversaryOn(day: string) {
    return anniversaries.filter((a) => a.md === day.slice(5));
}

const allSlots: Slot[] = [];
{
    let day = firstDay();
    for (let i = 0; i < days; i++, day = addDays(day, 1)) allSlots.push(...daySlots(day));
}
const slotsOf = (k: SlotKind) => allSlots.filter((s) => s.kind === k);
if (!allSlots.length) throw new Error(monthArgs ? "That month is already over — pick a future one" : "No future slots — pick a later --date or --times");
if (allSlots.some((s) => isRamadan(s.day))) console.log("Ramadan slots in use for part of this range.");

// ── tweet text helpers ─────────────────────────────────────────────────
function charWeight(cp: number): number {
    return cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2;
}
function weight(s: string) {
    return [...s].reduce((n, ch) => n + charWeight(ch.codePointAt(0)!), 0);
}
/** Weight as X counts it: each URL is 23. */
function xWeight(s: string) {
    return weight(s.replace(/https?:\/\/\S+/g, "x".repeat(URL_WEIGHT)));
}

function fit(text: string, budget: number): string {
    text = text.replace(/\s+/g, " ").trim();
    if (weight(text) <= budget) return text;
    let out = "";
    for (const w of text.split(" ")) {
        const next = out ? `${out} ${w}` : w;
        if (weight(next) + 2 > budget) break; // "…" weighs 2 on X
        out = next;
    }
    return out.replace(/[\s,،.:;؛-]+$/, "") + "…";
}

const utm = (url: string, id: string) => `${url}${url.includes("?") ? "&" : "?"}utm_source=x&utm_medium=social&utm_content=${encodeURIComponent(id)}`;
const articleUrl = (a: Article) => `${SITE}/articles/${encodeURIComponent(a.slug!)}/`;

// The summaries were written with Latin punctuation ("," 'x' "x" ?); make it read native.
const AR = "\\u0600-\\u06FF";
function arabize(s: string): string {
    return s
        .replace(/\s+/g, " ")
        .replace(/(?<!\d),|,(?!\d)/g, "،")
        .replace(/;/g, "؛")
        .replace(new RegExp(`([${AR}])\\s*\\?`, "g"), "$1؟")
        .replace(/["“]([^"“”]{1,120})["”]/g, "«$1»")
        .replace(new RegExp(`'([^'\\n]*[${AR}][^'\\n]*)'`, "g"), "«$1»")
        .replace(/\s+([،؛؟.!])/g, "$1")
        .replace(/([،؛])(?=[^\s\d])/g, "$1 ")
        .trim();
}
const cleanTitle = (t: string) => arabize(t.replace(/^[\s"'«“”]+|[\s"'»“”]+$/g, ""));
const isArabic = (s: string) => (s.match(new RegExp(`[${AR}]`, "g")) ?? []).length > s.length / 2;

/** Whole sentences while they fit, else the first one cut with "…". */
function sentences(text: string, budget: number): string {
    let out = "";
    for (const s of text.split(/(?<=[.!؟…])\s+/)) {
        const next = out ? `${out} ${s}` : s;
        if (weight(next) > budget) break;
        out = next;
    }
    return out && weight(out) >= budget * 0.4 ? out : fit(text, budget);
}
// The author's own opening lines beat the AI summary as a hook ("يتناول المقال…" stops nobody).
const usablePreview = (a: Article) => {
    const p = arabize(a.preview_text ?? "");
    return p.length >= 60 && isArabic(p) && !p.startsWith(cleanTitle(a.title)) ? p : "";
};

// ── articles ───────────────────────────────────────────────────────────
const authorNames = loadAuthorNames();
const authorOf = (a: Article) => authorNames[a.screen_name]?.replace(/\s+/g, " ").trim();
const STYLES = ["opening", "tldr", "ai", "nolink"] as const;
type Style = (typeof STYLES)[number];
const hooks: Record<string, string> = readJson(HOOKS_FILE, {});

function articleTweet(a: Article, style: Style, id: string): string {
    const title = cleanTitle(a.title);
    const name = authorOf(a);
    const byline = name ? `✍️ ${name}\n` : "";
    const url = utm(articleUrl(a), id);
    if (style === "nolink") {
        // No link: the post has to stand on its own — the best paragraph, then the byline.
        const body = usablePreview(a) || arabize(a.tldr ?? "");
        const budget = MAX_WEIGHT - weight(`${title}\n\n\n\n${byline}`);
        return `${title}\n\n${sentences(body, budget)}\n\n${byline}`.trim();
    }
    if (style === "ai" && hooks[a.id_str]) {
        const hook = arabize(hooks[a.id_str]!);
        const t = `${hook}\n\n«${title}»\n${byline}${url}`;
        if (xWeight(t) <= MAX_WEIGHT) return t;
    }
    const body = style === "tldr" ? arabize(a.tldr ?? "") : usablePreview(a) || arabize(a.tldr ?? "");
    const budget = MAX_WEIGHT - URL_WEIGHT - weight(`${title}\n\n\n\n${byline}`);
    if (budget < 40) return `${fit(title, MAX_WEIGHT - URL_WEIGHT - weight(`\n\n${byline}`))}\n\n${byline}${url}`;
    return `${title}\n\n${sentences(body, budget)}\n\n${byline}${url}`;
}

const data = readArticles() as { articles: Category[] };
const category = opt("category");
const since = opt("since") ?? "2026-09-15";
const categoryTitle = new Map(data.articles.map((c) => [c.category, c.title]));

// Articles readers already open on the site (views worker) go first, even older than --since.
const popular = new Map<string, number>();
try {
    const res = await fetch(`${SITE}/api/most-read?limit=50`, { signal: AbortSignal.timeout(6000) });
    for (const e of ((await res.json()) as { items?: { slug: string; count: number }[] }).items ?? []) {
        if (e.count >= 2) popular.set(e.slug, e.count);
    }
} catch {
    console.warn("(most-read unavailable — no popularity boost this run)");
}
// The same post is sometimes imported twice under different ids/urls, so
// "already used" is judged by author + text, not just by id.
const contentKey = (a: Article) => `${a.screen_name}|${(a.preview_text || a.tldr || a.title).replace(/\s+/g, " ").trim().slice(0, 120)}`;
const all = data.articles.flatMap((c) => c.content);
const byId = new Map(all.map((a) => [a.id_str, a]));
const usedKeys = new Set(all.filter((a) => posted[a.id_str]).map(contentKey));

const seen = new Set<string>();
const categoryOf = new Map<Article, string>();
for (const c of data.articles) for (const a of c.content) categoryOf.set(a, c.category);
type Pick = { a: Article; id: string; recycled?: string };
const pool: Pick[] = data.articles
    .filter((c) => !category || c.category === category)
    .flatMap((c) => c.content)
    .filter((a) => {
        if (!a.tldr?.trim() || !a.slug || posted[a.id_str]) return false;
        if (cleanTitle(a.title).replace(/[\u064B-\u0652\u0640\s\p{P}]/gu, "").length < 4) return false; // junk titles ("ً")
        if (a.created_at < since && !popular.has(a.slug)) return false;
        const key = contentKey(a);
        if (usedKeys.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
    })
    .map((a) => ({ a, id: a.id_str }));

const now = Date.now();
const ageDays = (a: Article) => Math.max(0, (now - new Date(a.created_at).getTime()) / 86_400_000);
const scoreOf = ({ a }: Pick) =>
    (popular.has(a.slug!) ? 2 + Math.log2(popular.get(a.slug!)!) : 1) * factor("category", categoryOf.get(a)) * (1 + 0.5 * Math.exp(-ageDays(a) / 30));
if (flag("random")) {
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    pool.sort((x, y) => (popular.get(y.a.slug!) ?? 0) - (popular.get(x.a.slug!) ?? 0));
} else {
    pool.sort((x, y) => scoreOf(y) - scoreOf(x) || y.a.created_at.localeCompare(x.a.created_at));
}

// Past winners come back after 60 days (at most once per 90), at most one a day, with a different hook.
const recycled: Pick[] = [];
if (!flag("no-recycle") && insights?.winners.length) {
    const lastAgain = (id: string) =>
        Object.entries(posted).filter(([k]) => k.startsWith(`again:${id}:`)).map(([, at]) => at).sort().at(-1);
    for (const w of insights.winners.sort((x, y) => y.score - x.score)) {
        const a = byId.get(w.id);
        if (!a?.slug || (category && categoryOf.get(a) !== category)) continue;
        const last = lastAgain(w.id) ?? w.at;
        if (now - new Date(last).getTime() < (lastAgain(w.id) ? 90 : 60) * 86_400_000) continue;
        recycled.push({ a, id: `again:${w.id}:${ymd(new Date())}`, recycled: log[w.id]?.style });
    }
    if (recycled.length) console.log(`${recycled.length} past winners eligible to come back.`);
}

const FRIDAY = new Set(["quran", "islamic-fiqh", "religion"]);
const queue: Item[] = [];
const picked: { pick: Pick; slot: Slot }[] = [];
{
    const slots = slotsOf("article");
    if (slots.length && pool.length + recycled.length < slots.length) {
        console.warn(`Only ${pool.length} unused articles with a tldr since ${since} — scheduling ${pool.length + recycled.length} of ${slots.length} slots.`);
    }
    // No two articles from the same category or author on one day while others are available.
    let day = "";
    let usedToday = new Set<string>();
    let againToday = false;
    for (const slot of slots) {
        if (slot.day !== day) [day, usedToday, againToday] = [slot.day, new Set(), false];
        const fresh = ({ a }: Pick) => !usedToday.has(categoryOf.get(a)!) && !usedToday.has(`@${a.screen_name}`);
        let pick: Pick | undefined;
        // Friday morning opens with religion/fiqh; Ramadan days get one too.
        const firstOfDay = !usedToday.size;
        if (firstOfDay && (weekday(day) === 5 || isRamadan(day))) {
            const i = pool.findIndex((p) => FRIDAY.has(categoryOf.get(p.a)!) && isArabic(p.a.title) && fresh(p));
            if (i >= 0) pick = pool.splice(i, 1)[0];
        }
        // The third slot of a day may go to a past winner.
        if (!pick && !againToday && usedToday.size === 2 && recycled.length) {
            const i = recycled.findIndex(fresh);
            if (i >= 0) [pick, againToday] = [recycled.splice(i, 1)[0], true];
        }
        if (!pick) {
            if (!pool.length) break;
            let i = pool.findIndex(fresh);
            if (i < 0) i = Math.max(0, pool.findIndex(({ a }) => !usedToday.has(`@${a.screen_name}`)));
            pick = pool.splice(i, 1)[0]!;
        }
        usedToday.add(categoryOf.get(pick.a)!).add(`@${pick.a.screen_name}`);
        picked.push({ pick, slot });
    }
}

// Hook style per post: weighted by what did well, never the same style a re-post went out with.
const noLinkShare = Number(opt("no-link-share") ?? 0.2);
function chooseStyle(p: Pick): Style {
    if (rand(`nolink${p.id}`) < noLinkShare && !p.id.startsWith("again:")) return "nolink";
    const w: Record<Exclude<Style, "nolink">, number> = { opening: usablePreview(p.a) ? 0.45 : 0, tldr: 0.25, ai: flag("ai-hooks") ? 0.3 : 0 };
    for (const k of Object.keys(w) as (keyof typeof w)[]) {
        w[k] *= factor("style", k);
        if (k === p.recycled) w[k] = 0;
    }
    let total = Object.values(w).reduce((x, y) => x + y, 0);
    if (!total) return "tldr";
    let r = rand(`style${p.id}`) * total;
    for (const [k, v] of Object.entries(w) as [Style, number][]) if ((r -= v) < 0) return k;
    return "tldr";
}
const styled = picked.map((x) => ({ ...x, style: chooseStyle(x.pick) }));

if (flag("ai-hooks")) {
    const need = [...new Map(styled.filter((s) => s.style === "ai" && !hooks[s.pick.a.id_str]).map((s) => [s.pick.a.id_str, s.pick.a])).values()];
    if (need.length && !dryRun) await writeHooks(need);
    else if (need.length) console.log(`(--dry-run: would ask Claude for ${need.length} hooks)`);
    for (const s of styled) if (s.style === "ai" && !hooks[s.pick.a.id_str]) s.style = usablePreview(s.pick.a) ? "opening" : "tldr";
}

const cardJobs: { name: string; card: Card }[] = [];
const useCards = !flag("no-cards");
const cardName = (id: string) => id.replace(/[^\w؀-ۿ-]+/g, "_").slice(0, 120);
for (const { pick, slot, style } of styled) {
    const { a, id } = pick;
    const hook = style === "ai" && hooks[a.id_str] ? arabize(hooks[a.id_str]!) : sentences(usablePreview(a) || arabize(a.tldr ?? ""), 200);
    const name = `article-${cardName(a.id_str)}-${style}`;
    if (useCards) cardJobs.push({ name, card: { kind: "article", kicker: categoryTitle.get(categoryOf.get(a)!) ?? "الهلال", title: cleanTitle(a.title), hook, author: authorOf(a) } });
    queue.push({ id, at: slot.at, kind: "article", text: articleTweet(a, style, id), category: categoryOf.get(a), author: a.screen_name, style: id.startsWith("again:") ? `${style}+again` : style, media: useCards ? [`cards/${name}.jpg`] : undefined });
}

// ── quiz questions ─────────────────────────────────────────────────────
const quizSlots = slotsOf("quiz");
if (quizSlots.length) {
    if (!existsSync(QUIZ_REPO)) throw new Error(`Quiz repo not found at ${QUIZ_REPO} (or pass --no-quiz)`);
    // Arabic questions only — the quiz repo also has an English set under /en/.
    const { engine } = await import(join(QUIZ_REPO, "src/game/ar.ts"));
    const seo = await import(join(QUIZ_REPO, "src/game/seo.ts"));
    // One question per category in turn (true/false is 40% of the bank); types that did well come up more.
    const byCat = new Map<string, string[]>();
    for (const [id, cat] of engine.allQuestionIds() as [string, string][]) {
        if (!posted[`quiz:${id}`]) byCat.set(cat, [...(byCat.get(cat) ?? []), id]);
    }
    const seed = Date.now().toString(36);
    for (const l of byCat.values()) l.sort((x, y) => rand(x + seed) - rand(y + seed));
    const cats = [...byCat.keys()].sort((x, y) => factor("quizType", y) - factor("quizType", x) || rand(x) - rand(y));
    const credit = new Map(cats.map((c) => [c, 0]));
    const picks: [string, string][] = [];
    while (picks.length < quizSlots.length && [...byCat.values()].some((l) => l.length)) {
        // Weighted round-robin: each round every type earns its factor; the richest goes next.
        for (const c of cats) credit.set(c, credit.get(c)! + factor("quizType", c));
        const c = cats.filter((k) => byCat.get(k)!.length).sort((x, y) => credit.get(y)! - credit.get(x)!)[0]!;
        credit.set(c, credit.get(c)! - cats.length);
        picks.push([byCat.get(c)!.pop()!, c]);
    }
    if (picks.length < quizSlots.length) console.warn(`Only ${picks.length} unused quiz questions — scheduling ${picks.length} of ${quizSlots.length} quiz slots.`);
    picks.forEach(([id, cat], i) => {
        const url = utm(`${QUIZ_SITE}${seo.qPath("ar", id)}`, `quiz:${id}`);
        const q = engine.questionById(id);
        const { text, card } = quizTweet(q, url, seo.seoTitle("ar", q));
        const name = `quiz-${cardName(id)}`;
        if (useCards) cardJobs.push({ name, card });
        queue.push({ id: `quiz:${id}`, at: quizSlots[i]!.at, kind: "quiz", text, category: cat, media: useCards ? [`cards/${name}.jpg`] : undefined });
    });
}

// The question with its choices, and a reply prompt — replies are what X rewards. (X can't schedule
// polls: its Schedule button is disabled while a poll is attached.) Options are shuffled per question.
function quizTweet(q: { id: string; text: string; options: string[]; claim?: string; year?: unknown }, url: string, title: string): { text: string; card: Card } {
    const stripQ = (s: string) => s.replace(/[؟?]\s*$/, "");
    let body: string;
    let cta: string;
    let card: Card;
    if (q.year) {
        body = `🧠 في أي عام؟\n${q.text}`;
        cta = "اكتب العام في الرد، والجواب هنا 👇";
        card = { kind: "quiz", kicker: "في أي عام؟", question: q.text, options: [] };
    } else if (q.claim) {
        body = `🧠 صح أم خطأ؟\n\n${stripQ(q.text)}: ${q.claim}`;
        cta = "صح أم خطأ؟ جاوب في الرد، والجواب هنا 👇";
        card = { kind: "quiz", kicker: "صح أم خطأ؟", question: `${stripQ(q.text)}: ${q.claim}`, options: ["صح", "خطأ"] };
    } else {
        const h = hash(q.id);
        const opts = q.options.map((o, i) => ({ o, k: ((h ^ (i * 2654435761)) >>> 0) % 1000 })).sort((a, b) => a.k - b.k).map(({ o }) => o);
        const letters = ["أ", "ب", "ج", "د", "هـ", "و"];
        body = `🧠 ${q.text}\n\n${opts.map((o, i) => `${letters[i]}) ${o}`).join("\n")}`;
        cta = "اكتب حرف إجابتك في الرد، والجواب هنا 👇";
        card = { kind: "quiz", kicker: "سؤال الهلال", question: q.text, options: opts };
    }
    const text = `${body}\n\n${cta}\n${url}`;
    if (xWeight(text) <= MAX_WEIGHT) return { text, card };
    return { text: `${fit(`🧠 ${title}`, MAX_WEIGHT - URL_WEIGHT - weight(`\n\n${cta}\n`))}\n\n${cta}\n${url}`, card };
}

// ── quotes ─────────────────────────────────────────────────────────────
const quoteSlots = slotsOf("quote");
if (quoteSlots.length) {
    if (!existsSync(QUOTES_REPO)) throw new Error(`Quotes repo not found at ${QUOTES_REPO} (or pass --no-quotes)`);
    const { getQuotes } = await import(join(QUOTES_REPO, "src/utils/quotes.ts"));
    type Q = { id: string; text: string; likes?: number; author: string; authorSlug: string; book?: string };
    const clean = (s: string) => arabize(s.replace(/\s+/g, " ").replace(/^[\s*"“”«»]+|[\s*"“”«»]+$/g, "").trim());
    const groups = new Map<string, Q[]>();
    for (const q of getQuotes() as Q[]) {
        const t = clean(q.text);
        if (t.length < 30 || t.length > 220 || /https?:|www\./.test(t) || !isArabic(t) || posted[`quote:${q.authorSlug}/${q.id}`]) continue;
        groups.set(q.authorSlug, [...(groups.get(q.authorSlug) ?? []), { ...q, text: t }]);
    }
    // Most-liked first, authors taking turns.
    const lists = [...groups.values()].map((l) => l.sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))).sort((a, b) => (b[0]!.likes ?? 0) - (a[0]!.likes ?? 0));
    const mixed: Q[] = [];
    for (let i = 0; mixed.length < quoteSlots.length && lists.some((l) => l.length > i); i++) for (const l of lists) if (l[i]) mixed.push(l[i]!);
    mixed.slice(0, quoteSlots.length).forEach((q, i) => {
        const id = `quote:${q.authorSlug}/${q.id}`;
        const url = utm(`${QUOTES_SITE}/${encodeURIComponent(q.authorSlug)}/${encodeURIComponent(q.id)}/`, id);
        const source = `— ${q.author}${q.book ? ` · «${q.book}»` : ""}`;
        const text = `«${fit(q.text, MAX_WEIGHT - URL_WEIGHT - weight(`«»\n\n${source}\n`))}»\n\n${source}\n${url}`;
        const name = `quote-${cardName(`${q.authorSlug}-${q.id}`)}`;
        if (useCards) cardJobs.push({ name, card: { kind: "quote", text: q.text, author: q.author, book: q.book } });
        queue.push({ id, at: quoteSlots[i]!.at, kind: "quote", text, author: q.authorSlug, media: useCards ? [`cards/${name}.jpg`] : undefined });
    });
}

// ── biographies ────────────────────────────────────────────────────────
const bioSlots = slotsOf("bio");
if (bioSlots.length && bios.length) {
    const years = (b: Bio) => `${b.born?.year ?? "؟"}${b.died?.year ? ` – ${b.died.year}` : ""}`;
    const regular = bios.filter((b) => !posted[`bio:${b.slug}`]).sort((x, y) => rand(x.slug) - rand(y.slug));
    for (const slot of bioSlots) {
        const ann = anniversaryOn(slot.day).find((a) => !posted[`bio:${a.b.slug}:${slot.day.slice(0, 4)}:${a.what}`]);
        const b = ann?.b ?? regular.shift();
        if (!b) break;
        const id = ann ? `bio:${b.slug}:${slot.day.slice(0, 4)}:${ann.what}` : `bio:${b.slug}`;
        const url = utm(`${BIO_SITE}/${encodeURIComponent(b.slug)}/`, id);
        const head = ann ? `📅 في مثل هذا اليوم: ذكرى ${ann.what === "born" ? "ميلاد" : "رحيل"} ${b.name} (${years(b)})` : `👤 ${b.name} (${years(b)})`;
        const tagline = arabize(b.tagline);
        const budget = MAX_WEIGHT - URL_WEIGHT - weight(`${head}\n${tagline}\n\n\n\nالسيرة كاملة 👇\n`);
        const text = `${head}\n${tagline}\n\n${sentences(arabize(b.summary), budget)}\n\nالسيرة كاملة 👇\n${url}`;
        const name = `bio-${cardName(b.slug)}${ann ? `-${ann.what}` : ""}`;
        if (useCards) cardJobs.push({ name, card: { kind: "bio", kicker: ann ? `في مثل هذا اليوم · ذكرى ${ann.what === "born" ? "الميلاد" : "الرحيل"}` : "سيرة", name: b.name, years: years(b), tagline, photo: b.image } });
        queue.push({ id, at: slot.at, kind: "bio", text, author: b.slug, style: ann ? "anniversary" : "regular", media: useCards ? [`cards/${name}.jpg`] : undefined });
    }
}

// ── weekly roundup (Saturday) ──────────────────────────────────────────
for (const slot of slotsOf("roundup")) {
    const id = `roundup:${slot.day}`;
    if (posted[id]) continue;
    // This week's best on X first, then what readers open most on the site.
    const weekAgo = zoned(slot.day, "00:00") - 7 * 86_400_000;
    const fromX = (insights?.winners ?? []).filter((w) => new Date(w.at).getTime() >= weekAgo).map((w) => byId.get(w.id));
    const fromSite = [...popular.keys()].map((slug) => all.find((a) => a.slug === slug));
    const list = [...new Set([...fromX, ...fromSite].filter((a): a is Article => !!a?.slug))];
    const head = "📚 مختارات الهلال هذا الأسبوع:\n\n";
    const tail = `\n\nاقرأها كلها على الهلال 👇\n${utm(`${SITE}/`, id)}`;
    const lines: string[] = [];
    for (const a of list) {
        const line = `${lines.length + 1}. ${fit(cleanTitle(a.title), 70)}`;
        if (xWeight(head + [...lines, line].join("\n") + tail) > MAX_WEIGHT || lines.length === 5) break;
        lines.push(line);
    }
    if (lines.length >= 3) queue.push({ id, at: slot.at, kind: "roundup", text: head + lines.join("\n") + tail });
}

// ── book / lesson ──────────────────────────────────────────────────────
// Folders made by generate-book-tweet.ts: x-posts/<date>/<NN-slug>/{1-book.png,2-lesson.png,tweet.txt}.
// Only folders dated today or later count — older ones were posted by hand.
function bookFolders(): string[] {
    if (!existsSync(X_POSTS)) return [];
    const today = ymd(new Date());
    return readdirSync(X_POSTS)
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= today)
        .sort()
        .flatMap((d) => readdirSync(join(X_POSTS, d)).sort().map((f) => `${d}/${f}`))
        .filter((rel) => ["1-book.png", "2-lesson.png", "tweet.txt"].every((f) => existsSync(join(X_POSTS, rel, f))))
        .filter((rel) => !posted[`book:${rel}`]);
}
const bookSlots = slotsOf("book");
if (bookSlots.length) {
    let folders = bookFolders();
    const missing = bookSlots.length - folders.length;
    if (missing > 0 && dryRun) {
        console.log(`(${folders.length} book posts ready, ${missing} would be generated)`);
    } else if (missing > 0) {
        if (!existsSync(QUOTES_REPO)) throw new Error(`Quotes repo not found at ${QUOTES_REPO} (or pass --no-book)`);
        // The generator makes at most 30 per run and numbers folders per date, so each chunk gets its own date.
        const needed = bookSlots.slice(folders.length);
        for (let i = 0; i < needed.length; i += 30) {
            const chunk = needed.slice(i, i + 30);
            console.log(`\nGenerating ${chunk.length} book/lesson posts…`);
            const r = Bun.spawnSync(
                ["bun", "run", "scripts/generate-book-tweet.ts", "--count", String(chunk.length), "--date", chunk[0]!.at.slice(0, 10), "--out-dir", X_POSTS, "--no-copy"],
                { cwd: QUOTES_REPO, stdout: "inherit", stderr: "inherit" },
            );
            if (r.exitCode !== 0) console.warn("Book generator failed — scheduling the book posts that exist.");
        }
        folders = bookFolders();
    }
    if (folders.length < bookSlots.length && !dryRun) console.warn(`Only ${folders.length} book posts — scheduling ${folders.length} of ${bookSlots.length} book slots.`);
    bookSlots.slice(0, folders.length).forEach((slot, i) => {
        const rel = folders[i]!;
        queue.push({ id: `book:${rel}`, at: slot.at, kind: "book", text: readFileSync(join(X_POSTS, rel, "tweet.txt"), "utf8").trim(), media: [`${rel}/1-book.png`, `${rel}/2-lesson.png`] });
    });
}

queue.sort((a, b) => a.at.localeCompare(b.at));
if (!queue.length) throw new Error("Nothing to schedule");
for (const q of queue) {
    if (xWeight(q.text) > MAX_WEIGHT) console.warn(`⚠ ${q.at} ${q.kind} is ${xWeight(q.text)}/280 — X will refuse it`);
}

// ── output ─────────────────────────────────────────────────────────────
for (const q of queue) {
    const tag = `${q.kind}${q.style ? `/${q.style}` : ""}`;
    if (flag("show")) console.log(`\n── ${q.at.replace("T", " ")}  ${tag}${q.category ? ` (${q.category})` : ""}${q.media ? `  🖼 ${q.media.length}` : ""}\n${q.text}`);
    else console.log(`${q.at.replace("T", " ")}  ${tag.padEnd(16)} ${q.kind === "book" ? q.id.slice(5) : q.text.split("\n")[0]!.slice(0, 64) + "…"}`);
}
const count = (k: Kind) => queue.filter((q) => q.kind === k).length;
const summary = (["article", "quiz", "quote", "book", "bio", "roundup"] as Kind[]).filter(count).map((k) => `${count(k)} ${k}`).join(", ");
console.log(`\n${queue.length} posts (${summary}), ${queue[0]!.at.replace("T", " ")} → ${queue.at(-1)!.at.replace("T", " ")} (this Mac's clock; slots planned in ${TZ})`);

if (dryRun) {
    console.log(`\n--dry-run: nothing written${cardJobs.length ? `, ${cardJobs.length} cards not rendered` : ""}.`);
    process.exit(0);
}

if (cardJobs.length) {
    console.log(`\nRendering ${cardJobs.length} image cards → x-posts/cards/`);
    const ok = await renderCards(CARDS_DIR, cardJobs);
    // A card that failed to render: post without it rather than not at all.
    for (const q of queue) if (q.media?.[0]?.startsWith("cards/") && !ok.has(q.media[0].slice(6, -4))) delete q.media;
}

const batch = `${mode}-${queue[0]!.at}-${Date.now().toString(36)}`.replace(/[^\w-]/g, "-");
writeBatch(batch, queue, TZ);

// ── shared: write a batch (plan, snippet, state) ───────────────────────
function writeBatch(batch: string, items: Item[], tz: string) {
    writeFileSync(PLAN_FILE, JSON.stringify({ batch, created: new Date().toISOString(), tz, items }, null, 2));
    const snippet = browserSnippet(batch, items);
    writeFileSync(SNIPPET_FILE, snippet);
    for (const q of items) {
        posted[q.id] = q.at;
        log[q.id] = { at: q.at, kind: q.kind, batch, category: q.category, author: q.author, style: q.style, text: q.text };
    }
    pending[batch] = items.map((q) => q.id);
    saveState();
    let copied = false;
    try {
        copied = Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(snippet) }).exitCode === 0;
    } catch {}
    const images = items.some((q) => q.media);
    console.log(`
Snippet saved to .x-schedule/snippet.js${copied ? " and copied to clipboard" : ""} — plan in .x-schedule/plan.json (editable in the admin panel).
One click:  bun run x-run   (a Chrome window schedules it; log into X there once)
Or by hand:
1. Open https://x.com/home in Chrome (logged in)
2. Cmd+Opt+J → paste → Enter (type "allow pasting" first if Chrome asks)${images ? `
   → click the blue button and pick ${X_POSTS} (for the images)` : ""}
3. Leave the tab in front until the console says "done"`);
}

// ── --rebuild: the plan was edited (admin panel) ───────────────────────
async function rebuild() {
    if (!existsSync(PLAN_FILE)) throw new Error("No .x-schedule/plan.json — run --day or --month first");
    const plan = JSON.parse(readFileSync(PLAN_FILE, "utf8")) as { batch: string; tz: string; items: Item[] };
    const ids = pending[plan.batch];
    if (!ids) throw new Error(`Batch ${plan.batch} already reported back — its posts are on X; plan a new one instead`);
    const keep = new Set(plan.items.map((q) => q.id));
    for (const id of ids) {
        if (!keep.has(id)) {
            delete posted[id];
            delete log[id];
        }
    }
    for (const q of plan.items) {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(q.at)) throw new Error(`Bad time ${q.at} for ${q.id}`);
        if (xWeight(q.text) > MAX_WEIGHT) throw new Error(`${q.id} is ${xWeight(q.text)}/280`);
    }
    plan.items.sort((a, b) => a.at.localeCompare(b.at));
    console.log(`Rebuilding batch ${plan.batch}: ${plan.items.length} posts (${ids.length - plan.items.length} removed).`);
    writeBatch(plan.batch, plan.items, plan.tz);
}

// ── AI hooks ───────────────────────────────────────────────────────────
// One `claude -p` call per 25 articles; results are cached in hooks.json so each article is asked once.
async function writeHooks(articles: Article[]) {
    console.log(`\nAsking Claude for ${articles.length} article hooks…`);
    // Bun loads .env, whose ANTHROPIC_API_KEY would override the claude.ai login; drop it (as claude-run.ts does).
    const { ANTHROPIC_API_KEY: _k, ...env } = process.env;
    for (let i = 0; i < articles.length; i += 25) {
        const chunk = articles.slice(i, i + 25).map((a) => ({ id: a.id_str, title: a.title, opening: (a.preview_text ?? "").slice(0, 600), summary: a.tldr ?? "" }));
        const prompt = `You write the first line of X (Twitter) posts for الهلال, a directory of Arabic articles.
For each article below write ONE Arabic line (at most 140 characters) that makes a reader stop scrolling: a striking claim, a sharp question, or a concrete detail taken from the article itself.
Rules: Modern Standard Arabic; no hashtags, no emoji, no links, no clickbait, nothing the article doesn't say; never start with "يتناول المقال" or "في هذا المقال"; don't repeat the title.
Reply with ONLY a JSON array: [{"id": "...", "hook": "..."}].

${JSON.stringify(chunk)}`;
        const proc = Bun.spawn(["claude", "-p", prompt, "--output-format", "json", "--tools", ""], { env, stdout: "pipe", stderr: "pipe" });
        const timer = setTimeout(() => proc.kill(), 5 * 60_000);
        const out = await new Response(proc.stdout).text();
        clearTimeout(timer);
        if ((await proc.exited) !== 0) {
            console.warn(`  Claude failed (${(await new Response(proc.stderr).text()).trim().slice(0, 200)}) — those posts use another style`);
            continue;
        }
        try {
            const result = String(JSON.parse(out).result ?? "");
            const arr = JSON.parse(result.slice(result.indexOf("["), result.lastIndexOf("]") + 1)) as { id: string; hook: string }[];
            let n = 0;
            for (const { id, hook } of arr) {
                if (chunk.some((c) => c.id === id) && typeof hook === "string" && hook.trim() && weight(hook) <= 160 && isArabic(hook)) {
                    hooks[id] = hook.trim();
                    n++;
                }
            }
            console.log(`  ${n}/${chunk.length} hooks`);
        } catch {
            console.warn("  Couldn't read Claude's answer — those posts use another style");
        }
        writeFileSync(HOOKS_FILE, JSON.stringify(hooks, null, 2));
    }
}

// ── browser side ───────────────────────────────────────────────────────
function browserSnippet(batch: string, items: Item[]): string {
    return `// elhellal → X scheduler (${items.length} posts) — paste into the x.com DevTools console
(async () => {
  const QUEUE = ${JSON.stringify(items.map(({ id, at, text, media }) => ({ id, at, text, media })))};
  const KEY = ${JSON.stringify(`elhellal-x:${batch}`)};
  const done = new Set(JSON.parse(localStorage.getItem(KEY) || "[]"));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  async function waitFor(fn, what, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(200); }
    throw new Error("Timed out waiting for " + what);
  }
  function setSelect(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(el, String(value));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (el.value !== String(value)) throw new Error("Could not set " + el.id + " to " + value);
  }
  function typeInto(box, text) {
    box.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }

  async function schedule(item) {
    const [date, time] = item.at.split("T");
    const [y, mo, d] = date.split("-").map(Number);
    const [h, mi] = time.split(":").map(Number);

    // Always use the modal composer — /home also has an inline one with the same test ids.
    const modal = () => $('[role="dialog"] [data-testid="tweetTextarea_0"]')?.closest('[role="dialog"]');
    for (let i = 0; i < 3 && !modal(); i++) {
      (await waitFor(() => $('[data-testid="SideNav_NewTweet_Button"]'), "Post button")).click();
      await waitFor(modal, "composer", 8000).catch(() => {});
    }
    const dialog = await waitFor(modal, "composer");
    const box = $('[data-testid="tweetTextarea_0"]', dialog);
    if (box.textContent.trim()) throw new Error("composer is not empty — clear it and paste again");
    typeInto(box, item.text);
    const chars = Math.min(20, item.text.replace(/\\s/g, "").length - 1);
    await waitFor(() => box.textContent.replace(/\\s/g, "").length >= chars, "text to appear");

    if (item.media) {
      const input = await waitFor(() => $('input[data-testid="fileInput"]', dialog), "image input");
      const dt = new DataTransfer();
      for (const p of item.media) dt.items.add(await getFile(p));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await waitFor(() => $('[data-testid="attachments"]', dialog), "images to attach", 30000);
      await sleep(1500);
      await waitFor(() => !$('[role="progressbar"]', dialog), "images to upload", 90000);
    }

    (await waitFor(() => $('[data-testid="scheduleOption"]', dialog), "schedule button")).click();
    const selects = await waitFor(() => { const s = document.querySelectorAll('[role="dialog"] select'); return s.length >= 6 && s; }, "schedule dialog");
    const [month, day, year, hour, minute, ampm] = selects;
    setSelect(year, y);
    setSelect(month, mo);
    setSelect(day, d);
    setSelect(hour, h % 12 === 0 ? 12 : h % 12);
    setSelect(minute, mi);
    setSelect(ampm, h < 12 ? "am" : "pm");
    await sleep(300);
    (await waitFor(() => $('[data-testid="scheduledConfirmationPrimaryAction"]'), "Confirm")).click();

    // Never click unless X shows the schedule banner for this exact time — otherwise it would post right now.
    const indicator = await waitFor(() => $('[role="dialog"] [data-testid="scheduledTweetIndicator"]'), "schedule banner");
    const hh = h % 12 === 0 ? 12 : h % 12;
    const expect = hh + ":" + String(mi).padStart(2, "0") + " " + (h < 12 ? "AM" : "PM");
    const banner = indicator.textContent.replace(/[\\s\\u00a0\\u202f]+/g, " ");
    if (!banner.includes(expect) || !banner.includes(String(y))) {
      throw new Error("schedule banner says '" + indicator.textContent + "', expected " + item.at);
    }
    const btn = await waitFor(() => { const b = $('[role="dialog"] [data-testid="tweetButton"]'); return b && !b.disabled && b.getAttribute("aria-disabled") !== "true" && b; }, "Schedule button", 90000);
    btn.click();
    await waitFor(() => !modal(), "composer to close", 30000);
  }

  // Tells the next \`bun run x-schedule\` which posts really got scheduled (the rest go back in its pool).
  function report() {
    const data = { batch: ${JSON.stringify(batch)}, done: [...done] };
    if (window.__elhellalReport) return window.__elhellalReport(JSON.stringify(data)); // x-run.ts
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
    a.download = ${JSON.stringify(`elhellal-x-${batch}.json`)};
    a.click();
  }

  console.log("%celhellal → X: " + QUEUE.length + " posts (" + done.size + " already done)", "font-weight:bold");

  // Images live on disk: x-run.ts hands them over; pasted by hand, you pick the x-posts folder once.
  const needed = QUEUE.filter((q) => q.media && !done.has(q.id)).flatMap((q) => q.media);
  const FILES = new Map();
  async function getFile(p) {
    if (FILES.has(p)) return FILES.get(p);
    if (!window.__elhellalFile) throw new Error("image " + p + " missing");
    const { b64, type } = await window.__elhellalFile(p);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const f = new File([bytes], p.split("/").pop(), { type });
    FILES.set(p, f);
    return f;
  }
  if (needed.length && !window.__elhellalFile) {
    console.log("%cClick the blue button at the top of the page and pick the elhellal/x-posts folder.", "font-weight:bold;color:#1d9bf0");
    await new Promise((resolve) => {
      const input = Object.assign(document.createElement("input"), { type: "file", multiple: true, webkitdirectory: true });
      input.style.display = "none";
      const btn = Object.assign(document.createElement("button"), { textContent: "📁 Pick the elhellal/x-posts folder (images)" });
      Object.assign(btn.style, { position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)", zIndex: 2147483647, padding: "14px 24px", font: "bold 16px system-ui", borderRadius: "999px", border: "0", background: "#1d9bf0", color: "#fff", cursor: "pointer" });
      btn.onclick = () => input.click();
      input.onchange = () => {
        for (const f of input.files) FILES.set(f.webkitRelativePath.split("/").slice(1).join("/"), f);
        btn.remove(); input.remove(); resolve();
      };
      document.body.append(btn, input);
    });
    const missing = needed.filter((p) => !FILES.has(p));
    if (missing.length) {
      console.error("✗ " + missing.length + " images not found in the picked folder (did you pick x-posts?), e.g. " + missing[0] + ". Paste the snippet again.");
      return;
    }
  }

  let ok = 0, skipped = 0;
  for (const item of QUEUE) {
    if (done.has(item.id)) continue;
    if (new Date(item.at).getTime() < Date.now() + 5 * 60000) {
      console.warn("skip (time already passed)", item.at); skipped++; continue;
    }
    try {
      await schedule(item);
      done.add(item.id);
      localStorage.setItem(KEY, JSON.stringify([...done]));
      ok++;
      console.log("✓ " + item.at.replace("T", " ") + " (" + done.size + "/" + QUEUE.length + ")");
    } catch (e) {
      console.error("✗ " + item.at + " — " + e.message + ". Stopping; fix and paste the snippet again to resume.");
      report();
      return "error";
    }
    await sleep(2500 + Math.random() * 2500);
  }
  report();
  console.log("%cdone — " + ok + " scheduled, " + skipped + " skipped. See x.com/compose/post/unsent/scheduled", "font-weight:bold;color:#1d9bf0");
  return "done";
})();
`;
}
