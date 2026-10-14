/**
 * @file app/api/bridge/rpc/route.ts
 * SERVER-SIDE ONLY.
 *
 * Same fix as app/api/rpc/route.ts, extended to the bridge feature's other
 * five chains (Ethereum, Base, Arbitrum, Avalanche
 * Linea). That proxy's own header comment documents the root
 * cause this mirrors exactly: a public RPC's 429 rate-limit
 * response doesn't carry CORS headers, so the browser reports it as a CORS
 * failure, which looks like a network/CORS bug but is really
 * rate-limiting wearing a CORS-shaped mask. Arc's balance reads were fixed
 * by routing them through our own domain server-side, with retry-on-429 and
 * a short-TTL de-dupe cache. The bridge page's destination-chain balance
 * (any of these five, Ethereum is the DEFAULT "to" chain, so this
 * was hitting basically every visitor on page load) was calling straight
 * through to each chain's public RPC directly from the browser via a bare
 * viem `http()` transport, with no such protection, that's why it was
 * showing a permanent ", " rather than an occasional one, unlike Arc's own
 * balance display right next to it (already proxied, and unaffected).
 *
 * One route, chain selected by a `?chain=<AppKitChain key>` query param, * viem's `http(url)` transport happily carries a query string through on
 * every POST it makes, so `http('/api/bridge/rpc?chain=Ethereum')`
 * routes every request for that client to the right upstream here with no
 * other wiring needed. Arc Network itself is deliberately NOT included in
 * CHAIN_RPC_URLS below, it already has its own dedicated, working proxy
 * (app/api/rpc/route.ts, backed by NEXT_PUBLIC_RPC_URL), and bridge/page.tsx
 * keeps using that one for Arc unchanged; this route exists only for the
 * five chains that had no proxy at all.
 *
 * Upstream URLs are each chain's own default public RPC endpoint from
 * viem/chains, the exact same endpoints the browser was already calling
 * directly; only WHERE the call originates from changes (server vs
 * browser), not which endpoint is used.
 */

import { NextRequest, NextResponse } from 'next/server';
import { mainnet, base, arbitrum, avalanche, linea } from 'viem/chains';

export const dynamic     = 'force-dynamic';
export const maxDuration = 30;

const CHAIN_RPC_URLS: Record<string, string> = {
  Ethereum:  mainnet.rpcUrls.default.http[0],
  Base:      base.rpcUrls.default.http[0],
  Arbitrum:  arbitrum.rpcUrls.default.http[0],
  Avalanche: avalanche.rpcUrls.default.http[0],
  Linea:     linea.rpcUrls.default.http[0],
};

const CACHEABLE_METHODS = new Set([
  'eth_call', 'eth_getBalance', 'eth_chainId', 'eth_blockNumber',
  'eth_gasPrice', 'eth_getCode', 'eth_getTransactionReceipt',
]);

// Defense-in-depth: this proxy has no signing capability, so it could
// never move funds either way, but without an allowlist it would happily
// relay ANY JSON-RPC method (including state-changing ones like
// eth_sendRawTransaction) to the upstream public RPC on anyone's behalf,
// turning our server into an open relay. The bridge page only ever needs
// read methods, so rejecting anything else costs nothing for legitimate
// use while closing that off.
const ALLOWED_METHODS = new Set([
  ...CACHEABLE_METHODS,
  'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getLogs',
  'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_estimateGas',
  'net_version', 'web3_clientVersion',
]);

// Same reasoning as app/api/rpc/route.ts: short-lived and in-memory on
// purpose, to collapse a same-render burst (this page reads two chains'
// balances every load) into one upstream call each, not to serve stale
// data. Keyed by chain too, since one Map now serves five upstreams.
const CACHE_TTL_MS = 1_200;
interface CacheEntry { result: unknown; expiresAt: number; }
const responseCache = new Map<string, CacheEntry>();

function pruneCache() {
  if (responseCache.size < 500) return;
  const now = Date.now();
  for (const [k, v] of responseCache) if (v.expiresAt <= now) responseCache.delete(k);
}

function cacheKey(chain: string, method: string, params: unknown): string {
  return `${chain}:${method}:${JSON.stringify(params ?? [])}`;
}

const RETRY_DELAYS_MS = [400, 900];

async function fetchUpstream(url: string, body: unknown): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, {
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

async function handleSingle(url: string, chain: string, reqBody: JsonRpcRequest): Promise<JsonRpcResponse> {
  if (!ALLOWED_METHODS.has(reqBody.method)) {
    return { jsonrpc: '2.0', id: reqBody.id, error: { code: -32601, message: `Method not allowed through this proxy: ${reqBody.method}` } };
  }
  const key = CACHEABLE_METHODS.has(reqBody.method) ? cacheKey(chain, reqBody.method, reqBody.params) : null;
  if (key) {
    const cached = responseCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return { jsonrpc: '2.0', id: reqBody.id, result: cached.result };
    }
  }
  const res = await fetchUpstream(url, reqBody);
  const data = await res.json() as JsonRpcResponse;
  if (key && data && data.error === undefined && data.result !== undefined) {
    pruneCache();
    responseCache.set(key, { result: data.result, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return { ...data, id: reqBody.id };
}

export async function POST(request: NextRequest) {
  const chain = request.nextUrl.searchParams.get('chain') ?? '';
  const upstream = CHAIN_RPC_URLS[chain];
  if (!upstream) {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32603, message: `Unknown or unsupported bridge chain: "${chain}"` } },
      { status: 400 },
    );
  }
  try {
    const body = await request.json();
    // Mirrors app/api/rpc/route.ts: viem's http() transport here isn't
    // configured with batch:true, so this is almost always a single
    // object, the array branch is handled defensively in case that ever
    // changes.
    if (Array.isArray(body)) {
      const results = await Promise.all(body.map((r: JsonRpcRequest) => handleSingle(upstream, chain, r)));
      return NextResponse.json(results);
    }
    const result = await handleSingle(upstream, chain, body as JsonRpcRequest);
    return NextResponse.json(result);
  } catch (err) {
    console.error(`[bridge rpc proxy] Error (chain=${chain}):`, err);
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Upstream RPC proxy request failed' } },
      { status: 502 },
    );
  }
}
