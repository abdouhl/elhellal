/**
 * FNV-1a over UTF-16 code units. Pure and deterministic across bun, workerd
 * and browsers — the build, the site Worker and client code all use it to
 * agree on which static shard a key lives in.
 */
export function fnv1a(text: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
