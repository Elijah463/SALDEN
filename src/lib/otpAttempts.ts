/**
 * @file lib/otpAttempts.ts
 * SERVER-SIDE ONLY.
 *
 * ── Why this exists ────────────────────────────────────────────────────
 * Audit finding (critical): send-otp/route.ts rate-limits how often a
 * *code* can be sent, but verify-otp/route.ts had NO limit on how many
 * *guesses* could be made against a single token. Since otp-token.ts is
 * deliberately stateless (the token is handed back to whoever requested
 * the send, not just the true owner of the email), an attacker who
 * triggers an OTP send for a victim's email receives the token in their
 * own response and, with no attempt throttle, could brute-force the
 * 6-digit code (1,000,000 combinations) against verify-otp for the
 * token's full 10-minute lifetime. This module caps that at a small
 * number of attempts per token, independent of otp-token.ts's own
 * stateless design (this file is the one piece of state that design
 * intentionally didn't have, and needs, specifically for this).
 *
 * Backed by lib/kv.ts when a KV store is attached, because this is a genuine
 * security control: counting attempts across serverless instances is what makes
 * the brute-force protection strong.
 *
 * ── Why there is now an in-memory fallback ──────────────────────────────
 * This used to FAIL CLOSED: if KV was not attached to the Vercel project (or
 * a KV call errored), every verify-otp request was refused, so every login
 * showed "Too many incorrect attempts" on the very first try. That is what
 * hit the mainnet deployment, which has no KV store attached. It now falls
 * back to a per-instance counter (same approach as rateLimiter.ts). The cap
 * still applies on every instance; it is just not shared between instances.
 * Attach a KV store to get the strict, shared version.
 */

import crypto from 'crypto';
import { kvIncr, kvAvailable } from '@/lib/kv';

const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 10 * 60; // matches the OTP token's own expiry in otp-token.ts

// Key on a hash of the token, never the raw token itself: no functional need
// for reversibility, and a bearer-like credential should not be stored verbatim.
function keyFor(token: string): string {
  return `otpAttempts:${crypto.createHash('sha256').update(token).digest('hex')}`;
}

export interface OtpAttemptCheck {
  allowed: boolean;
  attemptsRemaining: number;
}

// ── In-memory fallback (used only when KV is missing or errors) ─────────────
interface LocalCounter { count: number; resetAt: number }
const _local = new Map<string, LocalCounter>();

function pruneLocal(now: number): void {
  if (_local.size < 2000) return;
  for (const [k, v] of _local) if (v.resetAt <= now) _local.delete(k);
}

function bumpLocal(key: string): number {
  const now = Date.now();
  pruneLocal(now);
  const existing = _local.get(key);
  if (!existing || existing.resetAt <= now) {
    _local.set(key, { count: 1, resetAt: now + WINDOW_SECONDS * 1000 });
    return 1;
  }
  existing.count += 1;
  return existing.count;
}

/**
 * Call this ONCE per verify-otp request, before checking the submitted code, so
 * even a request that errors later still consumed an attempt. Uses the shared KV
 * counter when available; otherwise (no KV attached, or the call failed) it counts
 * in this instance's memory, so a missing store never locks every user out.
 */
export async function checkAndConsumeOtpAttempt(token: string): Promise<OtpAttemptCheck> {
  const key = keyFor(token);
  let count: number | null = null;
  if (kvAvailable()) count = await kvIncr(key, WINDOW_SECONDS);
  if (count === null) count = bumpLocal(key);
  return { allowed: count <= MAX_ATTEMPTS, attemptsRemaining: Math.max(0, MAX_ATTEMPTS - count) };
}
