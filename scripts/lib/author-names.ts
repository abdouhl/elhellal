/**
 * Shared helper for scraping a Substack author's real publication name (from
 * their RSS feed's <channel><title>) and caching it in src/data/author-names.json,
 * keyed by screen_name. Used by both fetch-author-names.ts (standalone backfill)
 * and import-substack2.ts (scraped automatically as new authors are imported).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const AUTHOR_NAMES_PATH = path.join(__dirname, '../../src/data/author-names.json');

const TIMEOUT_MS = 8000;
const USER_AGENT = 'Mozilla/5.0 (compatible; elhellal/1.0)';

function getTag(xml: string, tag: string): string {
    const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    if (!m) return '';
    return m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

/** Pulls the channel-level <title> (the publication name), not an <item>'s. */
function extractChannelTitle(xml: string): string {
    const channel = xml.match(/<channel>([\s\S]*?)<item>/i)?.[1] ?? xml;
    return getTag(channel, 'title');
}

/** Fetches one author's real publication name from their Substack RSS feed. Returns null on any failure. */
export async function fetchAuthorName(screenName: string): Promise<string | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(`https://${screenName}.substack.com/feed`, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const xml = await res.text();
        return extractChannelTitle(xml) || null;
    } catch {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

export function loadAuthorNames(): Record<string, string> {
    if (!fs.existsSync(AUTHOR_NAMES_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(AUTHOR_NAMES_PATH, 'utf-8'));
    } catch {
        return {};
    }
}

export function saveAuthorNames(map: Record<string, string>) {
    fs.writeFileSync(AUTHOR_NAMES_PATH, JSON.stringify(map, null, 2));
}
