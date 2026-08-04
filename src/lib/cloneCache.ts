'use client';
/**
 * @file lib/cloneCache.ts
 * CLIENT-SIDE.
 *
 * Thin fetch wrappers around GET/POST /api/clones — see
 * lib/serverCloneCache.ts for the full reasoning. Every call site that
 * looks up a registryClone/payrollClone (dashboard, ai-agent, pricing,
 * useCloneAccess) should call `readCloneCache()` FIRST and only fall back
 * to its existing on-chain `readContract` retry loop on a miss, then call
 * `writeCloneCache()` (fire-and-forget) right after a fresh on-chain
 * discovery so the next lookup for that address is instant everywhere.
 *
 * Both functions are deliberately silent on failure — a cache miss and a
 * cache error look identical to the caller (null / no-op), since the
 * correct behaviour is the same either way: fall through to on-chain.
 */

export interface CloneCacheEntry {
  registryClone: string | null;
  payrollClone:  string | null;
}

export async function readCloneCache(address: string): Promise<CloneCacheEntry> {
  try {
    const res = await fetch(`/api/clones?address=${encodeURIComponent(address)}`, { cache: 'no-store' });
    if (!res.ok) return { registryClone: null, payrollClone: null };
    const data = await res.json() as { registryClone?: string | null; payrollClone?: string | null };
    return { registryClone: data.registryClone ?? null, payrollClone: data.payrollClone ?? null };
  } catch {
    return { registryClone: null, payrollClone: null };
  }
}

/** Fire-and-forget — callers never await the result. A failed cache write
 *  only means the NEXT fresh browser/device pays the on-chain lookup again
 *  instead of hitting the cache; it never affects the current session,
 *  which already has the value in local state. */
export function writeCloneCache(address: string, update: { registryClone?: string; payrollClone?: string }): void {
  fetch('/api/clones', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ address, ...update }),
  }).catch(() => { /* best-effort */ });
}
