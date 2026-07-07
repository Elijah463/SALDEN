/**
 * @file lib/agent/auth.ts
 * SERVER-SIDE ONLY.
 *
 * Previously, app/api/agent/chat and app/api/agent/faucet trusted whatever
 * `walletAddress` string the client sent — nothing tied the request to a
 * wallet the caller actually controls. Anyone could POST any address and
 * have the agent act (or propose actions) "as" that wallet.
 *
 * This adds a standard sign-in-with-wallet style flow:
 *   1. Client calls POST /api/agent/session with { walletAddress } and
 *      gets back a one-time nonce + message to sign.
 *   2. Client signs it with the connected wallet (walletClient.signMessage
 *      — the same pattern already used elsewhere in this codebase for IPFS
 *      encryption key derivation).
 *   3. Client calls POST /api/agent/session again with
 *      { walletAddress, signature } and gets a short-lived signed session
 *      token back.
 *   4. Every subsequent agent request includes `Authorization: Bearer <token>`.
 *      The chat/faucet routes verify the token before doing anything.
 *
 * Tokens are HMAC-signed JSON (not a full JWT library — no extra
 * dependency needed for this shape) using AGENT_SESSION_SECRET. Verifying
 * the original wallet signature uses viem's verifyMessage, so the only
 * thing trusted is cryptography, not a client-supplied string.
 *
 * ⚠ Same in-memory-Map caveat as rateLimiter.ts applies to the nonce
 * store below — fine for a single instance, swap for Redis/KV in a real
 * multi-instance deployment.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { verifyMessage, isAddress, getAddress } from 'viem';

const NONCE_TTL_MS   = 5 * 60 * 1000;   // 5 minutes to sign
const SESSION_TTL_MS = 15 * 60 * 1000;  // 15 minute session

const _nonces = new Map<string, { nonce: string; expiresAt: number }>();

// On a long-lived Node process (not a fresh serverless cold start every time),
// this Map would otherwise grow forever — every distinct wallet that ever
// requested a nonce leaves an entry behind even after it expires. Prune
// opportunistically rather than on a timer (no background interval to leak).
function pruneExpiredNonces(): void {
  const now = Date.now();
  for (const [key, value] of _nonces) {
    if (value.expiresAt <= now) _nonces.delete(key);
  }
}

function getSecret(): string {
  const secret = process.env.AGENT_SESSION_SECRET;
  if (!secret) throw new Error('AGENT_SESSION_SECRET is not configured.');
  return secret;
}

export function issueNonce(walletAddress: string): { nonce: string; message: string } {
  // Cheap opportunistic cleanup — bounded by the number of distinct wallets
  // that have ever signed in, which is small relative to request volume.
  if (_nonces.size > 200) pruneExpiredNonces();

  const key = walletAddress.toLowerCase();

  // If a non-expired nonce already exists for this wallet, return it.
  // Prevents a double-mount in React strict mode (or a duplicate request)
  // from overwriting the first nonce before the user has signed it.
  const existing = _nonces.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    const message =
      `Sign in to the Salden AI Payroll Agent.\n\n` +
      `Wallet: ${walletAddress}\n` +
      `Nonce: ${existing.nonce}\n` +
      `This signature does not authorize any payment or transaction — ` +
      `it only proves you control this wallet for this chat session.`;
    return { nonce: existing.nonce, message };
  }

  const nonce = randomBytes(16).toString('hex');
  _nonces.set(key, { nonce, expiresAt: Date.now() + NONCE_TTL_MS });
  const message =
    `Sign in to the Salden AI Payroll Agent.\n\n` +
    `Wallet: ${walletAddress}\n` +
    `Nonce: ${nonce}\n` +
    `This signature does not authorize any payment or transaction — ` +
    `it only proves you control this wallet for this chat session.`;
  return { nonce, message };
}

function signPayload(payload: string): string {
  return createHmac('sha256', getSecret()).update(payload).digest('hex');
}

export interface SessionTokenPayload {
  walletAddress: string;
  issuedAt:      number;
  expiresAt:     number;
}

export async function verifyAndIssueSession(
  walletAddress: string, signature: string,
): Promise<{ token: string } | { error: string }> {
  if (!isAddress(walletAddress)) return { error: 'Invalid wallet address.' };
  const checksummed = getAddress(walletAddress);

  const stored = _nonces.get(checksummed.toLowerCase());
  if (!stored || stored.expiresAt < Date.now()) {
    return { error: 'No active nonce for this wallet — call session start again.' };
  }

  const message =
    `Sign in to the Salden AI Payroll Agent.\n\n` +
    `Wallet: ${checksummed}\n` +
    `Nonce: ${stored.nonce}\n` +
    `This signature does not authorize any payment or transaction — ` +
    `it only proves you control this wallet for this chat session.`;

  let valid = false;
  try {
    valid = await verifyMessage({ address: checksummed as `0x${string}`, message, signature: signature as `0x${string}` });
  } catch {
    return { error: 'Signature verification failed.' };
  }
  if (!valid) return { error: 'Signature does not match this wallet.' };

  _nonces.delete(checksummed.toLowerCase()); // one-time use

  const payload: SessionTokenPayload = {
    walletAddress: checksummed,
    issuedAt:      Date.now(),
    expiresAt:     Date.now() + SESSION_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = signPayload(body);
  return { token: `${body}.${sig}` };
}

export function verifySessionToken(
  token: string | null, expectedWallet?: string,
): { ok: true; wallet: string } | { ok: false; error: string } {
  if (!token) return { ok: false, error: 'Missing session token.' };

  const [body, sig] = token.split('.');
  if (!body || !sig) return { ok: false, error: 'Malformed session token.' };

  const expectedSig = signPayload(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: 'Invalid session token signature.' };
  }

  let payload: SessionTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'Could not parse session token.' };
  }

  if (payload.expiresAt < Date.now()) return { ok: false, error: 'Session expired — sign in again.' };
  if (expectedWallet && payload.walletAddress.toLowerCase() !== expectedWallet.toLowerCase()) {
    return { ok: false, error: 'Session does not match the wallet on this request.' };
  }

  return { ok: true, wallet: payload.walletAddress };
}
