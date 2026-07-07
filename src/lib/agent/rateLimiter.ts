/**
 * @file lib/agent/rateLimiter.ts
 * SERVER-SIDE ONLY.
 *
 * The old design relied entirely on a localStorage counter in
 * ChatInterface.tsx — trivially bypassed by clearing storage, opening
 * incognito, or calling the API directly. This enforces real limits the
 * server itself checks before ever calling Gemini.
 *
 * Two independent limits, two different shapes on purpose:
 *
 *   GLOBAL_DAILY_LIMIT   — a shared ceiling across every wallet, sized to
 *                          stay under this project's Gemini quota. This one
 *                          genuinely needs to reset once a day at a fixed
 *                          clock time, because that's how Gemini's own
 *                          quota resets — so it keeps the original
 *                          "counter per UTC calendar day" shape.
 *
 *   PER_WALLET limit     — protects a single wallet from hammering the
 *                          endpoint (accidental retry loops, runaway
 *                          scripts, etc.). This one used to be "N requests
 *                          per day, then blocked until midnight UTC" —
 *                          which is a harsh, confusing experience during
 *                          active testing (one enthusiastic test session
 *                          could lock a wallet out for the rest of the
 *                          day). Replaced with a short sliding window +
 *                          cooldown: once a wallet exceeds the limit
 *                          within WALLET_WINDOW_MS, it's paused for
 *                          WALLET_COOLDOWN_MS and then free to continue —
 *                          no calendar-day lockout.
 *
 * ⚠ HONEST LIMITATION (unchanged from before, deliberately not "fixed"
 * here): both limits are in-memory Maps. They work correctly on a single
 * long-lived Node process, but on serverless platforms each cold-started
 * instance gets its own memory, so counts are really per-instance, not
 * truly global. This module is a deliberately low-stakes place to accept
 * that tradeoff: under-counting here just means a slightly-too-generous
 * rate limit on rare multi-instance races, never a fund-safety issue (that
 * distinction is exactly why spendLimits.ts and employerLimits.ts — real
 * money and real user configuration, respectively — were upgraded to use
 * lib/kv.ts, while this file, deliberately, was not). If this ever needs
 * to be made strict across instances, swap `_store`/`_walletState` for
 * lib/kv.ts the same way scheduleStore.ts was.
 */

interface Counter { count: number; resetAt: number }

// Drop-in replacement point for Redis/Upstash/KV, if this is ever upgraded.
const _store = new Map<string, Counter>();

// Every distinct wallet address that ever calls the agent leaves one entry
// per UTC day in this Map forever, since nothing ever deletes an old key.
// On a long-lived Node process this grows without bound. Prune opportunistically
// (no background timer to leak) whenever the store gets large.
function pruneExpiredCounters(): void {
  const now = Date.now();
  for (const [key, value] of _store) {
    if (value.resetAt <= now) _store.delete(key);
  }
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // UTC date, matches client display logic
}

function nextMidnightUtc(): number {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.getTime();
}

function bump(key: string): number {
  const existing = _store.get(key);
  const now = Date.now();
  if (!existing || existing.resetAt <= now) {
    const fresh = { count: 1, resetAt: nextMidnightUtc() };
    _store.set(key, fresh);
    return 1;
  }
  existing.count += 1;
  return existing.count;
}

function peek(key: string): number {
  const existing = _store.get(key);
  if (!existing || existing.resetAt <= Date.now()) return 0;
  return existing.count;
}

export const GLOBAL_DAILY_LIMIT = Number(process.env.AGENT_GLOBAL_DAILY_LIMIT ?? 1455); // mirrors Gemini free tier buffer, kept as a UTC-midnight daily reset to match Gemini's own quota window

// ── Per-wallet: sliding window + cooldown (NOT a calendar-day limit) ────────
//
// NOTE ON THE ENV VAR: this reuses AGENT_PER_WALLET_DAILY_LIMIT rather than
// introducing a new env var, but its MEANING has changed — it is now "max
// requests allowed inside a WALLET_WINDOW_MS window before a cooldown
// kicks in", not "max requests per day". If you already have a numeric
// value set for this in Vercel from the old daily-limit design, re-check
// it makes sense under the new window (e.g. a value of 300 meant for "per
// day" is far too generous for "per 5 minutes" and would barely function
// as a limit at all). The default below (40 per 5 minutes) is intentionally
// generous for active feature testing while still stopping a runaway loop.
export const PER_WALLET_LIMIT = Number(process.env.AGENT_PER_WALLET_DAILY_LIMIT ?? 40);
const WALLET_WINDOW_MS   = 5  * 60 * 1000; // 5 minutes
const WALLET_COOLDOWN_MS = 2  * 60 * 1000; // once tripped, locked out for 2 minutes

interface WalletWindowState { windowStart: number; count: number; cooldownUntil: number }
const _walletState = new Map<string, WalletWindowState>();

function pruneExpiredWalletState(): void {
  const now = Date.now();
  for (const [key, value] of _walletState) {
    // Safe to drop once both the window and any cooldown have long expired.
    if (value.cooldownUntil <= now && now - value.windowStart > WALLET_WINDOW_MS * 2) {
      _walletState.delete(key);
    }
  }
}

export interface RateLimitCheck {
  allowed: boolean;
  reason?: 'global' | 'wallet_cooldown';
  globalCount: number;
  walletCount: number;
  /** Only set when reason === 'wallet_cooldown' — how long until this
   *  wallet can send another request. */
  retryAfterSeconds?: number;
}

/**
 * Checks AND increments in one call — call this once per accepted request,
 * before the Gemini call. If `allowed` is false, the counters were NOT
 * incremented for that rejected request (global limit) — the per-wallet
 * cooldown, once tripped, stays tripped regardless of further calls until
 * it naturally expires, which is the whole point of a cooldown.
 */
export function checkAndConsumeRateLimit(walletAddress: string): RateLimitCheck {
  if (_store.size > 5000) pruneExpiredCounters();
  if (_walletState.size > 5000) pruneExpiredWalletState();

  const now = Date.now();
  const wallet = walletAddress.toLowerCase();

  // ── Global daily ceiling (unchanged shape) ────────────────────────────────
  const globalKey = `global::${todayKey()}`;
  const globalCount = peek(globalKey);
  if (globalCount >= GLOBAL_DAILY_LIMIT) {
    return { allowed: false, reason: 'global', globalCount, walletCount: _walletState.get(wallet)?.count ?? 0 };
  }

  // ── Per-wallet sliding window + cooldown ──────────────────────────────────
  let state = _walletState.get(wallet);

  if (state && state.cooldownUntil > now) {
    // Still serving a cooldown from a previous breach — reject without
    // touching the count further.
    return {
      allowed: false,
      reason: 'wallet_cooldown',
      globalCount,
      walletCount: state.count,
      retryAfterSeconds: Math.ceil((state.cooldownUntil - now) / 1000),
    };
  }

  if (!state || now - state.windowStart > WALLET_WINDOW_MS) {
    // No state yet, or the previous window fully elapsed — start fresh.
    state = { windowStart: now, count: 1, cooldownUntil: 0 };
    _walletState.set(wallet, state);
  } else {
    state.count += 1;
    if (state.count > PER_WALLET_LIMIT) {
      state.cooldownUntil = now + WALLET_COOLDOWN_MS;
      return {
        allowed: false,
        reason: 'wallet_cooldown',
        globalCount,
        walletCount: state.count,
        retryAfterSeconds: Math.ceil(WALLET_COOLDOWN_MS / 1000),
      };
    }
  }

  const newGlobal = bump(globalKey);
  return { allowed: true, globalCount: newGlobal, walletCount: state.count };
}
