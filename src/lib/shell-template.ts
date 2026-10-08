/**
 * Tiny template language for "shell" pages: Astro prerenders a page once with
 * placeholder tokens instead of real data, and the site Worker
 * (workers/site/) fills it per request. Keeping the markup in the .astro
 * file means one template serves both static and Worker-rendered pages.
 *
 *   {{name}}        HTML-escaped value
 *   {{jt:name}}     JSON-string-escaped, then HTML-escaped (for values inside
 *                   an island's serialized props attribute)
 *   {{{name}}}      raw value (pre-built, already-safe HTML/JSON)
 *   <!--#if name--> … <!--/if name-->        kept when name is truthy
 *   <!--#if !name--> … <!--/if !name-->      kept when name is falsy
 *   <!--#each name--> … <!--/each name-->    repeated per item of an array
 *
 * Inside an #each, `.field` refers to the current item ({{.title}},
 * <!--#if .href-->). Blocks of the same name can't nest inside each other.
 *
 * Pure string code with no dependencies: it runs in both Node (build) and
 * workerd (Worker).
 */

export type TemplateData = Record<string, unknown>;

const ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

/** Same character set Astro escapes, so filled output matches prerendered output. */
export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

function lookup(name: string, root: TemplateData, item: TemplateData | undefined): unknown {
    if (name.startsWith('.')) return item?.[name.slice(1)];
    return root[name];
}

function truthy(value: unknown): boolean {
    return Array.isArray(value) ? value.length > 0 : !!value;
}

function toText(value: unknown): string {
    return value === undefined || value === null || value === false ? '' : String(value);
}

const EACH_RE = /<!--#each (\S+?)-->([\s\S]*?)<!--\/each \1-->/g;
const IF_RE = /<!--#if (!?)(\S+?)-->([\s\S]*?)<!--\/if \1\2-->/g;
const TOKEN_RE = /\{\{\{([^{}]+)\}\}\}|\{\{(jt:)?([^{}]+)\}\}/g;

function resolveIfs(template: string, root: TemplateData, item: TemplateData | undefined, itemScope: boolean): string {
    return template.replace(IF_RE, (match, not: string, name: string, inner: string) => {
        // Item-scoped blocks resolve during #each; root ones afterwards.
        if (name.startsWith('.') !== itemScope) return match;
        const keep = truthy(lookup(name, root, item)) !== (not === '!');
        return keep ? resolveIfs(inner, root, item, itemScope) : '';
    });
}

function substitute(template: string, root: TemplateData, item: TemplateData | undefined, itemScope: boolean): string {
    return template.replace(TOKEN_RE, (match, raw: string | undefined, jt: string | undefined, name: string | undefined) => {
        const key = (raw ?? name)!;
        if (key.startsWith('.') !== itemScope) return match;
        const value = toText(lookup(key, root, item));
        if (raw !== undefined) return value;
        const html = escapeHtml(jt ? JSON.stringify(value).slice(1, -1) : value);
        // Item values are re-scanned by the root passes; entity-encode braces
        // so text that happens to contain "{{x}}" is never read as a token.
        return itemScope ? html.replace(/[{}]/g, (c) => (c === '{' ? '&#123;' : '&#125;')) : html;
    });
}

export function fillTemplate(template: string, data: TemplateData): string {
    const expanded = template.replace(EACH_RE, (_, name: string, inner: string) => {
        const list = data[name];
        if (!Array.isArray(list)) return '';
        return list
            .map((entry) => substitute(resolveIfs(inner, data, entry, true), data, entry, true))
            .join('');
    });
    // Root values are inserted in one final pass, so they're never re-scanned.
    return substitute(resolveIfs(expanded, data, undefined, false), data, undefined, false);
}

/** Builds the marker comments; returns '' when not rendering a shell. */
export function shellMarkers(isShell: boolean) {
    return {
        open: (cond: string) => (isShell ? `<!--#if ${cond}-->` : ''),
        close: (cond: string) => (isShell ? `<!--/if ${cond}-->` : ''),
        eachOpen: (name: string) => (isShell ? `<!--#each ${name}-->` : ''),
        eachClose: (name: string) => (isShell ? `<!--/each ${name}-->` : ''),
    };
}
