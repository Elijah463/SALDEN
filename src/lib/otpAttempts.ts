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

// Key on a hash of the token, never the raw token itself: no functional need
// for reversibility, and a bearer-like credential should not be stored verbatim.
function keyFor(token: string): string {
  return `otpAttempts:${crypto.createHash('sha256').update(token).digest('hex')}`;
}

export interface OtpAttemptCheck {
  allowed: boolean;
  attemptsRemaining: number;
}

/**
 * Call this ONCE per verify-otp request, before checking the submitted code, so
 * even a request that errors later still consumed an attempt. The counter lives
 * in KV so every instance shares it. If the counter cannot be updated, the attempt
 * is refused. Guessing must never get more tries because a store is unreachable.
 */
export async function checkAndConsumeOtpAttempt(token: string): Promise<OtpAttemptCheck> {
  if (!kvAvailable()) return { allowed: false, attemptsRemaining: 0 };
  const count = await kvIncr(keyFor(token), WINDOW_SECONDS);
  if (count === null) return { allowed: false, attemptsRemaining: 0 };
  return { allowed: count <= MAX_ATTEMPTS, attemptsRemaining: Math.max(0, MAX_ATTEMPTS - count) };
}
