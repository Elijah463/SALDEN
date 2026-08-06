/**
 * @file app/api/rpc/route.ts
 * SERVER-SIDE ONLY.
 *
 * Proxies JSON-RPC calls to Arc's public RPC endpoint (NEXT_PUBLIC_RPC_URL)
 * so the browser talks to our own domain instead of directly to Arc's RPC.
 *
 * Why this exists: every read and write in this app previously went
 * straight from the browser to Arc's public testnet RPC via wagmi's
 * `http()` transport (see components/shared/Web3Provider.tsx). That RPC
 * intermittently rate-limits (HTTP 429, `{"code":-32011,"message":"request
 * limit reached"}`) — and because a 429 response from it doesn't carry
 * CORS headers, the browser reports that as a CORS failure, which is what
 * looked like a CORS misconfiguration but is really rate-limiting wearing
 * a CORS-shaped mask. This was the root cause behind a long list of
 * reported symptoms: the setup modal stuck on "Confirming on-chain",
 * Settings > Save Profile never showing success/failure, the payment
 * execution modal appearing to hang, "No registry clone deployed" on
 * Compliance despite one existing, wallet balances intermittently showing
 * 0.00, and "HTTP request failed" on Pricing's Upgrade flow (which alone
 * makes 4+ sequential reads plus two write-transactions' worth of receipt
 * polling, all direct-to-RPC — the single highest-request-density action
 * in the app, and so the most exposed to this).
 *
 * This proxy does two concrete things a direct client→RPC call cannot:
 *  1. Retries a 429 (or transient network failure) a couple of times with
 *     backoff, server-side, before the browser ever sees a failure.
 *  2. Short-TTL de-dupes identical, safe-to-cache reads (balances,
 *     eth_call, chain id, block number, tx receipts) so the common
 *     "several components each independently read the same value on the
 *     same page load" burst becomes one upstream call instead of five.
 *
 * Never caches or de-dupes anything that mutates state or that's
 * nonce/timing-sensitive (eth_sendRawTransaction, eth_getTransactionCount,
 * eth_estimateGas) — those always go straight through, retried but never
 * served from cache.
 */

import { NextRequest, NextResponse } from 'next/server';

export const dynamic    = 'force-dynamic';
export const maxDuration = 30;

const UPSTREAM_RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? '';

const CACHEABLE_METHODS = new Set([
  'eth_call', 'eth_getBalance', 'eth_chainId', 'eth_blockNumber',
  'eth_gasPrice', 'eth_getCode', 'eth_getTransactionReceipt',
]);

// Single-instance, in-memory, short-lived on purpose — this exists only to
// collapse a same-render-burst pattern into one upstream call, not to
// serve stale data. 1.2s is long enough to catch that burst and short
// enough that nobody could perceive it as "stale". A KV round trip would
// cost more latency than the burst it's trying to collapse, so in-memory
// is the right tool here, unlike the longer-lived, cross-instance caches
// in lib/serverCloneCache.ts / lib/serverProfileCache.ts.
const CACHE_TTL_MS = 1_200;
interface CacheEntry { result: unknown; expiresAt: number; }
const responseCache = new Map<string, CacheEntry>();

// Opportunistic cleanup so this Map can't grow unbounded across a warm
// instance's lifetime — cheap, and only ever runs on the (rare) miss path.
function pruneCache() {
  if (responseCache.size < 500) return;
  const now = Date.now();
  for (const [k, v] of responseCache) if (v.expiresAt <= now) responseCache.delete(k);
}

function cacheKey(method: string, params: unknown): string {
  return `${method}:${JSON.stringify(params ?? [])}`;
}

const RETRY_DELAYS_MS = [400, 900];

async function fetchUpstream(body: unknown): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(UPSTREAM_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      });
      if (res.status === 429 && attempt < RETRY_DELAYS_MS.length) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
    }
  }
  throw lastErr ?? new Error('Upstream RPC request failed');
}

interface JsonRpcRequest  { jsonrpc: string; id: number | string; method: string; params?: unknown[]; }
interface JsonRpcResponse { jsonrpc: string; id: number | string; result?: unknown; error?: unknown; }

async function handleSingle(reqBody: JsonRpcRequest): Promise<JsonRpcResponse> {
  const key = CACHEABLE_METHODS.has(reqBody.method) ? cacheKey(reqBody.method, reqBody.params) : null;
  if (key) {
    const cached = responseCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return { jsonrpc: '2.0', id: reqBody.id, result: cached.result };
    }
  }
  const res = await fetchUpstream(reqBody);
  const data = await res.json() as JsonRpcResponse;
  if (key && data && data.error === undefined && data.result !== undefined) {
    pruneCache();
    responseCache.set(key, { result: data.result, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return { ...data, id: reqBody.id };
}

export async function POST(request: NextRequest) {
  if (!UPSTREAM_RPC_URL) {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'RPC endpoint not configured' } },
      { status: 500 },
    );
  }
  try {
    const body = await request.json();
    // wagmi's http() transport isn't configured with `batch: true` (see
    // Web3Provider.tsx), so this is almost always a single object — the
    // array branch is handled defensively in case that ever changes.
    if (Array.isArray(body)) {
      const results = await Promise.all(body.map((r: JsonRpcRequest) => handleSingle(r)));
      return NextResponse.json(results);
    }
    const result = await handleSingle(body as JsonRpcRequest);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[rpc proxy] Error:', err);
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'RPC proxy request failed' } },
      { status: 502 },
    );
  }
}
