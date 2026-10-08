#!/usr/bin/env bun
/**
 * Discover new Arabic Substack publications from Google Trends.
 *
 * 1. Pulls the trending searches RSS for each Arab country
 *    (https://trends.google.com/trending/rss?geo=XX) and keeps Arabic keywords.
 * 2. Searches Substack posts for each keyword (the same API behind
 *    https://substack.com/search/<kw>?searching=all_posts).
 * 3. Keeps Arabic posts, groups them by publication subdomain, drops authors
 *    already in the catalog (and ones reported on previous runs), and ranks
 *    the rest.
 *
 * Output goes to .substack-discovery/ (gitignored):
 *   latest.json            full results of the last run
 *   runs/<timestamp>.json  archive of every run
 *   seen.json              subdomains already reported (skipped next time)
 *
 * Usage:
 *   bun run discover-substack
 *   bun run discover-substack --geo SA,EG --pages 3 --days 30
 *   bun run discover-substack --all          # include seen/known publications
 *   bun run discover-substack --dry-run      # don't update seen.json
 *
 * Flags:
 *   --geo XX,YY   countries to scan (default: all Arab countries)
 *   --pages N     Substack result pages per keyword, 20 posts each (default 2)
 *   --days N      only keep posts newer than N days (default 0 = any age)
 *   --delay MS    pause between requests (default 1200)
 *   --top N       rows to print in the table (default 30)
 *   --all         don't filter out known or previously-seen publications
 *   --dry-run     don't write seen.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ArticlesConfig } from '../src/types/index.ts';
import { readArticles } from '../src/lib/articles-store.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ───────────────────────────────────────────────────────────────────

const OUT_DIR       = path.join(__dirname, '../.substack-discovery');
const SEEN_PATH     = path.join(OUT_DIR, 'seen.json');
const UA            = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const ARAB_GEOS = [
    'SA', 'EG', 'AE', 'KW', 'QA', 'BH', 'OM', 'JO', 'LB',
    'IQ', 'SY', 'PS', 'MA', 'DZ', 'TN', 'LY', 'SD', 'YE',
];

// ─── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt  = (name: string, def: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const GEOS     = opt('geo', ARAB_GEOS.join(',')).split(',').map(g => g.trim().toUpperCase()).filter(Boolean);
const PAGES    = Number(opt('pages', '2'));
const MAX_DAYS = Number(opt('days', '0'));
const DELAY_MS = Number(opt('delay', '1200'));
const TOP      = Number(opt('top', '30'));
const SHOW_ALL = flag('all');
const DRY_RUN  = flag('dry-run');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿ]/g;
const LETTER_RE = /\p{L}/gu;

/** True when most letters in the text are Arabic. */
function isArabic(text: string | null | undefined, minRatio = 0.5): boolean {
    if (!text) return false;
    const letters = text.match(LETTER_RE)?.length ?? 0;
    if (!letters) return false;
    const arabic = text.match(ARABIC_RE)?.length ?? 0;
    return arabic / letters >= minRatio;
}

function decodeEntities(s: string): string {
    return s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&amp;/g, '&')
        .trim();
}

async function fetchWithRetry(url: string, tries = 4): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
        const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8' } });
        if (res.ok) return res;
        if (attempt >= tries || (res.status !== 429 && res.status < 500)) {
            throw new Error(`${res.status} ${res.statusText} — ${url}`);
        }
        const wait = DELAY_MS * 2 ** attempt;
        console.warn(`   ⏳ ${res.status}, retrying in ${Math.round(wait / 1000)}s…`);
        await sleep(wait);
    }
}

// ─── Google Trends ────────────────────────────────────────────────────────────

interface TrendKeyword {
    keyword: string;
    geos: string[];
    traffic: number;          // sum of approx_traffic across countries
    news: string[];           // related news headlines
}

function parseTraffic(s: string): number {
    const n = parseInt(s.replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
}

async function fetchTrends(geo: string): Promise<{ keyword: string; traffic: number; news: string[] }[]> {
    const res = await fetchWithRetry(`https://trends.google.com/trending/rss?geo=${geo}`);
    const xml = await res.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    return items.map(item => {
        const tag = (name: string) => item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? '';
        const news = [...item.matchAll(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/g)].map(m => decodeEntities(m[1]));
        return {
            keyword: decodeEntities(tag('title')),
            traffic: parseTraffic(tag('ht:approx_traffic')),
            news,
        };
    });
}

async function collectKeywords(): Promise<TrendKeyword[]> {
    const map = new Map<string, TrendKeyword>();
    for (const geo of GEOS) {
        try {
            const trends = await fetchTrends(geo);
            const arabic = trends.filter(t => isArabic(t.keyword));
            console.log(`   ${geo}: ${trends.length} trends, ${arabic.length} Arabic`);
            for (const t of arabic) {
                const key = t.keyword.replace(/\s+/g, ' ').trim();
                const existing = map.get(key);
                if (existing) {
                    if (!existing.geos.includes(geo)) existing.geos.push(geo);
                    existing.traffic += t.traffic;
                    for (const n of t.news) if (!existing.news.includes(n)) existing.news.push(n);
                } else {
                    map.set(key, { keyword: key, geos: [geo], traffic: t.traffic, news: t.news });
                }
            }
        } catch (err) {
            console.warn(`   ${geo}: ⚠️  ${(err as Error).message}`);
        }
        await sleep(300);
    }
    return [...map.values()].sort((a, b) => b.geos.length - a.geos.length || b.traffic - a.traffic);
}

// ─── Substack search ──────────────────────────────────────────────────────────

interface SubstackPost {
    id: number;
    title: string;
    subtitle?: string;
    description?: string;
    canonical_url: string;
    post_date: string;
    publication_id: number;
    reaction_count?: number;
    comment_count?: number;
    publishedBylines?: { name?: string; handle?: string }[];
}

interface SubstackPublication {
    id: number;
    subdomain: string;
    name?: string;
    custom_domain?: string | null;
}

interface SearchPage {
    results: SubstackPost[];
    publications: SubstackPublication[];
    more: boolean;
}

async function searchSubstack(query: string, page: number): Promise<SearchPage> {
    const url = `https://substack.com/api/v1/post/search?query=${encodeURIComponent(query)}&page=${page}&includePlatformResults=true&filter=all`;
    const res = await fetchWithRetry(url);
    const data = await res.json() as Partial<SearchPage>;
    return { results: data.results ?? [], publications: data.publications ?? [], more: !!data.more };
}

/** Best-effort subdomain for a post: publication list first, then the URL host. */
function subdomainFor(post: SubstackPost, pubs: Map<number, SubstackPublication>): string | null {
    const pub = pubs.get(post.publication_id);
    if (pub?.subdomain) return pub.subdomain.toLowerCase();
    try {
        const host = new URL(post.canonical_url).hostname;
        const m = host.match(/^([^.]+)\.substack\.com$/);
        return m ? m[1].toLowerCase() : null;
    } catch {
        return null;
    }
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

interface Discovered {
    subdomain: string;
    url: string;
    name: string;
    custom_domain: string | null;
    author: string;
    publication_id: number;
    matches: number;
    keywords: string[];
    geos: string[];
    total_reactions: number;
    latest_post: string;
    score: number;
    posts: { title: string; url: string; date: string; reactions: number; keyword: string }[];
}

function score(d: Discovered): number {
    const ageDays = (Date.now() - new Date(d.latest_post).getTime()) / 86_400_000;
    const recency = ageDays <= 7 ? 3 : ageDays <= 30 ? 2 : ageDays <= 180 ? 1 : 0;
    return Math.round(
        (d.matches * 2 + d.keywords.length * 5 + Math.log2(d.total_reactions + 1) * 2 + recency * 2) * 10,
    ) / 10;
}

function loadKnownScreenNames(): Set<string> {
    const config = readArticles();
    const names = new Set<string>();
    for (const cat of config.articles) for (const a of cat.content) {
        if (a.screen_name) names.add(a.screen_name.toLowerCase());
    }
    return names;
}

function loadSeen(): Record<string, string> {
    try { return JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8')); } catch { return {}; }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log(`\n📈 Fetching Google Trends for ${GEOS.length} countries…`);
    const keywords = await collectKeywords();
    console.log(`\n🔑 ${keywords.length} unique Arabic keywords`);
    if (!keywords.length) return;
    console.log('   ' + keywords.map(k => `${k.keyword} (${k.geos.join('/')})`).join(' · '));

    const known = loadKnownScreenNames();
    const seen  = loadSeen();
    const cutoff = MAX_DAYS > 0 ? Date.now() - MAX_DAYS * 86_400_000 : 0;
    const found = new Map<string, Discovered>();
    const seenPostIds = new Set<number>();
    let skippedKnown = 0;

    console.log(`\n🔍 Searching Substack (${PAGES} page(s) per keyword)…`);
    for (const [i, kw] of keywords.entries()) {
        let kept = 0;
        for (let page = 0; page < PAGES; page++) {
            let res: SearchPage;
            try {
                res = await searchSubstack(kw.keyword, page);
            } catch (err) {
                console.warn(`   ⚠️  "${kw.keyword}" p${page}: ${(err as Error).message}`);
                break;
            }
            const pubs = new Map(res.publications.map(p => [p.id, p]));

            for (const post of res.results) {
                if (seenPostIds.has(post.id)) continue;
                seenPostIds.add(post.id);
                if (!isArabic(`${post.title ?? ''} ${post.subtitle ?? ''}`)) continue;
                if (cutoff && new Date(post.post_date).getTime() < cutoff) continue;

                const sub = subdomainFor(post, pubs);
                if (!sub) continue;
                if (!SHOW_ALL && (known.has(sub) || seen[sub])) { skippedKnown++; continue; }

                const pub = pubs.get(post.publication_id);
                const reactions = post.reaction_count ?? 0;
                let d = found.get(sub);
                if (!d) {
                    d = {
                        subdomain: sub,
                        url: `https://${sub}.substack.com`,
                        name: pub?.name ?? '',
                        custom_domain: pub?.custom_domain ?? null,
                        author: post.publishedBylines?.[0]?.name ?? '',
                        publication_id: post.publication_id,
                        matches: 0, keywords: [], geos: [], total_reactions: 0,
                        latest_post: post.post_date, score: 0, posts: [],
                    };
                    found.set(sub, d);
                }
                d.matches++;
                d.total_reactions += reactions;
                if (!d.keywords.includes(kw.keyword)) d.keywords.push(kw.keyword);
                for (const g of kw.geos) if (!d.geos.includes(g)) d.geos.push(g);
                if (post.post_date > d.latest_post) d.latest_post = post.post_date;
                d.posts.push({ title: post.title, url: post.canonical_url, date: post.post_date.slice(0, 10), reactions, keyword: kw.keyword });
                kept++;
            }

            await sleep(DELAY_MS);
            if (!res.more) break;
        }
        console.log(`   [${i + 1}/${keywords.length}] ${kw.keyword} → ${kept} new Arabic post(s)`);
    }

    const results = [...found.values()]
        .map(d => ({ ...d, score: score(d), posts: d.posts.sort((a, b) => b.date.localeCompare(a.date)) }))
        .sort((a, b) => b.score - a.score);

    // ── Write output ──
    fs.mkdirSync(path.join(OUT_DIR, 'runs'), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const payload = {
        generated_at: new Date().toISOString(),
        options: { geos: GEOS, pages: PAGES, days: MAX_DAYS, all: SHOW_ALL },
        keywords,
        skipped_known_or_seen: skippedKnown,
        publications: results,
    };
    const json = JSON.stringify(payload, null, 2);
    fs.writeFileSync(path.join(OUT_DIR, 'latest.json'), json);
    fs.writeFileSync(path.join(OUT_DIR, 'runs', `${stamp}.json`), json);

    if (!DRY_RUN && !SHOW_ALL) {
        const today = new Date().toISOString().slice(0, 10);
        for (const d of results) seen[d.subdomain] ??= today;
        fs.writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 2));
    }

    // ── Report ──
    console.log(`\n✨ ${results.length} new publication(s)  (skipped ${skippedKnown} post(s) from known/seen authors)\n`);
    if (results.length) {
        console.table(results.slice(0, TOP).map(d => ({
            subdomain: d.subdomain,
            name: d.name.slice(0, 30),
            score: d.score,
            posts: d.matches,
            likes: d.total_reactions,
            latest: d.latest_post.slice(0, 10),
            keywords: d.keywords.slice(0, 3).join('، '),
        })));
        console.log(`\n💾 Saved to .substack-discovery/latest.json`);
        console.log(`\n➡️  Import them with:\n   bun run scripts/import-substack2.ts ${results.slice(0, TOP).map(d => d.subdomain).join(' ')}\n`);
    }
}

main().catch(err => {
    console.error('❌', err);
    process.exit(1);
});
