/**
 * @file lib/analytics.ts
 *
 * Onchain event tracking — emits metrics to the standalone Salden
 * Analytics service (separate deployable, own repo). The five tracked
 * metrics: registered users, premium users, total transactions, total
 * employees paid, total USDC volume processed.
 *
 * ── Wiring ────────────────────────────────────────────────────────────
 * NEXT_PUBLIC_ANALYTICS_ENDPOINT → that service's /api/ingest URL, e.g.
 *   https://analytics.salden.xyz/api/ingest
 * ANALYTICS_INGEST_SECRET        → must exactly match INGEST_SECRET set
 *   on the analytics service. Authenticates THIS APP to that service as
 *   a server, sent as `Authorization: Bearer <secret>` — a separate trust
 *   boundary from how the analytics service authenticates human viewers
 *   (magic-link + allowlist, see that repo's lib/auth.ts).
 *
 * While NEXT_PUBLIC_ANALYTICS_ENDPOINT is unset, all calls are silently
 * dropped so nothing breaks in local dev before the analytics service is
 * deployed.
 *
 * ── SERVER-ONLY — do not import from a 'use client' component ─────────
 * ANALYTICS_INGEST_SECRET intentionally has NO NEXT_PUBLIC_ prefix so
 * Next.js never inlines it into a client bundle. That only protects the
 * secret if this module is exclusively evaluated server-side (API
 * routes, Inngest functions, server actions/components). If it's ever
 * imported from client code, `process.env.ANALYTICS_INGEST_SECRET`
 * resolves to `undefined` in the browser — the request below fails its
 * Bearer check and the event is silently dropped by the ingest endpoint,
 * so this can't leak the secret, but it also means the event is lost.
 * The guard below turns that into a loud dev-time warning instead of a
 * silent tracking gap, and is a hard stop in all environments so a
 * misplaced client import can never even attempt the request.
 */

export type AnalyticsEvent =
  | { event: 'user_registered';   walletAddress: string }
  | { event: 'user_upgraded';     walletAddress: string }
  | { event: 'payroll_executed';  walletAddress: string; employeeCount: number; volumeUsdc: number; txHash: string }
  | { event: 'batch_paid';        walletAddress: string; employeeCount: number; volumeUsdc: number; txHash: string }
  | { event: 'agent_activated';   walletAddress: string };

const ENDPOINT = process.env.NEXT_PUBLIC_ANALYTICS_ENDPOINT;
const INGEST_SECRET = process.env.ANALYTICS_INGEST_SECRET;

/**
 * Fire-and-forget analytics event. Never throws — safe to call anywhere
 * server-side. See file header — do not call this from client code.
 */
export async function track(payload: AnalyticsEvent): Promise<void> {
  if (typeof window !== 'undefined') {
    // Hard stop, not just a warning — see file header. A client-side call
    // site is a bug in the caller, not something this function should try
    // to paper over by sending a request that was always going to 401.
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn('[analytics] track() called from the browser — this must be server-only. Event dropped:', payload.event);
    }
    return;
  }

  if (!ENDPOINT) return;          // no endpoint configured yet — silent drop
  if (!INGEST_SECRET) {
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn('[analytics] NEXT_PUBLIC_ANALYTICS_ENDPOINT is set but ANALYTICS_INGEST_SECRET is not — every event will be rejected with 401. Event dropped:', payload.event);
    }
    return;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      await fetch(ENDPOINT, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${INGEST_SECRET}`,
        },
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
