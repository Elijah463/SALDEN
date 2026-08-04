/**
 * @file lib/serverCloneCache.ts
 * SERVER-SIDE ONLY.
 *
 * Caches each wallet's discovered `registryClone` (SaldenRegistryFactory
 * clone) and `payrollClone` (SaldenMultiTokenPayrollFactory clone)
 * addresses, keyed by wallet address, via lib/kv.ts.
 *
 * Why this exists: multiple pages (dashboard, ai-agent, pricing) each
 * independently re-derive these two addresses with their own on-chain
 * `readContract` call + retry loop — which is not just duplicated code but
 * a duplicated point of failure. A cold RPC connection (most likely on
 * exactly the case this matters for: a brand-new browser or device, where
 * nothing has warmed up yet) can flake on any one of those independent
 * checks, and each page "forgetting" independently is exactly what
 * produced the reported symptom of the dashboard occasionally treating an
 * already-set-up account as brand new.
 *
 * These two addresses are permanent once deployed — a wallet can only ever
 * have one registry clone and one payroll clone (both factories are
 * one-per-address) — so once discovered, they never go stale. Caching them
 * turns every subsequent lookup, on any page, on any device, into a single
 * cheap KV read instead of an on-chain RPC round trip, while leaving the
 * on-chain read fully intact as the fallback (see the call sites in
 * app/dashboard/page.tsx, app/ai-agent/page.tsx, lib/useCloneAccess.ts and
 * app/pricing/page.tsx) for the first time a given address is ever seen, or
 * if the cache was never populated (e.g. no KV store attached — see
 * lib/kv.ts, which degrades to a safe no-op in that case).
 *
 * This cache stores nothing secret — both addresses are public on-chain
 * facts, readable by anyone who queries the factory contracts directly for
 * that wallet address. A bad/garbage cache entry can't cause loss of funds
 * or data: every write-side call site still targets the address it's
 * actually working with, so a wrong cached value would simply fail its
 * on-chain call the same way a wrong hand-typed address would, not silently
 * succeed against the wrong contract.
 */

import { kvGet, kvSet } from '@/lib/kv';

export interface CachedClones {
  registryClone?: string;
  payrollClone?:  string;
}

function cacheKey(address: string): string {
  return `clones:${address.toLowerCase()}`;
}

// 30 days — comfortably long since these values never change once set, but
// finite rather than forever so a key nobody ever touches again doesn't
// live in the store indefinitely.
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

export async function getCachedClones(address: string): Promise<CachedClones | null> {
  return kvGet<CachedClones>(cacheKey(address));
}

/** Merges `update` into whatever's already cached for this address, so a
 *  caller that only just discovered ONE of the two addresses never
 *  clobbers the other one if it was already cached. */
export async function setCachedClones(address: string, update: CachedClones): Promise<void> {
  const existing = await getCachedClones(address);
  const merged: CachedClones = { ...existing, ...update };
  await kvSet(cacheKey(address), merged, CACHE_TTL_SECONDS);
}
