// Reader-written articles (src/content/community/, from /write/ via the
// admin panel's Submissions queue). Shared by the article page and the feed.
import fs from 'node:fs';
import path from 'node:path';

let titles: Map<string, string> | undefined;

/** Display title of a catalog category (catalog/categories.json is small; read, not imported). */
export function categoryTitle(category: string): string {
    titles ??= new Map(
        (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src/data/catalog/categories.json'), 'utf8')) as Array<{ category: string; title: string }>).map(
            (c) => [c.category, c.title]
        )
    );
    return titles.get(category) ?? category;
}

export const COMMUNITY_TAGLINE = 'مقال من قرّاء الهلال';
export const COMMUNITY_ACCENT = '#64748b';
