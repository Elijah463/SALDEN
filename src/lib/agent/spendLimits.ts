/**
 * @file lib/agent/spendLimits.ts
 * SERVER-SIDE ONLY.
 *
 * Two checks:
 *   1. Per-transaction ceiling (MAX_SINGLE_PAYMENT) — a flat platform-wide
 *      sanity number, always enforced, never configurable per employer.
 *   2. Daily cumulative ceiling per wallet — now TWO layers:
 *        a. PLATFORM_MAX_DAILY_TOTAL: an absolute, env-configured backstop
 *           no employer can exceed no matter what they configure.
 *        b. The employer's own configured limit (lib/agent/employerLimits.ts,
 *           set from Settings), which is validated at set-time to never be
 *           lower than their current gross payroll total — so a legitimate
 *           full payroll run can never be blocked partway through by a
 *           limit the employer set too conservatively.
 *      The effective ceiling actually enforced is whichever of the two is
 *      LOWER. If an employer has never configured their own limit, the
 *      platform default is the only ceiling in effect (same behaviour as
 *      before this file supported per-employer limits at all).
 *
 * Both are enforced at the point an unlisted-payment proposal is about to
 * be surfaced to the user — NOT at execution time, since execution
 * already requires a real wallet signature. This is a second, independent
 * line of defense, not the only one.
 *
 * ⚠ The daily-spend COUNTER itself (`_spend`) is still an in-memory Map,
 * same in-memory caveat as rateLimiter.ts and auth.ts — under-counting
 * across serverless instances makes this check slightly too permissive in
 * rare multi-instance races, which is a real residual risk worth knowing
 * about, not something this file silently fixes. The employer's
 * CONFIGURED limit itself, however, is real persisted data (via
 * employerLimits.ts / lib/kv.ts) — those are two different things with
 * two different risk profiles, handled accordingly.
 */

import { getEmployerDailyLimit } from './employerLimits';

const DAY_MS = 24 * 60 * 60 * 1000;

export const MAX_SINGLE_PAYMENT = Number(process.env.AGENT_MAX_SINGLE_PAYMENT ?? 1_000_000);
/** Platform-wide absolute ceiling — see file header. Kept under the same
 *  env var name as before (AGENT_MAX_DAILY_TOTAL); only its role changed,
 *  from "the only daily limit" to "the backstop no employer limit can
 *  exceed". */
export const PLATFORM_MAX_DAILY_TOTAL = Number(process.env.AGENT_MAX_DAILY_TOTAL ?? 5_000_000);

interface DailySpend { total: number; resetAt: number }
const _spend = new Map<string, DailySpend>();

// Same unbounded-growth concern as rateLimiter.ts — prune opportunistically.
function pruneExpiredSpend(): void {
  const now = Date.now();
  for (const [key, value] of _spend) {
    if (value.resetAt <= now) _spend.delete(key);
  }
}

function todayKey(walletAddress: string): string {
  return `${walletAddress.toLowerCase()}::${new Date().toISOString().slice(0, 10)}`;
}

export interface SpendCheck {
  allowed: boolean;
  reason?: 'single_payment_ceiling' | 'daily_ceiling';
  dailyTotalSoFar: number;
  /** The ceiling actually in effect for this wallet right now — either the
   *  employer's own configured limit or the platform default, whichever
   *  is lower. Useful for building an accurate error message. */
  effectiveDailyLimit: number;
}

/**
 * Checks whether proposing this amount would be allowed. Does NOT commit
 * the amount yet — call `recordProposedSpend` only once the user actually
 * confirms (the proposal itself shouldn't count against the ceiling,
 * since most proposals that reach this point do get confirmed, but a
 * user could decline — we don't want declined proposals to eat the
 * daily budget).
 *
 * Async because it now consults the employer's configured limit
 * (employerLimits.ts), which may be a KV round-trip.
 */
export async function checkSpendLimit(walletAddress: string, amount: number): Promise<SpendCheck> {
  if (_spend.size > 5000) pruneExpiredSpend();

  const employerLimit = await getEmployerDailyLimit(walletAddress);
  const effectiveDailyLimit = employerLimit != null
    ? Math.min(employerLimit, PLATFORM_MAX_DAILY_TOTAL)
    : PLATFORM_MAX_DAILY_TOTAL;

  if (amount > MAX_SINGLE_PAYMENT) {
    return {
      allowed: false,
      reason: 'single_payment_ceiling',
      dailyTotalSoFar: peekDailySpend(walletAddress),
      effectiveDailyLimit,
    };
  }

  const soFar = peekDailySpend(walletAddress);
  if (soFar + amount > effectiveDailyLimit) {
    return { allowed: false, reason: 'daily_ceiling', dailyTotalSoFar: soFar, effectiveDailyLimit };
  }

  return { allowed: true, dailyTotalSoFar: soFar, effectiveDailyLimit };
}

function peekDailySpend(walletAddress: string): number {
  const key = todayKey(walletAddress);
  const existing = _spend.get(key);
  if (!existing || existing.resetAt <= Date.now()) return 0;
  return existing.total;
}

/** Call this ONLY after a payment is actually confirmed/executed. */
export function recordProposedSpend(walletAddress: string, amount: number): void {
  const key = todayKey(walletAddress);
  const existing = _spend.get(key);
  if (!existing || existing.resetAt <= Date.now()) {
    _spend.set(key, { total: amount, resetAt: Date.now() + DAY_MS });
    return;
  }
  existing.total += amount;
}
