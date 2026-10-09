/**
 * Content moderation state, shared by scripts/moderate-articles.ts and the
 * importers. Everything lives in src/data/moderation/ and is committed:
 *
 *   verdicts.json    { [id_str]: Verdict } — the model's classification of
 *                    every article it has seen, so re-runs only classify new ones
 *   overrides.json   { [id_str]: "keep" | "remove" } — your manual decisions;
 *                    they win over the model's verdict
 *   blocklist.json   { articles: BlockedArticle[], authors: string[] } — what
 *                    has been removed; importers skip these so they never come back
 */

import fs from 'node:fs';
import path from 'node:path';

export const MODERATION_DIR = path.join(process.cwd(), 'src/data/moderation');

export const REASONS = [
    'israel_propaganda',
    'hate_speech',
    'anti_islam',
    'sexual',
    'vice_promotion',
] as const;
export type Reason = (typeof REASONS)[number];

export type Decision = 'keep' | 'review' | 'remove';

export interface Verdict {
    decision: Decision;
    reasons: Reason[];
    note: string;
    model: string;
    at: string;
}

export interface BlockedArticle {
    id_str: string;
    url?: string | undefined;
    title: string;
    screen_name: string;
    reasons: Reason[];
    /** Why it was removed by hand in the admin panel (scripts/admin.ts). */
    note?: string | undefined;
    removed_at: string;
}

export interface Blocklist {
    articles: BlockedArticle[];
    /** Substack usernames whose every article is removed and never re-imported. */
    authors: string[];
}

function file(name: string) {
    return path.join(MODERATION_DIR, name);
}

function readJson<T>(name: string, fallback: T): T {
    const p = file(name);
    return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf-8')) as T) : fallback;
}

function writeJson(name: string, value: unknown) {
    fs.mkdirSync(MODERATION_DIR, { recursive: true });
    fs.writeFileSync(file(name), `${JSON.stringify(value, null, 2)}\n`);
}

export const loadVerdicts = () => readJson<Record<string, Verdict>>('verdicts.json', {});
export const saveVerdicts = (v: Record<string, Verdict>) => writeJson('verdicts.json', v);

export const loadOverrides = () => readJson<Record<string, 'keep' | 'remove'>>('overrides.json', {});
export const saveOverrides = (o: Record<string, 'keep' | 'remove'>) => writeJson('overrides.json', o);

export const loadBlocklist = () => readJson<Blocklist>('blocklist.json', { articles: [], authors: [] });
export const saveBlocklist = (b: Blocklist) => writeJson('blocklist.json', b);

/** id_strs the importers must treat as already seen. */
export function blockedIds(): Set<string> {
    return new Set(loadBlocklist().articles.map((a) => a.id_str));
}

/** Substack usernames the importers must not fetch. */
export function blockedAuthors(): Set<string> {
    return new Set(loadBlocklist().authors);
}
