/**
 * @file lib/circle/entitySecret.ts
 * SERVER-SIDE ONLY.
 *
 * Every "critical" (mutating) Circle Wallets endpoint — creating a
 * developer-controlled wallet, executing a contract call on either wallet
 * type, initializing a user-controlled wallet — requires an
 * `entitySecretCiphertext` field in the request body: the raw 32-byte
 * entity secret, RSA-OAEP(SHA-256) encrypted with Circle's published
 * public key, then base64-encoded. It must be freshly generated for
 * EVERY request — Circle rejects a reused ciphertext as a replay attempt.
 * See:
 *   https://developers.circle.com/wallets/dev-controlled/entity-secret-management
 *   https://github.com/circlefin/w3s-entity-secret-sample-code
 *
 * This used to be duplicated (incorrectly — sent as a raw HTTP header,
 * unencrypted) only in agent-wallet.ts. Pulled out here as its own module
 * so both agent-wallet.ts (developer-controlled) and user-wallet.ts
 * (user-controlled — needed once user-controlled wallets started signing
 * real transactions, not just registering) share one implementation
 * instead of two copies that could drift.
 */

import { publicEncrypt, constants as cryptoConstants, createHash } from 'crypto';

const CIRCLE_API_BASE = 'https://api.circle.com/v1/w3s';

let cachedPublicKeyPem: string | null = null;

async function fetchEntityPublicKey(apiKey: string): Promise<string> {
  if (cachedPublicKeyPem) return cachedPublicKeyPem;

  const res = await fetch(`${CIRCLE_API_BASE}/config/entity/publicKey`, {
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error('Could not fetch Circle entity public key');

  const data = await res.json();
  const publicKey: string | undefined = data.data?.publicKey;
  if (!publicKey) throw new Error('Circle entity public key response was missing publicKey');

  cachedPublicKeyPem = publicKey;
  return publicKey;
}

/**
 * Encrypts CIRCLE_ENTITY_SECRET (32-byte hex string) with Circle's public
 * key using RSA-OAEP/SHA-256, per their documented algorithm. MUST be
 * called fresh for every mutating request — never cache or reuse the
 * returned ciphertext, Circle rejects reused ones as replay attempts.
 */
export async function getEntitySecretCiphertext(): Promise<string> {
  const apiKey = process.env.CIRCLE_API_KEY ?? '';
  if (!apiKey) throw new Error('CIRCLE_API_KEY is not set');

  const entitySecretHex = process.env.CIRCLE_ENTITY_SECRET ?? '';
  if (!entitySecretHex) throw new Error('CIRCLE_ENTITY_SECRET is not set');

  const entitySecretBuffer = Buffer.from(entitySecretHex, 'hex');
  if (entitySecretBuffer.length !== 32) {
    throw new Error(
      `CIRCLE_ENTITY_SECRET must be a 32-byte hex-encoded string (64 hex chars) — got ${entitySecretBuffer.length} bytes.`,
    );
  }

  const publicKeyPem = await fetchEntityPublicKey(apiKey);

  const ciphertext = publicEncrypt(
    {
      key:      publicKeyPem,
      padding:  cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    entitySecretBuffer,
  );

  return ciphertext.toString('base64');
}

// ── Deterministic UUID v5 — Circle requires idempotencyKey to be a real
// UUID, not an arbitrary string. See agent-wallet.ts for the fuller
// writeup; shared here too since write-challenge creation needs the same
// treatment.
const SALDEN_UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export function toUUIDv5(name: string): string {
  const namespaceBytes = Buffer.from(SALDEN_UUID_NAMESPACE.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1').update(Buffer.concat([namespaceBytes, nameBytes])).digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
