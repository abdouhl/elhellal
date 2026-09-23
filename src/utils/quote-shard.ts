/**
 * Deterministic djb2 hash bucketing shared between scripts/generate-quote-indices.ts
 * (which writes the shards) and the SSR quote routes (which read them). Must
 * stay in sync with the build script — same hash, same SHARD_COUNT — or a
 * request would look up the wrong shard and always miss.
 */
export const SHARD_COUNT = 64;

export function shardOf(key: string): string {
    let hash = 5381;
    for (let i = 0; i < key.length; i++) {
        hash = ((hash << 5) + hash + key.charCodeAt(i)) >>> 0;
    }
    return (hash % SHARD_COUNT).toString(16).padStart(2, '0');
}
