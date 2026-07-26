'use client';
/**
 * @file lib/swap/useTokenDecimals.ts
 *
 * Resolves each swap token's REAL on-chain `decimals()` instead of trusting
 * the hardcoded guess in lib/swap/tokens.ts.
 *
 * Why this matters: USDC and EURC are Circle-issued stablecoins, both
 * reliably 6 decimals — safe to hardcode. cirBTC's "8" in tokens.ts is a
 * guess based on real Bitcoin's convention, but nothing here confirms the
 * actual deployed Arc Testnet contract uses 8 rather than, say, 18 (common
 * for ERC-20s that don't intentionally mirror BTC's own precision). If
 * that guess is wrong, every raw-amount calculation for cirBTC (the amount
 * sent to LI.FI's /quote endpoint, and the amount actually swapped)
 * silently comes out 10^n too large or too small — which can easily look
 * like "no route available" (LI.FI correctly finding no viable route for
 * a request that's asking to swap either dust or an absurdly large amount)
 * even though the pair itself routes fine at the correct amount.
 *
 * This hook reads `decimals()` directly from each token's contract on
 * mount and caches the result (module-level, keyed by address) so it's
 * only ever fetched once per address per session. Callers should treat
 * the resolved value as authoritative once available, falling back to the
 * hardcoded TokenMeta.decimals only until the on-chain read resolves.
 */

import { useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { arcTestnet } from '@/lib/contracts/config';
import { ERC20_ABI } from '@/lib/contracts/abis';
import type { TokenMeta } from './tokens';

const decimalsCache = new Map<string, number>();

export function useTokenDecimals(tokens: (TokenMeta | null)[]): Record<string, number> {
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const [resolved, setResolved] = useState<Record<string, number>>({});

  const addressKey = tokens.filter(Boolean).map(t => t!.address).join(',');

  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;

    const toFetch = tokens.filter(
      (t): t is TokenMeta => !!t?.address && !decimalsCache.has(t.address)
    );

    if (toFetch.length === 0) {
      // Everything requested is already cached — surface it immediately.
      const fromCache: Record<string, number> = {};
      for (const t of tokens) {
        if (t?.address && decimalsCache.has(t.address)) fromCache[t.address] = decimalsCache.get(t.address)!;
      }
      if (Object.keys(fromCache).length) setResolved(prev => ({ ...prev, ...fromCache }));
      return;
    }

    Promise.all(
      toFetch.map(async t => {
        try {
          const d = await publicClient.readContract({
            address: t.address!, abi: ERC20_ABI, functionName: 'decimals',
          }) as number;
          decimalsCache.set(t.address!, d);
          return [t.address!, d] as const;
        } catch {
          // On-chain read failed (bad address, RPC hiccup, etc.) — keep the
          // hardcoded fallback rather than blocking the swap flow entirely.
          return null;
        }
      })
    ).then(results => {
      if (cancelled) return;
      const next: Record<string, number> = {};
      for (const r of results) if (r) next[r[0]] = r[1];
      if (Object.keys(next).length) setResolved(prev => ({ ...prev, ...next }));
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressKey, publicClient]);

  return resolved;
}

/** Applies resolved on-chain decimals over a TokenMeta's hardcoded guess, if available. */
export function withResolvedDecimals(token: TokenMeta | null, resolvedMap: Record<string, number>): TokenMeta | null {
  if (!token) return token;
  if (!token.address) return token;
  const real = resolvedMap[token.address];
  if (real === undefined || real === token.decimals) return token;
  return { ...token, decimals: real };
}
