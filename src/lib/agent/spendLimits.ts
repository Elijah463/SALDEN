/**
 * @file lib/agent/spendLimits.ts
 * SERVER-SIDE ONLY.
 *
 * The AI agent's ONLY spending ceiling is the daily limit the employer sets in
 * Settings. There is no per-payment cap and no platform-wide cap.
 *
 * Enforcement:
 *   - checkSpendLimit() is a read-only pre-check. It tells the chat what to say
 *     before a proposal is shown. It is advisory and never moves the budget.
 *   - reserveSpend() is the enforcement point. It atomically adds the amount to
 *     today's total in the shared KV store and rejects it if the total would
 *     exceed the limit. It runs BEFORE any agent-wallet transaction is submitted,
 *     so two concurrent payments cannot both pass.
 *   - releaseSpend() returns a reservation when the payment fails before it is
 *     submitted or fails on-chain.
 *
 * Totals are stored in integer micro-USDC to avoid float drift. Each day has its
 * own key (UTC), so the counter resets without any cleanup job.
 *
 * If no employer limit is set, the agent cannot spend. If the KV store is
 * unavailable, the agent cannot spend. Both fail closed.
 */
import { kvAvailable, kvGetStrict, kvIncrBy, kvSet, kvSetNX } from '@/lib/kv';
import { getEmployerDailyLimit } from './employerLimits';

const MICRO = 1_000_000;
const DAY_TTL_SECONDS = 2 * 24 * 60 * 60;

const toMicro = (usd: number): number => Math.round(usd * MICRO);
const dayKey = (walletAddress: string): string =>
  `agent:spend:${walletAddress.toLowerCase()}:${new Date().toISOString().slice(0, 10)}`;

/**
 * Why a spend was refused:
 *   daily_limit, the employer's configured daily limit would be exceeded
 *   unavailable, the spend store is down, so the limit cannot be checked
 */
export type SpendBlockReason = 'daily_limit' | 'unavailable';

export interface SpendCheck {
  allowed: boolean;
  reason?: SpendBlockReason;
  /** Spent today in USD, as far as the store knows. */
  dailyTotalSoFar: number;
  /** The employer's daily limit in USD, or null when no limit is set (unlimited). */
  effectiveDailyLimit: number | null;
}

/** A user-facing explanation for a refused spend. */
export function spendBlockMessage(check: SpendCheck): string {
  if (check.reason === 'unavailable') {
    return 'The agent cannot verify your spending right now, so this payment was not made. Please try again shortly.';
  }
  return `This would exceed your daily spend limit of $${(check.effectiveDailyLimit ?? 0).toFixed(2)} (already used $${check.dailyTotalSoFar.toFixed(2)} today).`;
}

/** Read-only pre-check. Reserves nothing. Unset limit means unlimited. */
export async function checkSpendLimit(walletAddress: string, amount: number): Promise<SpendCheck> {
  if (!kvAvailable()) return { allowed: false, reason: 'unavailable', dailyTotalSoFar: 0, effectiveDailyLimit: null };
  try {
    const limit = await getEmployerDailyLimit(walletAddress);
    const soFarMicro = (await kvGetStrict<number>(dayKey(walletAddress))) ?? 0;
    if (limit == null) return { allowed: true, dailyTotalSoFar: soFarMicro / MICRO, effectiveDailyLimit: null };
    const allowed = soFarMicro + toMicro(amount) <= toMicro(limit);
    return {
      allowed,
      reason: allowed ? undefined : 'daily_limit',
      dailyTotalSoFar: soFarMicro / MICRO,
      effectiveDailyLimit: limit,
    };
  } catch {
    return { allowed: false, reason: 'unavailable', dailyTotalSoFar: 0, effectiveDailyLimit: null };
  }
}

/**
 * Atomically counts `amount` against today's total and, if the employer has set a
 * limit, rejects it when the total would exceed that limit. Every agent payment is
 * counted, even when no limit is set, so a limit set later applies to the whole day.
 * Returns null when the payment must not proceed. Release it if the payment does not go through.
 */
export async function reserveSpend(walletAddress: string, amount: number): Promise<SpendReservation | null> {
  if (!kvAvailable()) return null;
  try {
    const limit = await getEmployerDailyLimit(walletAddress);
    const key = dayKey(walletAddress);
    const micro = toMicro(amount);
    const total = await kvIncrBy(key, micro, DAY_TTL_SECONDS);
    if (total === null) return null;
    if (limit != null && total > toMicro(limit)) {
      await kvIncrBy(key, -micro);
      return null;
    }
    return { key, micro };
  } catch {
    return null;
  }
}

export interface SpendReservation { key: string; micro: number; }

/** Returns a reservation to the day's total. Call when the payment did not go through. */
export async function releaseSpend(reservation: SpendReservation): Promise<void> {
  await kvIncrBy(reservation.key, -reservation.micro);
}

/**
 * Like reserveSpend, but keyed by a run id (for example a scheduled run's
 * idempotency key). Once a run has reserved, a retry of that same run returns
 * the existing reservation and does not add to the day's total again.
 *
 * The claim-then-reserve sequence is made atomic with kvSetNX: only the
 * caller that successfully creates the placeholder marker is allowed to
 * actually reserve spend for this run id. A concurrent retry that loses the
 * NX race briefly polls for the winner's real reservation instead of also
 * calling reserveSpend, which would otherwise double-count a single run
 * against the day's total if two retries landed close enough together.
 */
export async function reserveSpendForRun(
  walletAddress: string, amount: number, runId: string,
): Promise<SpendReservation | null> {
  if (!kvAvailable()) return null;
  const markerKey = `agent:spendrun:${runId}`;

  let wonClaim: boolean;
  try {
    wonClaim = await kvSetNX(markerKey, { pending: true }, DAY_TTL_SECONDS);
  } catch {
    return null;
  }

  if (!wonClaim) {
    // Someone else (a concurrent retry of this same run) is already
    // reserving. Poll briefly for their real reservation to land rather
    // than reserving again ourselves.
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 150));
      try {
        const existing = await kvGetStrict<SpendReservation>(markerKey);
        if (existing && 'key' in existing) return existing;
      } catch {
        return null;
      }
    }
    return null;
  }

  const reservation = await reserveSpend(walletAddress, amount);
  if (!reservation) return null;
  await kvSet(markerKey, reservation, DAY_TTL_SECONDS);
  return reservation;
}
