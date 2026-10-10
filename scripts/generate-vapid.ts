/**
 * Creates the VAPID key pair the push Worker (workers/push/) signs with:
 *  - writes the public key into workers/push/wrangler.jsonc (it's public:
 *    browsers fetch it from /api/push/key)
 *  - writes the private key (a JWK) to workers/push/.dev.vars for wrangler dev
 *  - prints the command that stores it as the production secret
 *
 * Changing keys orphans every existing subscription (browsers bind them to the
 * key), so it refuses to replace a configured key without --force.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { b64urlEncode } from '../workers/push/src/webpush.ts';

const PUSH_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workers', 'push');
const WRANGLER = path.join(PUSH_DIR, 'wrangler.jsonc');
const DEV_VARS = path.join(PUSH_DIR, '.dev.vars');

const config = fs.readFileSync(WRANGLER, 'utf-8');
const current = /"VAPID_PUBLIC_KEY":\s*"([^"]*)"/.exec(config);
if (!current) throw new Error('VAPID_PUBLIC_KEY not found in workers/push/wrangler.jsonc');
if (current[1] && !process.argv.includes('--force')) {
    console.error('A VAPID key is already configured; replacing it drops every subscriber. Pass --force to do it anyway.');
    process.exit(1);
}

const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
const publicKey = b64urlEncode(await crypto.subtle.exportKey('raw', keys.publicKey));
const { kty, crv, x, y, d } = await crypto.subtle.exportKey('jwk', keys.privateKey);
const privateJwk = JSON.stringify({ kty, crv, x, y, d });

fs.writeFileSync(WRANGLER, config.replace(current[0], `"VAPID_PUBLIC_KEY": "${publicKey}"`));
const devVars = fs.existsSync(DEV_VARS) ? fs.readFileSync(DEV_VARS, 'utf-8').replace(/^VAPID_PRIVATE_JWK=.*\n?/m, '') : '';
fs.writeFileSync(DEV_VARS, `${devVars}VAPID_PRIVATE_JWK='${privateJwk}'\n`);

console.log(`✅ Public key written to workers/push/wrangler.jsonc: ${publicKey}`);
console.log('✅ Private key written to workers/push/.dev.vars');
console.log('\nStore it for production (paste the JWK when asked):');
console.log('  cd workers/push && bunx wrangler secret put VAPID_PRIVATE_JWK');
console.log(`\n${privateJwk}`);
