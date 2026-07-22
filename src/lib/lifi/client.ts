/**
 * @file lib/lifi/client.ts
 * SERVER-SIDE ONLY.
 *
 * Thin wrapper around LI.FI's REST API (https://li.quest/v1) — no @lifi/sdk
 * dependency, since it isn't in package.json and this only needs a couple
 * of read endpoints. Never call these functions from client components;
 * always go through the /api/lifi/* routes so LIFI_API_KEY stays private
 * (see https://docs.li.fi — the key must never reach the browser).
 *
 * NOTE ON TESTNETS: LI.FI's own docs are explicit that they generally
 * don't support testnets ("limited user engagement... not reflective of
 * the production environment"). Arc Testnet is a confirmed, official
 * exception (community.arc.io: "LI.FI now supports Arc Testnet"), and
 * Base/Arbitrum/OP Sepolia are confirmed present in LI.FI's live /chains
 * response as of this writing. Whether Ethereum Sepolia, Avalanche Fuji,
 * and Linea Sepolia are *also* in that curated exception list isn't
 * something a static chain list here can promise — getSupportedChainIds
 * below asks LI.FI directly and only reports what it actually returns,
 * so the app never claims support LI.FI doesn't actually have.
 */

const LIFI_API_BASE = 'https://li.quest/v1';

function authHeaders(): HeadersInit {
  const key = process.env.LIFI_API_KEY;
  return key ? { 'x-lifi-api-key': key } : {};
}

export interface LifiQuoteParams {
  chainId:      number;
  fromToken:    string;
  toToken:      string;
  /** Raw on-chain amount (already scaled by the token's decimals), as a string. */
  fromAmount:   string;
  fromAddress:  string;
  /** Basis-points-style decimal, e.g. 0.005 for 0.5%. Defaults to LI.FI's own default if omitted. */
  slippage?:    number;
}

export interface LifiQuote {
  estimate: {
    fromAmount:       string;
    toAmount:         string;
    toAmountMin:      string;
    approvalAddress:  string;
    executionDuration: number;
  };
  transactionRequest: {
    to:    `0x${string}`;
    data:  `0x${string}`;
    value?: string;
    gasLimit?: string;
  };
  toolDetails?: { name?: string };
}

/** Fetches a real, executable LI.FI quote — a same-chain swap here (Arc
 *  Testnet to itself), but the same endpoint handles cross-chain too.
 *  Returns null if LI.FI can't find a viable route (e.g. no liquidity for
 *  a given pair) — callers should show that as "no route available", not
 *  a generic error. */
export async function getSwapQuote(params: LifiQuoteParams): Promise<LifiQuote | null> {
  try {
    const url = new URL(`${LIFI_API_BASE}/quote`);
    url.searchParams.set('fromChain', String(params.chainId));
    url.searchParams.set('toChain', String(params.chainId));
    url.searchParams.set('fromToken', params.fromToken);
    url.searchParams.set('toToken', params.toToken);
    url.searchParams.set('fromAmount', params.fromAmount);
    url.searchParams.set('fromAddress', params.fromAddress);
    if (params.slippage !== undefined) url.searchParams.set('slippage', String(params.slippage));

    const res = await fetch(url.toString(), { headers: authHeaders() });
    if (!res.ok) return null;
    const data = await res.json() as LifiQuote;
    if (!data.transactionRequest?.to || !data.transactionRequest?.data) return null;
    return data;
  } catch {
    return null;
  }
}

export interface LifiTokenPrice {
  address:  string;
  chainId:  number;
  symbol:   string;
  decimals: number;
  priceUSD: string; // decimal string, e.g. "0.9998"
}

/** Fetches a single token's live USD price from LI.FI. Returns null on any
 *  failure (unsupported chain/token, network error, etc.) — callers should
 *  treat this as "price unavailable" and simply omit the USD display,
 *  never block the underlying bridge/swap on it. */
export async function getTokenPrice(chainId: number, tokenAddress: string): Promise<LifiTokenPrice | null> {
  try {
    const url = new URL(`${LIFI_API_BASE}/token`);
    url.searchParams.set('chain', String(chainId));
    url.searchParams.set('token', tokenAddress);

    const res = await fetch(url.toString(), { headers: authHeaders(), next: { revalidate: 30 } });
    if (!res.ok) return null;

    const data = await res.json() as Partial<LifiTokenPrice>;
    if (!data.priceUSD) return null;

    return {
      address:  data.address ?? tokenAddress,
      chainId:  data.chainId ?? chainId,
      symbol:   data.symbol ?? '',
      decimals: data.decimals ?? 6,
      priceUSD: data.priceUSD,
    };
  } catch {
    return null;
  }
}

export interface LifiChainSummary {
  id:      number;
  key:     string;
  name:    string;
  mainnet: boolean;
}

// Cached in memory per warm serverless instance — this list changes rarely
// and every bridge/swap page load calling it fresh would be wasteful.
let cachedChains: { data: LifiChainSummary[]; fetchedAt: number } | null = null;
const CHAINS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

/** Returns every chain LI.FI currently reports as supported (mainnet and
 *  testnet). Source of truth for "is chain X actually usable right now" —
 *  see the file-level note above on why this isn't hardcoded. */
export async function getLifiSupportedChains(): Promise<LifiChainSummary[]> {
  if (cachedChains && Date.now() - cachedChains.fetchedAt < CHAINS_CACHE_TTL_MS) {
    return cachedChains.data;
  }
  try {
    const res = await fetch(`${LIFI_API_BASE}/chains?chainTypes=EVM`, { headers: authHeaders(), next: { revalidate: 600 } });
    if (!res.ok) return cachedChains?.data ?? [];
    const data = await res.json() as { chains?: Array<{ id: number; key: string; name: string; mainnet: boolean }> };
    const chains = (data.chains ?? []).map(c => ({ id: c.id, key: c.key, name: c.name, mainnet: c.mainnet }));
    cachedChains = { data: chains, fetchedAt: Date.now() };
    return chains;
  } catch {
    // Serve stale cache over a hard failure if we have one
    return cachedChains?.data ?? [];
  }
}
