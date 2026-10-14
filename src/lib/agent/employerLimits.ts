/**
 * @file lib/agent/employerLimits.ts
 * SERVER-SIDE ONLY.
 *
 * Lets each employer set their own daily AI-agent spend limit from
 * Settings, instead of every employer on the platform sharing one
 * env-var-configured number. The employer's own limit is the only
 * ceiling the agent is subject to. There is no platform-wide cap.
 *
 * This is employer-set CONFIGURATION, not an ephemeral counter, so unlike
 * rateLimiter.ts this is backed by lib/kv.ts (with an in-memory fallback
 * for local dev / projects that haven't attached a KV store yet), losing
 * a rate-limit counter on a cold start is a minor inconvenience, but
 * silently forgetting an employer's deliberately-configured limit and
 * quietly reverting to the platform default would be a confusing,
 * hard-to-notice behaviour change for them.
 */

import { kvGetStrict, kvSet, kvAvailable } from '@/lib/kv';

function kvKey(walletAddress: string): string {
  return `employerDailyLimit:${walletAddress.toLowerCase()}`;
}

/**
 * The employer's configured daily limit, or null if none is set.
 * Throws if the KV store is unavailable: the caller cannot tell whether a limit
 * exists, so it must not assume one doesn't.
 */
export async function getEmployerDailyLimit(walletAddress: string): Promise<number | null> {
  return kvGetStrict<number>(kvKey(walletAddress));
}

export interface SetLimitResult {
  ok: boolean;
  error?: string;
}

/**
 * Sets the employer's own daily spend limit. `amount` and `grossPayrollTotal`
 * must be in the same unit (USDC, human-readable decimal). The floor check is
 * re-validated server-side.
 */
export async function setEmployerDailyLimit(
  walletAddress: string,
  amount: number,
  grossPayrollTotal: number,
): Promise<SetLimitResult> {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Invalid daily limit amount.' };
  }
  if (!Number.isFinite(grossPayrollTotal) || grossPayrollTotal < 0) {
    return { ok: false, error: 'Invalid gross payroll total.' };
  }
  if (amount < grossPayrollTotal) {
    return {
      ok: false,
      error: `Daily limit must be at least your current gross payroll total ($${grossPayrollTotal.toFixed(2)})  otherwise a single full payroll run could be blocked partway through.`
    };
  }
  if (!kvAvailable()) return { ok: false, error: 'Spend limits are temporarily unavailable. Please try again shortly.' };

  const saved = await kvSet(kvKey(walletAddress), amount);
  if (!saved) return { ok: false, error: 'Could not save your daily limit. Please try again.' };
  return { ok: true };
}
