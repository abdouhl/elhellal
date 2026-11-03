#!/usr/bin/env bun
/**
 * LinkedIn scheduler — الهلال company page
 * ----------------------------------------
 * Same idea as x-schedule.ts, but for the LinkedIn page: posts are scheduled
 * through LinkedIn's own "Schedule post" dialog using the session you are
 * already logged into in Chrome (no API keys). Every day gets, interleaved
 * and spread 09:00–21:00 (a company page loses reach when posts crowd together):
 *   - 2 articles   title hook + tldr + why it matters + author byline + a
 *                  question for the comments + hashtags + elhellal.com link
 *                  (LinkedIn shows the article's link preview card)
 *   - 1 quote      most-liked quotes from ../elhellal-quotes, authors taking
 *                  turns, + a quotes.elhellal.com link
 *   - 1 quiz       the question with its choices, answer in the comments,
 *                  checked on quiz.elhellal.com/q/<id>/
 *
 *   bun run linkedin-schedule --day      one day (today if all slots are still
 *                                        ahead, otherwise tomorrow)
 *   bun run linkedin-schedule --month    the next 30 days
 *   bun run linkedin-schedule --month 10 2026
 *                                        every day of that calendar month (days
 *                                        already past are skipped)
 *
 * Then open the page admin (https://www.linkedin.com/company/84134110/admin/page-posts/published/)
 * in Chrome, open DevTools console (Cmd+Opt+J) and paste — the snippet is
 * copied to your clipboard and also saved to .linkedin-schedule/snippet.js.
 * Keep the tab in front until it logs "done". Rerunning the same snippet
 * skips posts it already scheduled.
 *
 * Options:
 *   --articles 3 --quotes 1 --quizzes 1
 *                                      posts per day of each kind (default 2/1/1, 0 = none)
 *   --times 09:00,17:00                exact daily article slots (local time, 24h; "--no-articles" to skip)
 *   --quote-times 13:00                exact daily quote slots ("--no-quotes" to skip)
 *   --quiz-times 21:00                 exact daily quiz slots ("--no-quiz" to skip)
 *   --date YYYY-MM-DD                  day to use (--day) / first day (--month)
 *   --days 30                          number of days for --month
 *   --category <slug>                  only use articles from one category
 *   --since YYYY-MM-DD                 only articles created on/after this day (default 2026-09-15)
 *   --random                           random order instead of newest first
 *   --dry-run                          print the plan, don't mark articles as used
 *   --no-book                          accepted for parity with x-schedule (LinkedIn has no book posts)
 *
 * Articles, quotes and quiz questions already queued are remembered in
 * .linkedin-schedule/posted.json (separate from X's, so the same article can
 * go to both) and are never picked twice.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Article, Category } from "../src/types";
import { readArticles } from "../src/lib/articles-store.ts";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, ".linkedin-schedule");
const STATE_FILE = join(OUT_DIR, "posted.json");
const SNIPPET_FILE = join(OUT_DIR, "snippet.js");
const SITE = "https://elhellal.com";
const QUIZ_SITE = "https://quiz.elhellal.com";
const QUIZ_REPO = join(ROOT, "../elhellal-quiz");
const QUOTES_JSON = join(ROOT, "../elhellal-quotes/src/data/quotes.json");
const AUTHOR_NAMES = join(ROOT, "src/data/author-names.json");
const ADMIN_URL = "https://www.linkedin.com/company/84134110/admin/page-posts/published/";

// LinkedIn allows 3000 chars; the feed folds after ~210, so the tldr leads.
const MAX_CHARS = 3000;

// ── args ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
};

const mode = flag("month") ? "month" : flag("day") ? "day" : undefined;
if (!mode) {
    console.error("Usage: bun run linkedin-schedule --day | --month [M YYYY] [--articles 2] [--quotes 1] [--quizzes 1] [--times 09:00,17:00] [--quote-times 13:00] [--quiz-times 21:00] [--no-articles|--no-quotes|--no-quiz] [--date YYYY-MM-DD] [--days 30] [--category slug] [--random] [--dry-run]");
    process.exit(1);
}
// ── daily slots ────────────────────────────────────────────────────────
// Each kind gets either its exact --*-times or a count; counted kinds are
// interleaved (article, quote, article, quiz…) and spread evenly over the window,
// nudged off any exact times another kind already uses.
const WINDOW = [9 * 60, 21 * 60];
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
type Kind = "article" | "quote" | "quiz";
const KIND_OPTS: Record<Kind, { times: string; count: string; off: string[]; def: number }> = {
    article: { times: "times", count: "articles", off: ["no-articles"], def: 2 },
    quote: { times: "quote-times", count: "quotes", off: ["no-quotes", "no-quote"], def: 1 },
    quiz: { times: "quiz-times", count: "quizzes", off: ["no-quiz"], def: 1 },
};
const KINDS = Object.keys(KIND_OPTS) as Kind[];
function exactTimes(k: Kind): string[] | undefined {
    const raw = opt(KIND_OPTS[k].times);
    if (raw === undefined || KIND_OPTS[k].off.some(flag)) return undefined;
    const list = raw.split(",").map((t) => t.trim());
    for (const t of list) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`Bad time "${t}" in --${KIND_OPTS[k].times}, use HH:MM (24h)`);
    }
    return list;
}
function countOf(k: Kind): number {
    if (KIND_OPTS[k].off.some(flag)) return 0;
    const n = opt(KIND_OPTS[k].count);
    if (n === undefined) return KIND_OPTS[k].def;
    if (!/^\d+$/.test(n) || Number(n) > 24) throw new Error(`--${KIND_OPTS[k].count} takes a number of posts per day (0-24)`);
    return Number(n);
}
const dayTimes: Record<Kind, string[]> = { article: [], quote: [], quiz: [] };
const left: Record<Kind, number> = { article: 0, quote: 0, quiz: 0 };
for (const k of KINDS) {
    const exact = exactTimes(k);
    if (exact) dayTimes[k] = exact;
    else left[k] = countOf(k);
}
{
    const order: Kind[] = [];
    while (KINDS.some((k) => left[k] > 0)) {
        // Most-remaining first, never the same kind twice in a row when another is left.
        const next = KINDS.filter((k) => left[k] > 0).sort((a, b) => left[b] - left[a]);
        const pick = next.find((k) => k !== order.at(-1)) ?? next[0]!;
        order.push(pick);
        left[pick]--;
    }
    const taken = new Set(KINDS.flatMap((k) => dayTimes[k]));
    const [from, to] = WINDOW as [number, number];
    order.forEach((k, i) => {
        let m = order.length === 1 ? 13 * 60 : from + Math.round(((to - from) * i) / (order.length - 1) / 5) * 5;
        while (taken.has(hm(m))) m += 10;
        taken.add(hm(m));
        dayTimes[k].push(hm(m));
    });
}
const times = dayTimes.article;
const quoteTimes = dayTimes.quote;
const quizTimes = dayTimes.quiz;
const allTimes = [...times, ...quoteTimes, ...quizTimes];
// `--month 10 2026` → that calendar month; plain `--month` → next --days days.
const monthArgs = (() => {
    const i = argv.indexOf("--month");
    const m = Number(argv[i + 1]);
    const y = Number(argv[i + 2]);
    if (i < 0 || !/^\d{1,2}$/.test(argv[i + 1] ?? "")) return undefined;
    if (m < 1 || m > 12 || !/^\d{4}$/.test(argv[i + 2] ?? "")) {
        throw new Error("Use --month <1-12> <YYYY>, e.g. --month 10 2026");
    }
    return { m, y };
})();
const days = monthArgs
    ? new Date(monthArgs.y, monthArgs.m, 0).getDate()
    : mode === "month" ? Number(opt("days") ?? 30) : 1;
const dryRun = flag("dry-run");

// ── dates ──────────────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const at = (day: string, time: string) => new Date(`${day}T${time}:00`);

// Keep a margin so the earliest slot is still in the future when the snippet reaches it.
const earliest = Date.now() + 15 * 60_000;

function firstDay(): string {
    if (monthArgs) return `${monthArgs.y}-${pad(monthArgs.m)}-01`;
    const given = opt("date");
    if (given) return given;
    const today = ymd(new Date());
    if (mode === "day" && allTimes.every((t) => at(today, t).getTime() > earliest)) return today;
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return ymd(d);
}

function slotsFor(list: string[]): string[] {
    const out: string[] = [];
    const d = new Date(`${firstDay()}T00:00:00`);
    for (let i = 0; i < days; i++) {
        for (const t of list) {
            if (at(ymd(d), t).getTime() > earliest) out.push(`${ymd(d)}T${t}`);
        }
        d.setDate(d.getDate() + 1);
    }
    return out;
}
const slots = slotsFor(times);
const quoteSlots = slotsFor(quoteTimes);
const quizSlots = slotsFor(quizTimes);
if (!slots.length && !quoteSlots.length && !quizSlots.length) throw new Error(monthArgs ? "That month is already over — pick a future one" : "No future slots — pick a later --date or --times");

// ── post text ──────────────────────────────────────────────────────────
const clean = (s?: string) => (s ?? "").replace(/\s+/g, " ").trim();

// Raw Arabic slug, not percent-encoded: LinkedIn still builds the preview from
// it, and the post shows a readable link instead of a wall of %D8%A3….
function articleUrl(a: Article): string {
    return `${SITE}/articles/${a.slug!.replace(/\s/g, "-")}/`;
}

// "#علم_النفس": letters, digits and _ only (LinkedIn ends a hashtag at anything else).
function hashtag(s: string): string {
    const t = s.normalize("NFC").replace(/[\u064B-\u0652\u0640]/g, "").trim().replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_]/gu, "");
    return t.length >= 2 && t.length <= 30 ? `#${t}` : "";
}
function hashtags(words: (string | undefined)[], max = 5): string {
    return [...new Set(words.map((w) => hashtag(w ?? "")).filter(Boolean))].slice(0, max).join(" ");
}
// "الاقتصاد والمال" → الاقتصاد, المال; "عام ومتنوع" is too vague to tag.
function categoryWords(slug: string): string[] {
    const title = categoryTitles.get(slug);
    if (!title || slug === "general") return [];
    return title.split(/\s+و(?=\S)/).map((w) => w.trim());
}

// Same item → same wording, so a rerun or --dry-run shows what will go out.
function pickFor<T>(id: string, list: T[]): T {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return list[h % list.length]!;
}
const ARTICLE_ASKS = [
    "ما رأيك؟ شاركنا في التعليقات 👇",
    "هل تتفق مع الكاتب؟ أخبرنا في التعليقات 👇",
    "ما الفكرة التي تراها أهمّ هنا؟ 👇",
    "♻️ شاركه مع من يهمّه الموضوع.",
];
const QUOTE_ASKS = ["هل تتفق مع هذا القول؟ 👇", "ما الاقتباس الذي لا تنساه؟ شاركنا في التعليقات 👇", "♻️ شاركه مع من يحتاجه اليوم."];

// The title is the hook (the feed folds after ~210 chars); the link goes last so
// LinkedIn builds the preview card from it and the composer's caret never sits
// right after a hashtag (which opens LinkedIn's hashtag typeahead).
function buildPost(a: Article, catSlug: string): string {
    const name = clean(authorNames[a.screen_name]);
    const head = [clean(a.title), clean(a.tldr)];
    if (clean(a.whyThisMatters)) head.push(`💡 ${clean(a.whyThisMatters)}`);
    const tail = [
        name && name.length <= 40 ? `✍️ بقلم ${name}` : "",
        pickFor(a.id_str, ARTICLE_ASKS),
        hashtags([...categoryWords(catSlug), ...(a.keywords ?? []).slice(0, 2), "مقالات عربية"]),
        `📖 اقرأ المقال كاملاً:\n${articleUrl(a)}`,
    ].filter(Boolean).join("\n\n");
    let body = head.join("\n\n");
    const budget = MAX_CHARS - tail.length - 2;
    if (body.length > budget) body = body.slice(0, budget - 1).replace(/\s+\S*$/, "") + "…";
    return `${body}\n\n${tail}`;
}

// ── pick articles ──────────────────────────────────────────────────────
const data = readArticles() as { articles: Category[] };
mkdirSync(OUT_DIR, { recursive: true });
const posted: Record<string, string> = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const authorNames: Record<string, string> = existsSync(AUTHOR_NAMES) ? JSON.parse(readFileSync(AUTHOR_NAMES, "utf8")) : {};
const categoryTitles = new Map(data.articles.map((c) => [c.category, c.title]));
const categoryOf = new Map(data.articles.flatMap((c) => c.content.map((a) => [a.id_str, c.category] as const)));

const category = opt("category");
const since = opt("since") ?? "2026-09-15";
// The same post is sometimes imported twice under different ids/urls, so
// "already used" is judged by author + text, not just by id.
const contentKey = (a: Article) => `${a.screen_name}|${(a.preview_text || a.tldr || a.title).replace(/\s+/g, " ").trim().slice(0, 120)}`;
const all = data.articles.flatMap((c) => c.content);
const usedKeys = new Set(all.filter((a) => posted[a.id_str]).map(contentKey));

const seen = new Set<string>();
const pool = data.articles
    .filter((c) => !category || c.category === category)
    .flatMap((c) => c.content)
    .filter((a) => {
        if (!a.tldr?.trim() || !a.slug || a.created_at < since || posted[a.id_str]) return false;
        const key = contentKey(a);
        if (usedKeys.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
    });

if (flag("random")) {
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
} else {
    pool.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

if (slots.length && pool.length < slots.length) {
    console.warn(`Only ${pool.length} unused articles with a tldr since ${since} — scheduling ${pool.length} of ${slots.length} slots.`);
}

type Item = { id: string; at: string; kind: Kind; text: string };
const queue: Item[] = pool.slice(0, slots.length).map((a, i) => ({
    id: a.id_str,
    at: slots[i]!,
    kind: "article",
    text: buildPost(a, categoryOf.get(a.id_str) ?? ""),
}));

// ── quotes ─────────────────────────────────────────────────────────────
// Every author in ../elhellal-quotes (their own quotes and their books'), most-liked
// first, authors taking turns so the page never runs one writer twice in a row.
if (quoteSlots.length) {
    if (!existsSync(QUOTES_JSON)) throw new Error(`Quotes data not found at ${QUOTES_JSON} (or pass --no-quotes)`);
    type Q = { id: string; text: string; likes?: number; tags?: string[] };
    const authors: { slug: string; name: string; quotes?: Q[]; books?: { title: string; quotes?: Q[] }[] }[] =
        JSON.parse(readFileSync(QUOTES_JSON, "utf8")).authors ?? [];
    const groups = authors
        .map((a) =>
            [...(a.quotes ?? []).map((q) => ({ q, a, book: "" })), ...(a.books ?? []).flatMap((b) => (b.quotes ?? []).map((q) => ({ q, a, book: b.title })))]
                .filter(({ q }) => q.text?.trim() && q.text.length <= 600 && !posted[`quote:${q.id}`])
                .sort((x, y) => (y.q.likes ?? 0) - (x.q.likes ?? 0)),
        )
        .filter((g) => g.length);
    for (let i = groups.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [groups[i], groups[j]] = [groups[j]!, groups[i]!];
    }
    const mixed: (typeof groups)[number] = [];
    for (let i = 0; groups.some((g) => g.length > i); i++) for (const g of groups) if (g[i]) mixed.push(g[i]!);
    // quotes.json can be ahead of the live site (authors or quotes imported but
    // not deployed yet), so only take quotes whose page is up. An author with a
    // missing page is skipped from then on (new authors are missing entirely).
    const missing = new Set<string>();
    let offline = false;
    const picked: typeof mixed = [];
    for (const m of mixed) {
        if (picked.length >= quoteSlots.length) break;
        if (missing.has(m.a.slug)) continue;
        const url = `https://quotes.elhellal.com/${m.a.slug}/${m.q.id}/`;
        const ok = offline || (await fetch(url, { method: "HEAD" }).then((r) => r.ok, () => ((offline = true), true)));
        if (ok) picked.push(m);
        else missing.add(m.a.slug);
    }
    if (missing.size) console.warn(`Skipped ${missing.size} quote authors not live on quotes.elhellal.com yet (deploy elhellal-quotes to include them).`);
    if (offline) console.warn("Could not reach quotes.elhellal.com — quote links were not checked.");
    if (picked.length < quoteSlots.length) console.warn(`Only ${picked.length} unused live quotes — scheduling ${picked.length} of ${quoteSlots.length} quote slots.`);
    quoteSlots.slice(0, picked.length).forEach((at, i) => {
        const { q, a, book } = picked[i]!;
        const url = `https://quotes.elhellal.com/${a.slug}/${q.id}/`;
        const text = [
            `❝ ${q.text.trim()} ❞`,
            `— ${a.name}${book ? `، «${book}»` : ""}`,
            pickFor(q.id, QUOTE_ASKS),
            hashtags(["اقتباسات", a.name, ...(q.tags ?? []).slice(0, 2), "كتب"]),
            `📚 المزيد من اقتباسات ${a.name}:\n${url}`,
        ].join("\n\n");
        queue.push({ id: `quote:${q.id}`, at, kind: "quote", text });
    });
}

// ── quiz questions ─────────────────────────────────────────────────────
if (quizSlots.length) {
    if (!existsSync(QUIZ_REPO)) throw new Error(`Quiz repo not found at ${QUIZ_REPO} (or pass --no-quiz)`);
    // Arabic questions only — the quiz repo also has an English set under /en/.
    const { engine } = await import(join(QUIZ_REPO, "src/game/ar.ts"));
    const seo = await import(join(QUIZ_REPO, "src/game/seo.ts"));
    const ids = (engine.allQuestionIds() as [string, string][]).map(([id]) => id).filter((id) => !posted[`quiz:${id}`]);
    for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    }
    if (ids.length < quizSlots.length) console.warn(`Only ${ids.length} unused quiz questions — scheduling ${ids.length} of ${quizSlots.length} quiz slots.`);
    quizSlots.slice(0, ids.length).forEach((at, i) => {
        const id = ids[i]!;
        const url = `${QUIZ_SITE}${seo.qPath("ar", id)}`;
        const q = engine.questionById(id);
        const title = clean(seo.seoTitle("ar", q));
        // Spell out the choices so people can answer in the feed; skip them when the
        // title already names them (either-or, true/false and shared-prompt questions).
        const listed = q.options.length > 2 && !q.options.every((o: string) => title.includes(o));
        const choices = listed ? q.options.map((o: string, k: number) => `${"أبجدهوزح"[k]}) ${o}`).join("\n") : "";
        const ask = q.year ? "اكتب السنة في التعليقات، ثم تحقّق من إجابتك 👇" : "اكتب إجابتك في التعليقات، ثم تحقّق منها هنا 👇";
        const text = [`🧠 ${title}`, choices, hashtags(["اختبر معلوماتك", "ثقافة عامة", "مسابقة"]), `${ask}\n${url}`].filter(Boolean).join("\n\n");
        queue.push({ id: `quiz:${id}`, at, kind: "quiz", text });
    });
}

queue.sort((a, b) => a.at.localeCompare(b.at));
if (!queue.length) throw new Error("Nothing to schedule");
const first = queue[0]!.at;
const last = queue[queue.length - 1]!.at;

// ── output ─────────────────────────────────────────────────────────────
for (const q of queue) console.log(`${q.at.replace("T", " ")}  ${q.kind.padEnd(7)} ${q.text.split("\n")[0]!.slice(0, 70)}…`);
const count = (k: Item["kind"]) => queue.filter((q) => q.kind === k).length;
console.log(`\n${queue.length} posts (${count("article")} articles, ${count("quote")} quotes, ${count("quiz")} quizzes), ${first.replace("T", " ")} → ${last.replace("T", " ")}`);

if (dryRun) {
    // One day is short enough to read every post in full before scheduling.
    if (mode === "day") for (const q of queue) console.log(`\n── ${q.at.replace("T", " ")} ${q.kind} ──\n${q.text}`);
    console.log("\n--dry-run: nothing written.");
    process.exit(0);
}

const batch = `${mode}-${first}-${Date.now().toString(36)}`;
const snippet = browserSnippet(batch, queue);
writeFileSync(SNIPPET_FILE, snippet);
for (const q of queue) posted[q.id] = q.at;
writeFileSync(STATE_FILE, JSON.stringify(posted, null, 2));

let copied = false;
try {
    const p = Bun.spawn(["pbcopy"], { stdin: "pipe" });
    p.stdin.write(snippet);
    p.stdin.end();
    copied = (await p.exited) === 0;
} catch {}

console.log(`
Snippet saved to .linkedin-schedule/snippet.js${copied ? " and copied to clipboard" : ""}.
1. Open ${ADMIN_URL} in Chrome (logged in as a page admin)
2. Cmd+Opt+J → paste → Enter (type "allow pasting" first if Chrome asks)
3. Leave the tab in front until the console says "done"`);

// ── browser side ───────────────────────────────────────────────────────
function browserSnippet(batch: string, items: typeof queue): string {
    return `// elhellal → LinkedIn scheduler (${items.length} posts) — paste into the LinkedIn page-admin DevTools console
(async () => {
  const QUEUE = ${JSON.stringify(items)};
  const KEY = ${JSON.stringify(`elhellal-li:${batch}`)};
  const done = new Set(JSON.parse(localStorage.getItem(KEY) || "[]"));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const byText = (sel, text, root = document) => [...root.querySelectorAll(sel)].find((b) => b.textContent.trim() === text);
  async function waitFor(fn, what, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(200); }
    throw new Error("Timed out waiting for " + what);
  }
  function setInput(el, value) {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    el.blur();
  }
  const composer = () => $('[role="dialog"] .ql-editor')?.closest('[role="dialog"]');

  if (!/\\/company\\/\\d+\\/admin\\//.test(location.pathname)) {
    console.error("✗ Open the الهلال page admin first: ${ADMIN_URL}");
    return;
  }

  async function schedule(item) {
    const when = new Date(item.at + ":00");
    const h = when.getHours(), mi = when.getMinutes();
    const time12 = (h % 12 || 12) + ":" + String(mi).padStart(2, "0") + " " + (h < 12 ? "AM" : "PM");

    for (let i = 0; i < 3 && !composer(); i++) {
      (await waitFor(() => byText("button", "Start a post"), "Start a post button")).click();
      await waitFor(composer, "composer", 8000).catch(() => {});
    }
    const dialog = await waitFor(composer, "composer");
    const box = $(".ql-editor", dialog);
    if (box.textContent.trim()) throw new Error("composer is not empty — discard the draft and paste again");
    box.focus();
    document.execCommand("insertText", false, item.text);
    const url = item.text.match(/https:\\/\\/\\S+$/)[0];
    await waitFor(() => box.innerText.includes(url), "text to appear");
    // Give LinkedIn time to build the link preview card (posting still works without it).
    await waitFor(() => $(".update-components-article", dialog), "link preview", 15000)
      .catch(() => console.warn("  no link preview for " + item.at + " — scheduling anyway"));

    (await waitFor(() => $('button[aria-label="Schedule post"]', dialog), "schedule button")).click();
    const date = await waitFor(() => $("#share-post__scheduled-date"), "schedule dialog");
    setInput(date, (when.getMonth() + 1) + "/" + when.getDate() + "/" + when.getFullYear());
    await sleep(400);
    setInput($("#share-post__scheduled-time"), time12);
    await sleep(600);
    (await waitFor(() => byText('[role="dialog"] button', "Next"), "Next")).click();

    // Never click unless LinkedIn shows "Posting <day> at <time>" for this exact slot — otherwise it would post right now.
    const dayLabel = when.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const banner = await waitFor(() => { const d = composer(); return d && /Posting/.test(d.innerText) && d; }, "schedule banner");
    const text = banner.innerText.replace(/[\\s\\u00a0\\u202f]+/g, " ");
    if (!text.includes("Posting " + dayLabel + " at " + time12)) {
      throw new Error("schedule banner says '" + (text.match(/Posting [^\\n]*?(AM|PM)/) || [text.slice(0, 80)])[0] + "', expected " + dayLabel + " at " + time12);
    }
    const btn = await waitFor(() => { const b = byText('[role="dialog"] button', "Schedule"); return b && !b.disabled && b; }, "Schedule button", 30000);
    btn.click();
    await waitFor(() => !composer(), "composer to close", 30000);
  }

  console.log("%celhellal → LinkedIn: " + QUEUE.length + " posts (" + done.size + " already done)", "font-weight:bold");
  let ok = 0, skipped = 0;
  for (const item of QUEUE) {
    if (done.has(item.id)) continue;
    if (new Date(item.at + ":00").getTime() < Date.now() + 5 * 60000) {
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
      return;
    }
    await sleep(3000 + Math.random() * 3000);
  }
  console.log("%cdone — " + ok + " scheduled, " + skipped + " skipped. See 'View all scheduled posts' in the Schedule dialog.", "font-weight:bold;color:#0a66c2");
})();
`;
}
