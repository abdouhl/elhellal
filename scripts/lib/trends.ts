// Trending keywords for the admin panel's Personas tab:
//  - catalogTrends(): article keywords rising on Arabic Substack (the catalog itself), last
//    `days` vs the `baseline` days before, counted once per author so one prolific writer
//    can't make a trend on their own.
//  - googleTrends(): Google's daily search trends (public RSS, no key) for Arab countries.
//  - matchPersona(): which house persona a trend fits best (category + topic overlap).
import type { Category } from '../../src/types/index.ts';
import type { PersonalBlogPerson } from '../../src/data/personal-blogs.ts';

export interface CatalogTrend {
    keyword: string;
    /** Distinct authors using it in the recent window / in the baseline window. */
    recent: number;
    before: number;
    /** Articles in the recent window. */
    articles: number;
    score: number;
    categories: { category: string; n: number }[];
    titles: string[];
}

export interface GoogleTrend {
    term: string;
    traffic: number;
    geos: string[];
    news: { title: string; url: string; source: string }[];
}

export const TREND_GEOS = ['SA', 'EG', 'AE', 'MA', 'DZ', 'IQ'] as const;

/** Comparable form: no tashkeel/tatweel, one alef/yaa/haa form, lower-case Latin, tidy spaces. */
export function normalizeKeyword(s: string): string {
    return s
        .replace(/[ً-ْٰـ]/g, '')
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة(?=\s|$)/g, 'ه')
        .replace(/[«»"'()[\]]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

export function catalogTrends(categories: Category[], { days = 14, baseline = 90, limit = 60, minAuthors = 3 } = {}): CatalogTrend[] {
    const recentFrom = isoDaysAgo(days - 1);
    const baseFrom = isoDaysAgo(days + baseline - 1);
    interface Acc { forms: Map<string, number>; recent: Set<string>; before: Set<string>; articles: number; cats: Map<string, number>; titles: string[] }
    const acc = new Map<string, Acc>();
    for (const cat of categories) {
        for (const a of cat.content) {
            const date = a.created_at ?? '';
            if (date < baseFrom || !a.keywords?.length) continue;
            const isRecent = date >= recentFrom;
            for (const raw of new Set(a.keywords)) {
                const form = raw.replace(/\s+/g, ' ').trim();
                const key = normalizeKeyword(form);
                if (key.length < 3 || key.length > 40) continue;
                let e = acc.get(key);
                if (!e) acc.set(key, (e = { forms: new Map(), recent: new Set(), before: new Set(), articles: 0, cats: new Map(), titles: [] }));
                e.forms.set(form, (e.forms.get(form) ?? 0) + 1);
                if (isRecent) {
                    e.recent.add(a.screen_name);
                    e.articles++;
                    e.cats.set(cat.category, (e.cats.get(cat.category) ?? 0) + 1);
                    if (e.titles.length < 4) e.titles.push(a.title);
                } else e.before.add(a.screen_name);
            }
        }
    }
    const out: CatalogTrend[] = [];
    for (const e of acc.values()) {
        const recent = e.recent.size;
        if (recent < minAuthors) continue;
        const before = e.before.size;
        // Growth over the expected rate (baseline scaled to the window), damped by size.
        const expected = (before * days) / baseline;
        const score = ((recent + 1) / (expected + 1)) * Math.log2(recent + 1);
        if (recent <= expected * 1.2) continue;
        out.push({
            keyword: [...e.forms.entries()].sort((a, b) => b[1] - a[1])[0]![0],
            recent,
            before,
            articles: e.articles,
            score: Math.round(score * 100) / 100,
            categories: [...e.cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([category, n]) => ({ category, n })),
            titles: e.titles,
        });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

const decode = (s: string) =>
    s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim();
const tag = (xml: string, name: string) => decode(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? '');

async function googleGeo(geo: string): Promise<(GoogleTrend & { geo: string })[]> {
    const res = await fetch(`https://trends.google.com/trending/rss?geo=${geo}`, {
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)' },
        signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`Google Trends ${geo}: HTTP ${res.status}`);
    const xml = await res.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => ({
        geo,
        geos: [geo],
        term: tag(item!, 'title'),
        traffic: Number(tag(item!, 'ht:approx_traffic').replace(/[^\d]/g, '')) || 0,
        news: [...item!.matchAll(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/g)].slice(0, 3).map(([, n]) => ({
            title: tag(n!, 'ht:news_item_title'),
            url: tag(n!, 'ht:news_item_url'),
            source: tag(n!, 'ht:news_item_source'),
        })),
    }));
}

/** Today's search trends across `geos`, merged by term (traffic summed). Failed countries are skipped. */
export async function googleTrends(geos: readonly string[] = TREND_GEOS): Promise<{ trends: GoogleTrend[]; errors: string[] }> {
    const settled = await Promise.allSettled(geos.map(googleGeo));
    const errors: string[] = [];
    const merged = new Map<string, GoogleTrend>();
    for (const r of settled) {
        if (r.status === 'rejected') {
            errors.push(String(r.reason?.message ?? r.reason));
            continue;
        }
        for (const t of r.value) {
            if (!t.term) continue;
            const key = normalizeKeyword(t.term);
            const e = merged.get(key);
            if (!e) merged.set(key, { term: t.term, traffic: t.traffic, geos: [t.geo], news: t.news });
            else {
                e.traffic += t.traffic;
                if (!e.geos.includes(t.geo)) e.geos.push(t.geo);
                if (e.news.length < 3) e.news.push(...t.news.slice(0, 3 - e.news.length));
            }
        }
    }
    return { trends: [...merged.values()].sort((a, b) => b.traffic - a.traffic), errors };
}

/** Words too generic to tie a trend to a persona on their own (normalized, without "ال"). */
const STOP = new Set(['عامه', 'عام', 'عربي', 'عربيه', 'عالم', 'جديد', 'جديده', 'يوم', 'دول', 'دوله', 'كبير', 'اول', 'حول', 'بين', 'مستقبل', 'وزاره', 'قرار', 'the', 'and', 'for']);

/** Word stems for overlap: Arabic words lose a leading "ال"/"وال"/"بال"…, short and generic words are dropped. */
function stems(text: string): Set<string> {
    return new Set(
        normalizeKeyword(text)
            .split(/[^\p{L}\p{N}]+/u)
            .map((w) => w.replace(/^(?:وال|بال|فال|كال|لل|ال)(?=\p{L}{3})/u, ''))
            .filter((w) => w.length >= 3 && !STOP.has(w))
    );
}

/** Best-fitting active persona for a trend, or null when nothing fits. */
export function matchPersona(
    text: string,
    categories: string[],
    personas: PersonalBlogPerson[]
): { slug: string; score: number } | null {
    const words = stems(text);
    let best: { slug: string; score: number } | null = null;
    for (const p of personas) {
        if (p.active === false) continue;
        let score = categories[0] === p.category ? 3 : categories.includes(p.category) ? 2 : 0;
        const vocab = stems([p.tagline, ...(p.topics ?? [])].join(' '));
        for (const w of words) if (vocab.has(w)) score += 2;
        if (score > 0 && (!best || score > best.score)) best = { slug: p.slug, score };
    }
    return best;
}
