#!/usr/bin/env bun
/**
 * X (Twitter) scheduler — الهلال
 * ------------------------------
 * Picks articles from src/data/articles.json that have a `tldr`, builds one
 * post per article (tldr + encoded elhellal.com link) and writes a browser
 * snippet that schedules them through x.com's own "Schedule post" dialog,
 * using the session you are already logged into in Chrome. No API keys.
 *
 *   bun run x-schedule --day      4 posts on one day (today if all slots are
 *                                 still ahead, otherwise tomorrow)
 *   bun run x-schedule --month    4 posts a day for the next 30 days (120)
 *
 * Then open https://x.com/home in Chrome, open DevTools console
 * (Cmd+Opt+J) and paste — the snippet is copied to your clipboard and also
 * saved to .x-schedule/snippet.js. Keep the tab in front until it logs "done".
 * Rerunning the same snippet skips posts it already scheduled.
 *
 * Options:
 *   --times 09:00,13:00,18:00,21:00   the 4 daily slots (local time, 24h)
 *   --date YYYY-MM-DD                  day to use (--day) / first day (--month)
 *   --days 30                          number of days for --month
 *   --category <slug>                  only use articles from one category
 *   --since YYYY-MM-DD                 only articles created on/after this day (default 2026-09-15)
 *   --random                           random order instead of newest first
 *   --dry-run                          print the plan, don't mark articles as used
 *
 * Articles already queued are remembered in .x-schedule/posted.json so they are
 * never picked twice.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Article, Category } from "../src/types";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, ".x-schedule");
const STATE_FILE = join(OUT_DIR, "posted.json");
const SNIPPET_FILE = join(OUT_DIR, "snippet.js");
const SITE = "https://elhellal.com";

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
    console.error("Usage: bun run x-schedule --day | --month [--times 09:00,13:00,18:00,21:00] [--date YYYY-MM-DD] [--days 30] [--category slug] [--random] [--dry-run]");
    process.exit(1);
}
const times = (opt("times") ?? "09:00,13:00,18:00,21:00").split(",").map((t) => t.trim());
for (const t of times) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`Bad time "${t}", use HH:MM (24h)`);
}
const days = mode === "month" ? Number(opt("days") ?? 30) : 1;
const dryRun = flag("dry-run");

// ── dates ──────────────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const at = (day: string, time: string) => new Date(`${day}T${time}:00`);

// X needs a schedule time a few minutes ahead; keep a margin for the run itself.
const earliest = Date.now() + 15 * 60_000;

function firstDay(): string {
    const given = opt("date");
    if (given) return given;
    const today = ymd(new Date());
    if (mode === "day" && times.every((t) => at(today, t).getTime() > earliest)) return today;
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return ymd(d);
}

const slots: string[] = [];
{
    const d = new Date(`${firstDay()}T00:00:00`);
    for (let i = 0; i < days; i++) {
        for (const t of times) {
            const when = at(ymd(d), t);
            if (when.getTime() > earliest) slots.push(`${ymd(d)}T${t}`);
        }
        d.setDate(d.getDate() + 1);
    }
}
if (!slots.length) throw new Error("No future slots — pick a later --date or --times");

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
let pool = data.articles
    .filter((c) => !category || c.category === category)
    .flatMap((c) => c.content)
    .filter((a) => a.tldr?.trim() && a.slug && a.created_at >= since && !posted[a.id_str]);

// Same article can appear in several categories.
pool = [...new Map(pool.map((a) => [a.id_str, a])).values()];

if (flag("random")) {
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
} else {
    pool.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

if (pool.length < slots.length) {
    console.warn(`Only ${pool.length} unused articles with a tldr since ${since} — scheduling ${pool.length} of ${slots.length} slots.`);
}

const queue = pool.slice(0, slots.length).map((a, i) => ({
    id: a.id_str,
    at: slots[i]!,
    text: buildTweet(a),
}));
if (!queue.length) throw new Error("No unused articles with a tldr left");
const first = queue[0]!.at;
const last = queue[queue.length - 1]!.at;

// ── output ─────────────────────────────────────────────────────────────
for (const q of queue) console.log(`${q.at.replace("T", " ")}  ${q.text.split("\n")[0]!.slice(0, 70)}…`);
console.log(`\n${queue.length} posts, ${first.replace("T", " ")} → ${last.replace("T", " ")}`);

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
2. Cmd+Opt+J → paste → Enter (type "allow pasting" first if Chrome asks)
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
    await waitFor(() => box.textContent.replace(/\\s/g, "").length > 20, "text to appear");

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
    const btn = await waitFor(() => { const b = $('[role="dialog"] [data-testid="tweetButton"]'); return b && !b.disabled && b.getAttribute("aria-disabled") !== "true" && b; }, "Schedule button");
    btn.click();
    await waitFor(() => !modal(), "composer to close", 30000);
  }

  console.log("%celhellal → X: " + QUEUE.length + " posts (" + done.size + " already done)", "font-weight:bold");
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
