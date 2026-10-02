#!/usr/bin/env bun
/**
 * X (Twitter) scheduler — الهلال
 * ------------------------------
 * Every day gets three kinds of post, scheduled through x.com's own
 * "Schedule post" dialog using the session you are already logged into in
 * Chrome (no API keys):
 *   - 4 articles   tldr + elhellal.com link (from src/data/articles.json)
 *   - 2 quizzes    a question + its quiz.elhellal.com/q/<id>/ link — X shows
 *                  the question's OG image (from ../elhellal-quiz)
 *   - 1 book       "الكتاب / الدرس" with 1-book.png + 2-lesson.png from
 *                  x-posts/<date>/<NN-book>/; missing ones are generated with
 *                  ../elhellal-quotes/scripts/generate-book-tweet.ts
 *
 *   bun run x-schedule --day      one day (today if all slots are still
 *                                 ahead, otherwise tomorrow)
 *   bun run x-schedule --month    the next 30 days
 *   bun run x-schedule --month 10 2026
 *                                 every day of that calendar month (days
 *                                 already past are skipped)
 *
 * Then open https://x.com/home in Chrome, open DevTools console
 * (Cmd+Opt+J) and paste — the snippet is copied to your clipboard and also
 * saved to .x-schedule/snippet.js. When there are book posts, a blue button
 * appears: click it and pick the elhellal/x-posts folder so the snippet can
 * attach the images. Keep the tab in front until it logs "done".
 * Rerunning the same snippet skips posts it already scheduled.
 *
 * Options:
 *   --articles 6                       articles per day, spread 08:00–22:00 (default 4)
 *   --quizzes 3                        Arabic quiz questions per day, spread 09:00–21:00 (default 2)
 *   --times 09:00,13:00,18:00,21:00   exact daily article slots (local time, 24h; "--no-articles" to skip)
 *   --quiz-times 11:00,16:00           exact daily quiz slots ("--no-quiz" to skip)
 *   --book-times 20:00                 daily book/lesson slots ("--no-book" to skip)
 *   --date YYYY-MM-DD                  day to use (--day) / first day (--month)
 *   --days 30                          number of days for --month
 *   --category <slug>                  only use articles from one category
 *   --since YYYY-MM-DD                 only articles created on/after this day (default 2026-09-15)
 *   --random                           random order instead of newest first
 *   --dry-run                          print the plan, don't mark articles as used
 *
 * Articles, quiz questions and book folders already queued are remembered in
 * .x-schedule/posted.json so they are never picked twice.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Article, Category } from "../src/types";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, ".x-schedule");
const STATE_FILE = join(OUT_DIR, "posted.json");
const SNIPPET_FILE = join(OUT_DIR, "snippet.js");
const SITE = "https://elhellal.com";
const QUIZ_SITE = "https://quiz.elhellal.com";
const QUIZ_REPO = join(ROOT, "../elhellal-quiz");
const QUOTES_REPO = join(ROOT, "../elhellal-quotes");
const X_POSTS = join(ROOT, "x-posts");

// X counts every link as 23 chars; Arabic/Latin weigh 1, most other scripts and emoji 2.
const MAX_WEIGHT = 280;
const URL_WEIGHT = 23;

// ── args ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
};

const mode = flag("month") ? "month" : flag("day") ? "day" : undefined;
if (!mode) {
    console.error("Usage: bun run x-schedule --day | --month [M YYYY] [--articles N] [--quizzes N] [--times 09:00,13:00,18:00,21:00] [--quiz-times 11:00,16:00] [--book-times 20:00] [--no-articles|--no-quiz|--no-book] [--date YYYY-MM-DD] [--days 30] [--category slug] [--random] [--dry-run]");
    process.exit(1);
}
// `n` posts a day spread evenly over [from, to] hours, nudged off times another kind already uses.
function spread(n: number, taken: string[], from: number, to: number): string {
    const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
        let m = n === 1 ? 13 * 60 : from * 60 + Math.round(((to - from) * 60 * i) / (n - 1) / 5) * 5;
        while (taken.includes(hm(m)) || out.includes(hm(m))) m += 10;
        out.push(hm(m));
    }
    return out.join(",");
}
function timeList(name: string, fallback: string, off: string, countName?: string, taken: string[] = [], window = [8, 22]): string[] {
    if (flag(off)) return [];
    const n = countName ? opt(countName) : undefined;
    if (n !== undefined && !opt(name)) {
        if (!/^\d+$/.test(n) || Number(n) > 24) throw new Error(`--${countName} takes a number of posts per day (0-24)`);
        if (Number(n) === 0) return [];
        fallback = spread(Number(n), taken, window[0]!, window[1]!);
    }
    const list = (opt(name) ?? fallback).split(",").map((t) => t.trim());
    for (const t of list) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`Bad time "${t}" in --${name}, use HH:MM (24h)`);
    }
    return list;
}
const bookTimes = timeList("book-times", "20:00", "no-book");
const times = timeList("times", "09:00,13:00,18:00,21:00", "no-articles", "articles", bookTimes);
const quizTimes = timeList("quiz-times", "11:00,16:00", "no-quiz", "quizzes", [...bookTimes, ...times], [9, 21]);
const allTimes = [...times, ...quizTimes, ...bookTimes];
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

// X needs a schedule time a few minutes ahead; keep a margin for the run itself.
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
const quizSlots = slotsFor(quizTimes);
const bookSlots = slotsFor(bookTimes);
if (!slots.length && !quizSlots.length && !bookSlots.length) throw new Error(monthArgs ? "That month is already over — pick a future one" : "No future slots — pick a later --date or --times");

// ── tweet text ─────────────────────────────────────────────────────────
function charWeight(cp: number): number {
    return cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2;
}
const weight = (s: string) => [...s].reduce((n, ch) => n + charWeight(ch.codePointAt(0)!), 0);

function fit(text: string, budget: number): string {
    text = text.replace(/\s+/g, " ").trim();
    if (weight(text) <= budget) return text;
    const words = text.split(" ");
    let out = "";
    for (const w of words) {
        const next = out ? `${out} ${w}` : w;
        if (weight(next) + 1 > budget) break;
        out = next;
    }
    return out.replace(/[\s,،.:;؛-]+$/, "") + "…";
}

function articleUrl(a: Article): string {
    return `${SITE}/articles/${encodeURIComponent(a.slug!)}/`;
}

function buildTweet(a: Article): string {
    const sep = "\n\n";
    const body = fit(a.tldr!, MAX_WEIGHT - URL_WEIGHT - weight(sep));
    return `${body}${sep}${articleUrl(a)}`;
}

// ── pick articles ──────────────────────────────────────────────────────
const data = JSON.parse(readFileSync(join(ROOT, "src/data/articles.json"), "utf8")) as { articles: Category[] };
mkdirSync(OUT_DIR, { recursive: true });
const posted: Record<string, string> = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};

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

type Item = { id: string; at: string; kind: "article" | "quiz" | "book"; text: string; media?: string[] };
const queue: Item[] = pool.slice(0, slots.length).map((a, i) => ({
    id: a.id_str,
    at: slots[i]!,
    kind: "article",
    text: buildTweet(a),
}));

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
        const sep = "\n\n";
        const body = fit(`🧠 ${seo.seoTitle("ar", engine.questionById(id))}`, MAX_WEIGHT - URL_WEIGHT - weight(sep));
        queue.push({ id: `quiz:${id}`, at, kind: "quiz", text: `${body}${sep}${url}` });
    });
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
                ["bun", "run", "scripts/generate-book-tweet.ts", "--count", String(chunk.length), "--date", chunk[0]!.slice(0, 10), "--out-dir", X_POSTS, "--no-copy"],
                { cwd: QUOTES_REPO, stdout: "inherit", stderr: "inherit" },
            );
            if (r.exitCode !== 0) console.warn("Book generator failed — scheduling the book posts that exist.");
        }
        folders = bookFolders();
    }
    if (folders.length < bookSlots.length && !dryRun) console.warn(`Only ${folders.length} book posts — scheduling ${folders.length} of ${bookSlots.length} book slots.`);
    bookSlots.slice(0, folders.length).forEach((at, i) => {
        const rel = folders[i]!;
        queue.push({
            id: `book:${rel}`,
            at,
            kind: "book",
            text: readFileSync(join(X_POSTS, rel, "tweet.txt"), "utf8").trim(),
            media: [`${rel}/1-book.png`, `${rel}/2-lesson.png`],
        });
    });
}

queue.sort((a, b) => a.at.localeCompare(b.at));
if (!queue.length) throw new Error("Nothing to schedule");
const first = queue[0]!.at;
const last = queue[queue.length - 1]!.at;

// ── output ─────────────────────────────────────────────────────────────
for (const q of queue) console.log(`${q.at.replace("T", " ")}  ${q.kind.padEnd(7)} ${q.kind === "book" ? q.id.slice(5) : q.text.split("\n")[0]!.slice(0, 70) + "…"}`);
const count = (k: Item["kind"]) => queue.filter((q) => q.kind === k).length;
console.log(`\n${queue.length} posts (${count("article")} articles, ${count("quiz")} quizzes, ${count("book")} books), ${first.replace("T", " ")} → ${last.replace("T", " ")}`);

if (dryRun) {
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
Snippet saved to .x-schedule/snippet.js${copied ? " and copied to clipboard" : ""}.
1. Open https://x.com/home in Chrome (logged in)
2. Cmd+Opt+J → paste → Enter (type "allow pasting" first if Chrome asks)${count("book") ? `
   → click the blue button and pick ${X_POSTS} (for the book images)` : ""}
3. Leave the tab in front until the console says "done"`);

// ── browser side ───────────────────────────────────────────────────────
function browserSnippet(batch: string, items: typeof queue): string {
    return `// elhellal → X scheduler (${items.length} posts) — paste into the x.com DevTools console
(async () => {
  const QUEUE = ${JSON.stringify(items)};
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
      for (const p of item.media) dt.items.add(FILES.get(p));
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

  console.log("%celhellal → X: " + QUEUE.length + " posts (" + done.size + " already done)", "font-weight:bold");

  // Book posts carry two local images; the page can't read your disk, so you pick the x-posts folder once.
  const needed = QUEUE.filter((q) => q.media && !done.has(q.id)).flatMap((q) => q.media);
  const FILES = new Map();
  if (needed.length) {
    console.log("%cClick the blue button at the top of the page and pick the elhellal/x-posts folder.", "font-weight:bold;color:#1d9bf0");
    await new Promise((resolve) => {
      const input = Object.assign(document.createElement("input"), { type: "file", multiple: true, webkitdirectory: true });
      input.style.display = "none";
      const btn = Object.assign(document.createElement("button"), { textContent: "📁 Pick the elhellal/x-posts folder (book images)" });
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
      return;
    }
    await sleep(2500 + Math.random() * 2500);
  }
  console.log("%cdone — " + ok + " scheduled, " + skipped + " skipped. See x.com/compose/post/unsent/scheduled", "font-weight:bold;color:#1d9bf0");
})();
`;
}
