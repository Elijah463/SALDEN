/**
 * @file lib/analyticsClient.ts
 * CLIENT-SIDE. Companion to lib/analytics.ts (server-only).
 *
 * The only three events a browser is allowed to report, each requiring
 * the on-chain tx that just confirmed as proof — see
 * app/api/analytics/track/route.ts for the actual verification and why
 * this doesn't need a wallet-signature session. Call this AFTER
 * publicClient.waitForTransactionReceipt() confirms, never before.
 *
 * Fire-and-forget by design, same as the existing invoice-email pattern
 * in dashboard/page.tsx: the on-chain action already succeeded by the
 * time this is called, so a metrics-reporting failure must never surface
 * an error to the user or block their flow.
 */

export type ClientAnalyticsEvent =
  | { event: 'user_registered'; walletAddress: string; txHash: string }
  | { event: 'user_upgraded';   walletAddress: string; txHash: string }
  | { event: 'batch_paid';      walletAddress: string; txHash: string; employeeCount: number; volumeUsdc: number };

export function trackClientEvent(payload: ClientAnalyticsEvent): void {
  fetch('/api/analytics/track', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  }).catch(() => { /* best-effort — never surfaced to the user */ });
}
