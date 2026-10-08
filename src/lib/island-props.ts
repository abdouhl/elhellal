/**
 * Astro's serialized island props (the `props` attribute of <astro-island>),
 * for islands the site Worker renders itself. Same format as Astro's
 * runtime/server/serialize.js for the JSON-ish values used here: every value
 * becomes [type, value] — 1 for arrays (items serialized in turn), 0 for
 * everything else (object values serialized in turn).
 *
 * Undefined properties are dropped, so the island gets `undefined` (not
 * `null`) for them, as with a prop that was never passed.
 *
 * Pure code: runs in bun and workerd.
 */

type Serialized = [0, unknown] | [1, Serialized[]];

function convert(value: unknown): Serialized {
    if (Array.isArray(value)) return [1, value.map(convert)];
    if (value !== null && typeof value === 'object') return [0, serializeObject(value as Record<string, unknown>)];
    return [0, value];
}

function serializeObject(value: Record<string, unknown>): Record<string, Serialized> {
    const result: Record<string, Serialized> = {};
    for (const [key, v] of Object.entries(value)) {
        if (v !== undefined) result[key] = convert(v);
    }
    return result;
}

/** The attribute's value before HTML escaping. */
export function serializeIslandProps(props: Record<string, unknown>): string {
    return JSON.stringify(serializeObject(props));
}
