// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { b64urlDecode, b64urlEncode, encryptPayload } from './webpush';

// RFC 8291 Appendix A
const AS_PUBLIC = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const AS_PRIVATE = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
const UA_PUBLIC = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
const SALT = 'DGv6ra1nlYgDCS1FRnbzlw';
const PLAINTEXT = 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24';
const EXPECTED =
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';

describe('encryptPayload', () => {
    it('matches the RFC 8291 test vector', async () => {
        const pub = b64urlDecode(AS_PUBLIC);
        const jwk = { kty: 'EC', crv: 'P-256', d: AS_PRIVATE, x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33)) };
        const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const publicKey = await crypto.subtle.importKey('raw', pub, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
        const body = await encryptPayload(
            { endpoint: 'https://push.example.net/', p256dh: UA_PUBLIC, auth: AUTH },
            b64urlDecode(PLAINTEXT),
            { keys: { privateKey, publicKey }, salt: b64urlDecode(SALT) }
        );
        expect(b64urlEncode(body)).toBe(EXPECTED);
    });
});

describe('VapidSigner', () => {
    it('signs an ES256 JWT the public key verifies', async () => {
        const { VapidSigner } = await import('./webpush');
        const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
        const publicKey = b64urlEncode(await crypto.subtle.exportKey('raw', keys.publicKey));
        const signer = new VapidSigner({ publicKey, privateJwk: await crypto.subtle.exportKey('jwk', keys.privateKey), subject: 'https://elhellal.com/' });
        const header = await signer.authorization('https://fcm.googleapis.com/fcm/send/abc');
        const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
        expect(k).toBe(publicKey);
        const [h, c, s] = jwt!.split('.');
        expect(JSON.parse(new TextDecoder().decode(b64urlDecode(c!)))).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'https://elhellal.com/' });
        const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, b64urlDecode(s!), new TextEncoder().encode(`${h}.${c}`));
        expect(ok).toBe(true);
    });
});
