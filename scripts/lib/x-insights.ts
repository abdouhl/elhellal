/**
 * What works on X, as weights the scheduler can use.
 * `bun run x-stats --report` writes .x-schedule/insights.json from the scraped stats + log.json;
 * `bun run x-schedule` reads it to give more slots to the categories, quiz types, styles and
 * hours that did well, and to bring back past winners.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const X_DIR = join(import.meta.dir, '../../.x-schedule');
export const INSIGHTS_FILE = join(X_DIR, 'insights.json');

export type Group = { n: number; med: number; factor: number };
export interface Insights {
    updated: string;
    posts: number;
    baseline: number;
    groups: Record<'kind' | 'category' | 'quizType' | 'style' | 'hour', Record<string, Group>>;
    /** log ids of article posts in the top fifth by score, with when they went out */
    winners: { id: string; at: string; score: number }[];
}

export type ScoredRow = { id?: string; at?: string; kind: string; category?: string; style?: string; hour: number; score: number };

const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0;
};

/** One post's worth: views, plus site clicks and replies weighted as what we actually want. */
export const postScore = (p: { views: number; replies: number; reposts: number; bookmarks: number; clicks?: number }) =>
    p.views + 40 * (p.clicks ?? 0) + 8 * p.replies + 6 * p.reposts + 4 * p.bookmarks;

// Few posts say little: pull each group's ratio toward 1 by K pseudo-posts, and keep it within [0.5, 2].
const K = 3;

export function computeInsights(rows: ScoredRow[]): Insights {
    const baseline = median(rows.map((r) => r.score)) || 1;
    const by = (key: (r: ScoredRow) => string | undefined) => {
        const groups = new Map<string, number[]>();
        for (const r of rows) {
            const k = key(r);
            if (k) groups.set(k, [...(groups.get(k) ?? []), r.score]);
        }
        return Object.fromEntries(
            [...groups].map(([k, xs]) => {
                const med = median(xs);
                const factor = Math.min(2, Math.max(0.5, (xs.length * (med / baseline) + K) / (xs.length + K)));
                return [k, { n: xs.length, med: Math.round(med), factor: Number(factor.toFixed(3)) }];
            }),
        );
    };
    const articles = rows.filter((r) => r.kind === 'article' && r.id && r.at);
    const cut = [...articles].map((r) => r.score).sort((a, b) => b - a)[Math.floor(articles.length / 5)] ?? Infinity;
    return {
        updated: new Date().toISOString(),
        posts: rows.length,
        baseline: Math.round(baseline),
        groups: {
            kind: by((r) => r.kind),
            category: by((r) => (r.kind === 'article' ? r.category : undefined)),
            quizType: by((r) => (r.kind === 'quiz' ? r.category : undefined)),
            style: by((r) => r.style),
            hour: by((r) => String(r.hour).padStart(2, '0')),
        },
        winners: articles.filter((r) => r.score >= cut && r.score > baseline).map((r) => ({ id: r.id!, at: r.at!, score: Math.round(r.score) })),
    };
}

export function saveInsights(i: Insights) {
    writeFileSync(INSIGHTS_FILE, JSON.stringify(i, null, 2));
}

export function loadInsights(): Insights | null {
    if (!existsSync(INSIGHTS_FILE)) return null;
    try {
        return JSON.parse(readFileSync(INSIGHTS_FILE, 'utf8'));
    } catch {
        return null;
    }
}

/** factor(group, key) → the learned multiplier, 1 when there's no data. */
export function factorOf(i: Insights | null) {
    return (group: keyof Insights['groups'], key: string | undefined) => (key && i?.groups[group]?.[key]?.factor) || 1;
}
