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
 * own response and — with no attempt throttle — could brute-force the
 * 6-digit code (1,000,000 combinations) against verify-otp for the
 * token's full 10-minute lifetime. This module caps that at a small
 * number of attempts per token, independent of otp-token.ts's own
 * stateless design (this file is the one piece of state that design
 * intentionally didn't have — and needs, specifically for this).
 *
 * Backed by lib/kv.ts (with an in-memory fallback) rather than a bare Map
 * like rateLimiter.ts, because this is a genuine security control, not
 * just a UX throttle: under-counting attempts across serverless instances
 * would materially weaken the brute-force protection this exists to
 * provide, whereas rateLimiter.ts under-counting just makes a UX-only
 * limit slightly more generous.
 */

import crypto from 'crypto';
import { kvIncr, kvAvailable } from '@/lib/kv';

const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 10 * 60; // matches the OTP token's own expiry in otp-token.ts

interface AttemptCounter { count: number; resetAt: number }
const _memory = new Map<string, AttemptCounter>(); // fallback when no KV store is attached

// Key on a hash of the token, never the raw token itself — no functional
// need for reversibility, and it avoids using a bearer-like credential
// verbatim as a storage key (defense in depth; the OTP token is already
// HMAC-signed and short-lived, so this isn't hiding anything critical,
// it's just good hygiene for anything resembling a secret).
function keyFor(token: string): string {
  return `otpAttempts:${crypto.createHash('sha256').update(token).digest('hex')}`;
}

export interface OtpAttemptCheck {
  allowed: boolean;
  attemptsRemaining: number;
}

/**
 * Call this ONCE per verify-otp request, before checking the submitted
 * code, so even a request that errors out downstream still consumed an
 * attempt. Returns allowed=false once MAX_ATTEMPTS has been reached for
 * this specific token — the caller should then require the user to
 * request a brand new code rather than keep guessing against this one.
 */
export async function checkAndConsumeOtpAttempt(token: string): Promise<OtpAttemptCheck> {
  const key = keyFor(token);

  if (kvAvailable()) {
    const count = await kvIncr(key, WINDOW_SECONDS);
    if (count !== null) {
      return { allowed: count <= MAX_ATTEMPTS, attemptsRemaining: Math.max(0, MAX_ATTEMPTS - count) };
    }
    // KV call failed for some reason — fall through to the in-memory path
    // rather than fail the whole request; a slightly weaker throttle on a
    // rare KV hiccup is a better failure mode than blocking login entirely.
  }

  const now = Date.now();
  const existing = _memory.get(key);
  if (!existing || existing.resetAt <= now) {
    _memory.set(key, { count: 1, resetAt: now + WINDOW_SECONDS * 1000 });
    return { allowed: true, attemptsRemaining: MAX_ATTEMPTS - 1 };
  }
  existing.count += 1;
  return { allowed: existing.count <= MAX_ATTEMPTS, attemptsRemaining: Math.max(0, MAX_ATTEMPTS - existing.count) };
}
