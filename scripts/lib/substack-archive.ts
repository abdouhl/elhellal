/**
 * Pages through a Substack publication's /api/v1/archive, newest first.
 *
 * Substack switched this endpoint to cursor pagination: `offset` is now rejected
 * with 400 ("param offset: Invalid value") and the response is
 * `{ posts, nextCursor }` instead of a bare array. A publication still answering
 * with an array is paged the old way, by offset.
 */

export interface ArchivePageOptions {
    limit?: number;
    headers?: Record<string, string>;
    timeoutMs?: number;
    /** Retries for a 429 before giving up (each waits 30s) */
    rateLimitRetries?: number;
}

export async function* archivePages<T = any>(
    base: string,
    { limit = 12, headers, timeoutMs = 15000, rateLimitRetries = 3 }: ArchivePageOptions = {},
): AsyncGenerator<T[]> {
    let cursor: string | undefined;
    let offset: number | undefined; // set once a publication turns out to serve the legacy shape
    let retries = rateLimitRetries;

    while (true) {
        const params = new URLSearchParams({ sort: 'new', limit: String(limit) });
        if (cursor) params.set('cursor', cursor);
        else if (offset) params.set('offset', String(offset));
        const url = `${base}/api/v1/archive?${params}`;

        let res: Response;
        try {
            res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        } catch (e: any) {
            throw new Error(`archive fetch failed (${cursor ? 'cursor page' : `offset ${offset ?? 0}`}): ${e.message}`);
        }
        if (res.status === 429 && retries-- > 0) {
            console.log('   ⏳ archive rate limited, waiting 30s');
            await new Promise((r) => setTimeout(r, 30_000));
            continue;
        }
        if (!res.ok) throw new Error(`archive ${res.status} ${res.statusText}`);
        retries = rateLimitRetries;

        const body = (await res.json()) as T[] | { posts?: T[]; nextCursor?: string | null };
        if (Array.isArray(body)) {
            if (body.length === 0) return;
            yield body;
            offset = (offset ?? 0) + body.length;
        } else {
            const posts = body.posts ?? [];
            if (posts.length) yield posts;
            if (!posts.length || !body.nextCursor || body.nextCursor === cursor) return;
            cursor = body.nextCursor;
        }
    }
}
