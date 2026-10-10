/**
 * Web Push with WebCrypto only (no Node APIs, so it runs in workerd):
 *   - payload encryption: RFC 8291 (Message Encryption for Web Push) with the
 *     aes128gcm content coding of RFC 8188, as a single record
 *   - VAPID: RFC 8292, an ES256 JWT per push service origin
 */

export interface PushTarget {
    endpoint: string;
    /** base64url, uncompressed P-256 point (65 bytes) */
    p256dh: string;
    /** base64url, 16 bytes */
    auth: string;
}

export interface Vapid {
    /** base64url, uncompressed P-256 point */
    publicKey: string;
    /** JWK of the matching private key */
    privateJwk: JsonWebKey;
    /** mailto: or https: contact for push services */
    subject: string;
}

const enc = new TextEncoder();

export function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let bin = '';
    for (const b of arr) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text: string): Uint8Array<ArrayBuffer> {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

async function hkdf(salt: BufferSource, ikm: BufferSource, info: BufferSource, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
    const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/**
 * RFC 8291 §3.4: the aes128gcm body for one push message. `fixed` (tests
 * only) pins the otherwise random sender key pair and salt.
 */
export async function encryptPayload(
    target: PushTarget,
    payload: Uint8Array,
    fixed?: { keys: CryptoKeyPair; salt: Uint8Array<ArrayBuffer> }
): Promise<Uint8Array<ArrayBuffer>> {
    const uaPublic = b64urlDecode(target.p256dh);
    const authSecret = b64urlDecode(target.auth);
    if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('bad subscription keys');

    const asKeys = fixed?.keys ?? (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair);
    const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', asKeys.publicKey)) as ArrayBuffer);
    const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const ecdhSecret = new Uint8Array(
        await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as EcdhKeyDeriveParams, asKeys.privateKey, 256)
    );

    const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
    const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
    const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
    const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

    // One record: the payload, then the 0x02 "last record" delimiter.
    const plaintext = concat(payload, new Uint8Array([2]));
    const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext));

    // Header: salt (16) | record size (uint32) | key id length (1) | key id (the as public key)
    const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
    header.set(salt, 0);
    new DataView(header.buffer).setUint32(16, 4096);
    header[20] = asPublic.length;
    header.set(asPublic, 21);
    return concat(header, ciphertext);
}

/** Signs VAPID JWTs, reusing one per push service origin for 12 hours. */
export class VapidSigner {
    private key: Promise<CryptoKey>;
    private cache = new Map<string, { jwt: string; exp: number }>();

    constructor(private vapid: Vapid) {
        this.key = crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    }

    async authorization(endpoint: string): Promise<string> {
        const aud = new URL(endpoint).origin;
        const now = Math.floor(Date.now() / 1000);
        let entry = this.cache.get(aud);
        if (!entry || entry.exp - now < 3600) {
            const exp = now + 12 * 3600;
            const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
            const claims = b64urlEncode(enc.encode(JSON.stringify({ aud, exp, sub: this.vapid.subject })));
            const unsigned = `${header}.${claims}`;
            // WebCrypto's ECDSA signature is already the raw r||s JWS wants.
            const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await this.key, enc.encode(unsigned));
            entry = { jwt: `${unsigned}.${b64urlEncode(signature)}`, exp };
            this.cache.set(aud, entry);
        }
        return `vapid t=${entry.jwt}, k=${this.vapid.publicKey}`;
    }
}

export interface SendOptions {
    /** Seconds the push service keeps an undelivered message. */
    ttl?: number;
    urgency?: 'very-low' | 'low' | 'normal' | 'high';
    /** Replaces an undelivered message with the same topic. */
    topic?: string;
}

/** Sends one message; resolves to the push service's HTTP status. */
export async function sendPush(signer: VapidSigner, target: PushTarget, payload: unknown, options: SendOptions = {}): Promise<number> {
    const body = await encryptPayload(target, enc.encode(JSON.stringify(payload)));
    const headers: Record<string, string> = {
        Authorization: await signer.authorization(target.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(options.ttl ?? 86_400),
        Urgency: options.urgency ?? 'normal',
    };
    if (options.topic) headers.Topic = options.topic;
    const res = await fetch(target.endpoint, { method: 'POST', headers, body });
    return res.status;
}
