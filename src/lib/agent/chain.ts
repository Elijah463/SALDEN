/**
 * @file lib/agent/chain.ts
 * SERVER-SIDE ONLY.
 *
 * A single shared viem public client for server-side on-chain reads
 * (balances, transaction receipts). Reuses the same `arcTestnet` chain
 * object the rest of the app already imports from `@/lib/contracts/config`
 * — no new RPC configuration invented here. `http()` with no URL argument
 * uses the chain's own `rpcUrls.default.http[0]`, the same default your
 * wagmi setup already relies on.
 *
 * Explicit retry/backoff added here for the same reason app/api/rpc/route.ts
 * (the client-facing proxy) retries: Arc's public RPC intermittently
 * rate-limits (HTTP 429). This client has no CORS exposure (server-side),
 * but it hits the exact same rate-limited endpoint, and viem's own default
 * retry (retryCount: 3, ~150ms delay) is tuned for generic transient
 * network blips, not this RPC's specific rate-limiting window — too short
 * a gap between attempts to reliably ride out a 429. Consumers of this
 * shared client include app/api/payroll-receipt/send/route.ts (verifying
 * a transaction is real and confirmed before emailing a receipt for it —
 * a single failed, unretried read here silently drops an otherwise-
 * successful payroll run's receipt with no visible error to the person,
 * since that whole call is fire-and-forget from the client), plus
 * lib/agent/autonomousExecution.ts and lib/inngest/functions.ts's
 * scheduled-payment execution.
 */

import { createPublicClient, http, type PublicClient } from 'viem';
import { arcTestnet } from '@/lib/contracts/config';

let _client: PublicClient | null = null;

export function getServerPublicClient(): PublicClient {
  if (_client) return _client;
  _client = createPublicClient({
    chain:     arcTestnet,
    transport: http(undefined, { retryCount: 5, retryDelay: 800 }),
  }) as PublicClient;
  return _client;
}
