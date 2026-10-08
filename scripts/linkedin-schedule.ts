#!/usr/bin/env bun
/**
 * LinkedIn scheduler — الهلال company page
 * ----------------------------------------
 * Same idea as x-schedule.ts, but for the LinkedIn page: posts are scheduled
 * through LinkedIn's own "Schedule post" dialog using the session you are
 * already logged into in Chrome (no API keys). Every day gets:
 *   - 4 articles   tldr (+ why it matters) + elhellal.com link — LinkedIn
 *                  shows the article's link preview card
 *   - 2 quizzes    a question + its quiz.elhellal.com/q/<id>/ link
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
 *   --articles 6                       articles per day, spread 08:00–22:00 (default 4)
 *   --quizzes 3                        Arabic quiz questions per day, spread 09:00–21:00 (default 2)
 *   --times 09:00,13:00,18:00,21:00   exact daily article slots (local time, 24h; "--no-articles" to skip)
 *   --quiz-times 11:00,16:00           exact daily quiz slots ("--no-quiz" to skip)
 *   --date YYYY-MM-DD                  day to use (--day) / first day (--month)
 *   --days 30                          number of days for --month
 *   --category <slug>                  only use articles from one category
 *   --since YYYY-MM-DD                 only articles created on/after this day (default 2026-09-15)
 *   --random                           random order instead of newest first
 *   --dry-run                          print the plan, don't mark articles as used
 *   --no-book                          accepted for parity with x-schedule (LinkedIn has no book posts)
 *
 * Articles and quiz questions already queued are remembered in
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
    console.error("Usage: bun run linkedin-schedule --day | --month [M YYYY] [--articles N] [--quizzes N] [--times 09:00,13:00,18:00,21:00] [--quiz-times 11:00,16:00] [--no-articles|--no-quiz] [--date YYYY-MM-DD] [--days 30] [--category slug] [--random] [--dry-run]");
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
const times = timeList("times", "09:00,13:00,18:00,21:00", "no-articles", "articles");
const quizTimes = timeList("quiz-times", "11:00,16:00", "no-quiz", "quizzes", times, [9, 21]);
const allTimes = [...times, ...quizTimes];
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
const quizSlots = slotsFor(quizTimes);
if (!slots.length && !quizSlots.length) throw new Error(monthArgs ? "That month is already over — pick a future one" : "No future slots — pick a later --date or --times");

// ── post text ──────────────────────────────────────────────────────────
const clean = (s?: string) => (s ?? "").replace(/\s+/g, " ").trim();

// Raw Arabic slug, not percent-encoded: LinkedIn still builds the preview from
// it, and the post shows a readable link instead of a wall of %D8%A3….
function articleUrl(a: Article): string {
    return `${SITE}/articles/${a.slug!.replace(/\s/g, "-")}/`;
}

// The link goes last so LinkedIn builds the preview card from it.
function buildPost(a: Article): string {
    const parts = [clean(a.tldr)];
    if (clean(a.whyThisMatters)) parts.push(`💡 ${clean(a.whyThisMatters)}`);
    const tail = `📖 اقرأ المقال كاملاً:\n${articleUrl(a)}`;
    let body = parts.join("\n\n");
    const budget = MAX_CHARS - tail.length - 2;
    if (body.length > budget) body = body.slice(0, budget - 1).replace(/\s+\S*$/, "") + "…";
    return `${body}\n\n${tail}`;
}

// ── pick articles ──────────────────────────────────────────────────────
const data = readArticles() as { articles: Category[] };
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

type Item = { id: string; at: string; kind: "article" | "quiz"; text: string };
const queue: Item[] = pool.slice(0, slots.length).map((a, i) => ({
    id: a.id_str,
    at: slots[i]!,
    kind: "article",
    text: buildPost(a),
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
        const title = clean(seo.seoTitle("ar", engine.questionById(id)));
        queue.push({ id: `quiz:${id}`, at, kind: "quiz", text: `🧠 ${title}\n\nجرّب الإجابة 👇\n${url}` });
    });
}

queue.sort((a, b) => a.at.localeCompare(b.at));
if (!queue.length) throw new Error("Nothing to schedule");
const first = queue[0]!.at;
const last = queue[queue.length - 1]!.at;

// ── output ─────────────────────────────────────────────────────────────
for (const q of queue) console.log(`${q.at.replace("T", " ")}  ${q.kind.padEnd(7)} ${q.text.split("\n")[0]!.slice(0, 70)}…`);
const count = (k: Item["kind"]) => queue.filter((q) => q.kind === k).length;
console.log(`\n${queue.length} posts (${count("article")} articles, ${count("quiz")} quizzes), ${first.replace("T", " ")} → ${last.replace("T", " ")}`);

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
