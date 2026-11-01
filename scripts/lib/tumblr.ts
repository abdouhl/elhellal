/**
 * Tumblr API v2 client shared by scripts/tumblr-schedule.ts and the admin panel.
 *
 * Auth is OAuth2 (authorization code + refresh token). The app's keys live in
 * .env (TUMBLR_CLIENT_ID / TUMBLR_CLIENT_SECRET, from tumblr.com/oauth/apps);
 * the admin panel's "Connect Tumblr" button runs the login and saves the
 * tokens to .tumblr/token.json (gitignored), refreshed here when they expire.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
export const TUMBLR_DIR = join(ROOT, '.tumblr');
const TOKEN_FILE = join(TUMBLR_DIR, 'token.json');
const API = 'https://api.tumblr.com/v2';

export const BLOG = process.env.TUMBLR_BLOG || 'elhellal';
export const REDIRECT_URI = process.env.TUMBLR_REDIRECT_URI || 'http://localhost:4322/api/tumblr/callback';

export class TumblrError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
    /** Tumblr's daily post / photo-upload caps (HTTP 429, or 400 with a "limit" message). */
    get isRateLimit() {
        return this.status === 429 || /limit|exceeded/i.test(this.message);
    }
}

interface Token {
    access_token: string;
    refresh_token?: string;
    expires_at: number;
}

function creds() {
    const id = process.env.TUMBLR_CLIENT_ID;
    const secret = process.env.TUMBLR_CLIENT_SECRET;
    if (!id || !secret) throw new TumblrError('Set TUMBLR_CLIENT_ID and TUMBLR_CLIENT_SECRET in .env', 500);
    return { id, secret };
}

export function authorizeUrl(state: string): string {
    const q = new URLSearchParams({
        client_id: creds().id,
        response_type: 'code',
        scope: 'basic write offline_access',
        state,
        redirect_uri: REDIRECT_URI,
    });
    return `https://www.tumblr.com/oauth2/authorize?${q}`;
}

async function tokenRequest(params: Record<string, string>): Promise<Token> {
    const { id, secret } = creds();
    const res = await fetch(`${API}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...params, client_id: id, client_secret: secret }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
        throw new TumblrError(`Tumblr token request failed: ${body.error_description || body.error || res.status}`, res.status);
    }
    const token: Token = {
        access_token: body.access_token,
        refresh_token: body.refresh_token ?? params.refresh_token,
        expires_at: Date.now() + (Number(body.expires_in) || 2520) * 1000,
    };
    mkdirSync(TUMBLR_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 });
    return token;
}

export function exchangeCode(code: string) {
    return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
}

export function isConnected(): boolean {
    return existsSync(TOKEN_FILE);
}

export function disconnect() {
    rmSync(TOKEN_FILE, { force: true });
}

async function accessToken(): Promise<string> {
    if (!existsSync(TOKEN_FILE)) throw new TumblrError('Tumblr is not connected — click "Connect Tumblr" in the admin panel (Social → Tumblr)', 401);
    let token = JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as Token;
    if (Date.now() > token.expires_at - 60_000) {
        if (!token.refresh_token) throw new TumblrError('Tumblr session expired — connect again in the admin panel', 401);
        token = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh_token });
    }
    return token.access_token;
}

type Query = Record<string, string | number | boolean | undefined>;

/** Calls the API and returns its `response` (throws TumblrError with Tumblr's own error text). */
export async function tumblr<T = any>(method: string, path: string, opts: { query?: Query; json?: unknown; form?: FormData } = {}): Promise<T> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) q.set(k, String(v));
    const url = `${API}${path}${q.size ? `?${q}` : ''}`;
    const headers: Record<string, string> = { authorization: `Bearer ${await accessToken()}`, 'user-agent': 'elhellal-admin/1.0' };
    let body: BodyInit | null = null;
    if (opts.form) body = opts.form;
    else if (opts.json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(opts.json);
    }
    let res = await fetch(url, { method, headers, body });
    // Tumblr's API throws the odd 502/503; one retry after a pause clears most.
    if (res.status >= 500 && !opts.form) {
        await Bun.sleep(3000);
        res = await fetch(url, { method, headers, body });
    }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
        const detail = (data.errors ?? []).map((e: any) => e.detail || e.title).filter(Boolean).join('; ');
        throw new TumblrError(`Tumblr ${method} ${path}: ${detail || data.meta?.msg || res.statusText} (${res.status})`, res.status);
    }
    return data.response as T;
}

// ─── Posts ────────────────────────────────────────────────────────────────────

/** Width × height of a PNG or JPEG (Tumblr wants them on uploaded media). */
export function imageSize(buf: Uint8Array): { width: number; height: number } | null {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf[0] === 0x89 && buf[1] === 0x50) return { width: v.getUint32(16), height: v.getUint32(20) };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
        let i = 2;
        while (i + 9 < buf.length) {
            if (buf[i] !== 0xff) return null;
            const marker = buf[i + 1]!;
            const len = v.getUint16(i + 2);
            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                return { height: v.getUint16(i + 5), width: v.getUint16(i + 7) };
            }
            i += 2 + len;
        }
    }
    return null;
}

export interface Upload {
    identifier: string;
    data: Uint8Array;
    type: string;
}

/** Downloads an image so it can be uploaded with a post (Tumblr hosts its own copy). */
export async function download(url: string, identifier: string): Promise<Upload> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Image ${url}: ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    const type = res.headers.get('content-type')?.split(';')[0] || 'image/png';
    return { identifier, data, type };
}

/**
 * An NPF image block Tumblr fetches from `url` and re-hosts. (Multipart uploads
 * of our pins fail with 502 / "Posting failed", so images go by URL.)
 */
export function imageUrlBlock(url: string, alt: string) {
    return { type: 'image', alt_text: alt.slice(0, 1000), media: [{ url }] };
}

/** An NPF image block for an Upload. */
export function imageBlock(up: Upload, alt: string) {
    const size = imageSize(up.data);
    return { type: 'image', alt_text: alt.slice(0, 1000), media: [{ type: up.type, identifier: up.identifier, ...(size ?? {}) }] };
}

export interface NewPost {
    content: unknown[];
    tags?: string[];
    state?: 'published' | 'queue' | 'draft' | 'private';
    publish_on?: string;
    source_url?: string | undefined;
    /** Reblogs: the post being reblogged. */
    parent_tumblelog_uuid?: string;
    parent_post_id?: string;
    reblog_key?: string;
}

/** Creates an NPF post (multipart when it carries uploads). Returns the new post's id. */
export async function createPost(blog: string, post: NewPost, uploads: Upload[] = []): Promise<string> {
    const json = { ...post, tags: post.tags?.join(',') };
    const path = `/blog/${blog}/posts`;
    let res: { id_string?: string; id?: string | number };
    if (uploads.length) {
        const form = new FormData();
        form.append('json', new Blob([JSON.stringify(json)], { type: 'application/json' }));
        for (const up of uploads) form.append(up.identifier, new Blob([up.data as BlobPart], { type: up.type }), `${up.identifier}.${up.type.split('/')[1] || 'png'}`);
        res = await tumblr('POST', path, { form });
    } else {
        res = await tumblr('POST', path, { json });
    }
    return String(res.id_string ?? res.id);
}

/** Percent-encodes any non-ASCII in a URL without double-encoding what already is. */
export function asciiUrl(url: string) {
    try {
        return encodeURI(decodeURI(url));
    } catch {
        return encodeURI(url);
    }
}

/** A text block that is one link (Arabic/BMP text only — Tumblr indexes by character). */
export function linkText(text: string, url: string, bold = true) {
    const end = [...text].length;
    // Tumblr silently drops a link whose URL isn't ASCII (raw Arabic slugs), keeping only the bold.
    url = asciiUrl(url);
    const formatting: unknown[] = [{ start: 0, end, type: 'link', url }];
    if (bold) formatting.push({ start: 0, end, type: 'bold' });
    return { type: 'text', text, formatting };
}

export const text = (t: string, subtype?: 'heading1' | 'heading2' | 'quote' | 'quirky' | 'indented') =>
    subtype ? { type: 'text', text: t, subtype } : { type: 'text', text: t };
