/**
 * @file lib/serverProfileCache.ts
 * SERVER-SIDE ONLY.
 *
 * Caches each wallet's company name and payroll-receipt email, keyed by
 * wallet address, via lib/kv.ts — same storage backend and TTL-refresh
 * pattern as lib/serverCloneCache.ts.
 *
 * Why this exists: today the only place companyName/email actually live is
 * inside the IPFS-synced, signature-encrypted payroll payload (see
 * context/AppContext.tsx's syncData/loadData). Reading that back requires
 * a wallet signature (to derive the decryption key) plus an IPFS fetch —
 * fine for the full employee dataset, but overkill for two small display
 * fields, and it means a brand-new browser or device shows a blank company
 * name / email until that whole signature+fetch round trip completes (or
 * doesn't, if the person hasn't reconnected their wallet yet). This cache
 * is a fast, no-signature-required path for exactly those two fields, so
 * they render immediately across any browser or device for a given wallet
 * address — the full IPFS-encrypted record remains the source of truth and
 * this cache is refreshed every time that record is saved; if the cache is
 * ever unavailable or stale, callers simply fall back to the existing
 * IPFS-hydration flow, which is unaffected by any of this.
 *
 * Unlike the clone addresses in serverCloneCache.ts, company name and email
 * are ordinary display text a person might change — cached indefinitely
 * within the TTL, always overwritten wholesale on every save (no merge
 * needed, since Settings always submits both fields together).
 */

import { kvGet, kvSet } from '@/lib/kv';

export interface CachedProfile {
  companyName?: string;
  email?:       string;
}

function cacheKey(address: string): string {
  return `profile:${address.toLowerCase()}`;
}

// 30 days, same rationale as serverCloneCache.ts's TTL — long enough that a
// wallet in regular use never sees it expire, finite so an abandoned key
// doesn't sit in the store forever.
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

export async function getCachedProfile(address: string): Promise<CachedProfile | null> {
  return kvGet<CachedProfile>(cacheKey(address));
}

export async function setCachedProfile(address: string, profile: CachedProfile): Promise<void> {
  await kvSet(cacheKey(address), profile, CACHE_TTL_SECONDS);
}
