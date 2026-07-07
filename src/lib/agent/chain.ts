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
 */

import { createPublicClient, http, type PublicClient } from 'viem';
import { arcTestnet } from '@/lib/contracts/config';

let _client: PublicClient | null = null;

export function getServerPublicClient(): PublicClient {
  if (_client) return _client;
  _client = createPublicClient({
    chain:     arcTestnet,
    transport: http(),
  }) as PublicClient;
  return _client;
}
