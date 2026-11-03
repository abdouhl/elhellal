#!/usr/bin/env bun
/**
 * X stats — which scheduled posts actually work
 * ---------------------------------------------
 *   bun run x-stats                 copies a snippet: open your X profile in Chrome,
 *                                   Cmd+Opt+J → paste. It scrolls back --days days,
 *                                   reads each post's replies/reposts/likes/bookmarks/views
 *                                   and downloads ~/Downloads/elhellal-x-stats.json
 *   bun run x-stats --days 60       how far back the snippet scrolls (default 30)
 *   bun run x-stats --report [file] joins that file (default: newest in ~/Downloads) with
 *                                   .x-schedule/log.json and prints views/engagement by
 *                                   kind, category and hour, plus the best and worst posts
 *
 * Posts are matched to what x-schedule queued by their time (±2 min); older posts
 * without a log entry still get their kind from the link (quiz / article / book).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const LOG_FILE = join(ROOT, ".x-schedule/log.json");
const DOWNLOADS = join(homedir(), "Downloads");
const argv = process.argv.slice(2);
const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
};

type Scraped = { url: string; time: string; text: string; photos: number; replies: number; reposts: number; likes: number; bookmarks: number; views: number };
type LogEntry = { at: string; kind: string; category?: string; author?: string; text: string };

if (!argv.includes("--report")) {
    const days = Number(opt("days") ?? 30);
    const snippet = scraperSnippet(days);
    const p = Bun.spawn(["pbcopy"], { stdin: "pipe" });
    p.stdin.write(snippet);
    p.stdin.end();
    const copied = (await p.exited) === 0;
    console.log(`Snippet${copied ? " copied to clipboard" : ""} (last ${days} days).
1. Open your profile on x.com in Chrome (the Posts tab)
2. Cmd+Opt+J → paste → Enter, keep the tab in front
3. When it downloads elhellal-x-stats.json: bun run x-stats --report`);
    if (!copied) console.log(`\n${snippet}`);
    process.exit(0);
}

// ── report ─────────────────────────────────────────────────────────────
const file =
    opt("report") ??
    readdirSync(DOWNLOADS)
        .filter((f) => f.startsWith("elhellal-x-stats") && f.endsWith(".json"))
        .map((f) => join(DOWNLOADS, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!file || !existsSync(file)) throw new Error("No elhellal-x-stats*.json in ~/Downloads — run `bun run x-stats` first (or pass --report <file>)");
const posts: Scraped[] = JSON.parse(readFileSync(file, "utf8"));
const log: Record<string, LogEntry> = existsSync(LOG_FILE) ? JSON.parse(readFileSync(LOG_FILE, "utf8")) : {};
const logged = Object.values(log).map((e) => ({ ...e, ms: new Date(`${e.at}:00`).getTime() }));

type Row = Scraped & { kind: string; category?: string; hour: number; eng: number };
const rows: Row[] = posts.map((p) => {
    const ms = new Date(p.time).getTime();
    const hit = logged.find((e) => Math.abs(e.ms - ms) < 2 * 60_000);
    const kind = hit?.kind ?? (p.text.includes("quiz.elhellal.com") ? "quiz" : p.text.includes("elhellal.com") ? "article" : p.photos ? "book" : "other");
    return { ...p, kind, category: hit?.category, hour: new Date(ms).getHours(), eng: p.replies + p.reposts + p.likes + p.bookmarks };
});
console.log(`${rows.length} posts from ${file.replace(homedir(), "~")} (${rows.filter((r) => r.category || r.kind !== "other").length} identified)\n`);

const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0;
};
function table(title: string, key: (r: Row) => string | undefined, min = 1) {
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
        const k = key(r);
        if (k !== undefined) groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const lines = [...groups]
        .filter(([, rs]) => rs.length >= min)
        .map(([k, rs]) => {
            const views = rs.reduce((n, r) => n + r.views, 0);
            const eng = rs.reduce((n, r) => n + r.eng, 0);
            return { k, n: rs.length, med: median(rs.map((r) => r.views)), avg: views / rs.length, rate: views ? (100 * eng) / views : 0, replies: rs.reduce((n, r) => n + r.replies, 0) / rs.length };
        })
        .sort((a, b) => b.med - a.med);
    console.log(`── ${title}`);
    console.log(`${"".padEnd(18)}${"posts".padStart(6)}${"med views".padStart(11)}${"avg views".padStart(11)}${"eng %".padStart(8)}${"replies".padStart(9)}`);
    for (const l of lines) {
        console.log(`${l.k.padEnd(18)}${String(l.n).padStart(6)}${l.med.toFixed(0).padStart(11)}${l.avg.toFixed(0).padStart(11)}${l.rate.toFixed(1).padStart(8)}${l.replies.toFixed(1).padStart(9)}`);
    }
    console.log();
}
table("by kind", (r) => r.kind);
table("articles by category (≥2 posts)", (r) => (r.kind === "article" ? r.category : undefined), 2);
table("quizzes by type", (r) => (r.kind === "quiz" ? r.category : undefined));
table("by hour (your clock)", (r) => `${String(r.hour).padStart(2, "0")}:00`);

const short = (r: Row) => `${String(r.views).padStart(6)} views ${String(r.eng).padStart(4)} eng  ${r.kind.padEnd(7)} ${r.text.replace(/\s+/g, " ").slice(0, 60)}  ${r.url}`;
const byViews = [...rows].sort((a, b) => b.views - a.views);
console.log("── best 5");
byViews.slice(0, 5).forEach((r) => console.log(short(r)));
console.log("\n── worst 5");
byViews.slice(-5).reverse().forEach((r) => console.log(short(r)));

// ── browser side ───────────────────────────────────────────────────────
function scraperSnippet(days: number): string {
    return `// elhellal → X stats: paste on your x.com profile (Posts tab)
(async () => {
  const cutoff = Date.now() - ${days} * 86400000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Counts come from each button's aria-label, which carries the full number in any UI language.
  const num = (el) => {
    const m = (el?.getAttribute("aria-label") || "").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).match(/\\d[\\d,.]*/);
    return m ? Number(m[0].replace(/[,.]/g, "")) : 0;
  };
  if (!/^\\/[A-Za-z0-9_]+\\/?$/.test(location.pathname)) console.warn("Open your profile page (x.com/<handle>) first — this looks like " + location.pathname);
  const seen = new Map();
  let idle = 0, oldest = Date.now();
  while (idle < 6 && oldest > cutoff && seen.size < 3000) {
    let added = 0;
    for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
      if (art.querySelector('[data-testid="socialContext"]')) continue; // pinned / reposts of others
      const time = art.querySelector("time");
      const link = time?.closest("a");
      if (!time || !link || seen.has(link.href)) continue;
      const q = (id) => art.querySelector('[data-testid="' + id + '"]');
      seen.set(link.href, {
        url: link.href.replace(/\\/analytics$/, ""),
        time: time.getAttribute("datetime"),
        text: [...art.querySelectorAll('[data-testid="tweetText"], [data-testid="card.wrapper"] a')].map((e) => e.innerText || e.href).join(" "),
        photos: art.querySelectorAll('[data-testid="tweetPhoto"]').length,
        replies: num(q("reply")), reposts: num(q("retweet") || q("unretweet")), likes: num(q("like") || q("unlike")),
        bookmarks: num(q("bookmark") || q("removeBookmark")),
        views: num(art.querySelector('a[href$="/analytics"]')),
      });
      oldest = Math.min(oldest, new Date(time.getAttribute("datetime")).getTime());
      added++;
    }
    idle = added ? 0 : idle + 1;
    console.log("…" + seen.size + " posts, back to " + new Date(oldest).toISOString().slice(0, 10));
    window.scrollBy(0, 1800);
    await sleep(1600);
  }
  const posts = [...seen.values()].filter((p) => new Date(p.time).getTime() >= cutoff);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(posts)], { type: "application/json" }));
  a.download = "elhellal-x-stats.json";
  a.click();
  console.log("%cdone — " + posts.length + " posts saved to Downloads/elhellal-x-stats.json. Now: bun run x-stats --report", "font-weight:bold;color:#1d9bf0");
})();
`;
}
