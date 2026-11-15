/**
 * Reads the frontmatter of every article written on elhellal straight from
 * src/content/ (no astro:content), for scripts: admin stats and check-data.
 * Pages use src/utils/personalBlogFeed.ts instead. Node-only.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Origin } from './native';

export interface NativePost {
    slug: string;
    collection: string;
    origin: Origin;
    title: string;
    pubDate: string;
    category?: string | undefined;
    author?: string | undefined;
    persona?: string | undefined;
}

/** Content collection → origin. Personal blogs are anything else under src/content. */
const ORIGIN_BY_COLLECTION: Record<string, Origin> = { community: 'write', house: 'persona' };

/** Flat `key: value` frontmatter (strings, quoted or not) of a markdown file. */
export function frontmatter(text: string): Record<string, string> {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const out: Record<string, string> = {};
    if (!m) return out;
    for (const line of m[1]!.split(/\r?\n/)) {
        const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
        if (!kv) continue;
        let value = kv[2]!.trim();
        if (/^(["']).*\1$/.test(value)) {
            try {
                value = value.startsWith('"') ? JSON.parse(value) : value.slice(1, -1).replace(/''/g, "'");
            } catch {
                value = value.slice(1, -1);
            }
        }
        out[kv[1]!] = value;
    }
    return out;
}

export function readNativePosts(root: string = process.cwd()): NativePost[] {
    const dir = path.join(root, 'src', 'content');
    const posts: NativePost[] = [];
    for (const collection of fs.readdirSync(dir)) {
        const cdir = path.join(dir, collection);
        if (!fs.statSync(cdir).isDirectory()) continue;
        const origin = ORIGIN_BY_COLLECTION[collection] ?? 'personal';
        for (const file of fs.readdirSync(cdir)) {
            if (!/\.mdx?$/.test(file)) continue;
            const fm = frontmatter(fs.readFileSync(path.join(cdir, file), 'utf8'));
            posts.push({
                slug: file.replace(/\.mdx?$/, ''),
                collection,
                origin,
                title: fm.title ?? '',
                pubDate: (fm.pubDate ?? '').slice(0, 10),
                category: fm.category,
                author: fm.author,
                persona: fm.persona,
            });
        }
    }
    return posts;
}
