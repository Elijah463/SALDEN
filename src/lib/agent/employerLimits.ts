/**
 * @file lib/agent/employerLimits.ts
 * SERVER-SIDE ONLY.
 *
 * Lets each employer set their own daily AI-agent spend limit from
 * Settings, instead of every employer on the platform sharing one
 * env-var-configured number. The env vars in spendLimits.ts
 * (AGENT_MAX_SINGLE_PAYMENT / AGENT_MAX_DAILY_TOTAL) still apply on top of
 * whatever an employer configures here — they're now the platform-wide
 * absolute ceiling nobody can exceed, not the only limit that exists.
 *
 * This is employer-set CONFIGURATION, not an ephemeral counter, so unlike
 * rateLimiter.ts this is backed by lib/kv.ts (with an in-memory fallback
 * for local dev / projects that haven't attached a KV store yet) — losing
 * a rate-limit counter on a cold start is a minor inconvenience, but
 * silently forgetting an employer's deliberately-configured limit and
 * quietly reverting to the platform default would be a confusing,
 * hard-to-notice behaviour change for them.
 */

import { kvGet, kvSet, kvAvailable } from '@/lib/kv';

const _memory = new Map<string, number>(); // fallback: wallet (lowercased) -> configured limit

function memKey(walletAddress: string): string {
  return walletAddress.toLowerCase();
}

function kvKey(walletAddress: string): string {
  return `employerDailyLimit:${memKey(walletAddress)}`;
}

/** Returns the employer's configured limit, or null if they've never set
 *  one (caller should then fall back to the platform default). */
export async function getEmployerDailyLimit(walletAddress: string): Promise<number | null> {
  const key = memKey(walletAddress);

  if (kvAvailable()) {
    const stored = await kvGet<number>(kvKey(walletAddress));
    if (stored !== null) {
      _memory.set(key, stored); // keep the in-memory copy warm as a same-instance fast path
      return stored;
    }
  }

  return _memory.get(key) ?? null;
}

export interface SetLimitResult {
  ok: boolean;
  error?: string;
}

/**
 * Sets the employer's own daily spend limit. `amount` and
 * `grossPayrollTotal` must be in the same unit (USDC, human-readable
 * decimal, e.g. 1500.00). The floor check is re-validated here
 * server-side — never trust a client-side check alone for something that
 * gates real money movement, even something as comparatively low-stakes
 * as "how high can the ceiling be set".
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
      error: `Daily limit must be at least your current gross payroll total ($${grossPayrollTotal.toFixed(2)}) — otherwise a single full payroll run could be blocked partway through.`,
    };
  }

  const key = memKey(walletAddress);
  _memory.set(key, amount);
  // Best-effort — the in-memory copy above already covers this instance
  // even if the KV write below fails or KV isn't attached at all.
  await kvSet(kvKey(walletAddress), amount);

  return { ok: true };
}
