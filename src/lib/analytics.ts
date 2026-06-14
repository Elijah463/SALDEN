/**
 * @file lib/analytics.ts
 *
 * Onchain event tracking — emits metrics to an external analytics site.
 * The five tracked metrics:
 *   1. Registered users
 *   2. Premium users
 *   3. Total transactions
 *   4. Total employees paid through Salden
 *   5. Total USDC volume processed
 *
 * Set NEXT_PUBLIC_ANALYTICS_ENDPOINT in .env.local to point to the
 * external analytics site once it is live. While unset, all calls
 * are silently dropped so nothing breaks during development.
 */

export type AnalyticsEvent =
  | { event: 'user_registered';   walletAddress: string }
  | { event: 'user_upgraded';     walletAddress: string }
  | { event: 'payroll_executed';  walletAddress: string; employeeCount: number; volumeUsdc: number; txHash: string }
  | { event: 'batch_paid';        walletAddress: string; employeeCount: number; volumeUsdc: number; txHash: string }
  | { event: 'agent_activated';   walletAddress: string };

const ENDPOINT = process.env.NEXT_PUBLIC_ANALYTICS_ENDPOINT;

/**
 * Fire-and-forget analytics event. Never throws — safe to call anywhere.
 */
export async function track(payload: AnalyticsEvent): Promise<void> {
  if (!ENDPOINT) return;          // no endpoint configured yet — silent drop
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      await fetch(ENDPOINT, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...payload, ts: Date.now() }),
        signal:  controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Analytics must never surface errors to the user
  }
}

// ── Convenience wrappers ───────────────────────────────────────────────────────

export const Analytics = {
  userRegistered:  (walletAddress: string) =>
    track({ event: 'user_registered', walletAddress }),

  userUpgraded:    (walletAddress: string) =>
    track({ event: 'user_upgraded', walletAddress }),

  payrollExecuted: (walletAddress: string, employeeCount: number, volumeUsdc: number, txHash: string) =>
    track({ event: 'payroll_executed', walletAddress, employeeCount, volumeUsdc, txHash }),

  batchPaid:       (walletAddress: string, employeeCount: number, volumeUsdc: number, txHash: string) =>
    track({ event: 'batch_paid', walletAddress, employeeCount, volumeUsdc, txHash }),

  agentActivated:  (walletAddress: string) =>
    track({ event: 'agent_activated', walletAddress }),
};
