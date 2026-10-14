/**
 * @file lib/approvals/approvalCache.ts
 * SERVER-SIDE ONLY.
 *
 * Backs the app's unified token-approval system. Every place in Salden that
 * needs an ERC-20 approve before pulling funds (Swap, Salden Pro upgrade
 * dashboard payroll runs, AI Agent in-chat payments, the AI Agent's own
 * autonomous/scheduled payroll wallet) now goes through this same cache
 * instead of each independently calling `publicClient.readContract('allowance')`
 * right before deciding whether to prompt for a fresh approve.
 *
 * ── Why a cache instead of always reading on-chain ─────────────────────────
 * Every existing call site already had its own copy of the same
 * "read live allowance → approve if short → wait for receipt" logic,
 * duplicated five-plus times across client pages/components and twice more
 * server-side for the agent wallet. This collapses all of that into one
 * flow used everywhere:
 *
 *   1. Look up the cached approved amount for (owner, token, spender).
 *   2. If it covers what's needed → skip the on-chain approve entirely.
 *   3. If not → request a fresh approve, then cache the new amount.
 *
 * ── This cache is advisory, never authoritative for fund movement ─────────
 * The ERC-20 contract itself is the only real source of truth for whether a
 * `transferFrom` is allowed to succeed, nothing about what's stored here
 * can move a single token. A stale/wrong cache entry (e.g. an approval that
 * was later revoked through some other means, like Etherscan or
 * revoke.cash) can at worst cause an unnecessary on-chain revert on the
 * downstream action, never an unauthorized transfer. `invalidateCachedApproval`
 * below exists specifically so a caller that observes that kind of revert
 * can clear the stale entry and self-heal on the next attempt instead of
 * staying wrong forever, see its call sites for the exact trigger.
 *
 * ── Persistence model ───────────────────────────────────────────────────
 * In-memory Map as the ONLY source when no KV store is attached (works
 * with zero config today), best-effort mirrored into lib/kv.ts (Vercel KV
 * / Upstash Redis) when one is attached, upgrading to real cross-instance
 * consistency with no further code changes. When KV IS attached, reads
 * always consult it rather than trusting a local copy indefinitely; local
 * memory only wins when it's provably newer than what KV returned (the
 * brief window right after this instance's own write, before KV's own
 * read-after-write consistency catches up), never as a standing override, * see getCachedApproval's own comment for why that distinction matters.
 *
 * KV layout: one key per (chainId, owner, token, spender) tuple, *   approvals:<chainId>:<owner>:<token>:<spender> -> { amount: string, updatedAt: number }
 * `amount` is stored as a decimal string since bigint isn't JSON-serialisable.
 */

import { kvGet, kvSet, kvDelete, kvAvailable } from '@/lib/kv';

export interface CachedApproval {
  amount:    bigint;
  updatedAt: number;
}

interface StoredApproval {
  amount:    string; // bigint as a decimal string, see file header
  updatedAt: number;
}

const _cache = new Map<string, StoredApproval>(); // same-instance fast path + read-your-own-write bridge (see getCachedApproval)

function cacheKey(chainId: number, owner: string, token: string, spender: string): string {
  return `approvals:${chainId}:${owner.toLowerCase()}:${token.toLowerCase()}:${spender.toLowerCase()}`;
}

/** Parses a stored entry defensively, an unparseable amount (corrupted
 *  data, a manual KV edit, a future format change) degrades to "nothing
 *  cached" rather than throwing. Server-side callers (autonomousExecution.ts,
 *  inngest/functions.ts) call getCachedApproval directly with no wrapping
 *  try/catch of their own around this specific read, so this needs to be
 *  safe at the source, consistent with the rest of this system's
 *  fail-open-toward-"not approved" philosophy (worst case: one unnecessary
 *  extra approve prompt, never a false "already approved"). */
function toCachedApproval(entry: StoredApproval): CachedApproval {
  try {
    const amount = BigInt(entry.amount);
    if (amount < 0n) return { amount: 0n, updatedAt: 0 };
    return { amount, updatedAt: entry.updatedAt };
  } catch {
    return { amount: 0n, updatedAt: 0 };
  }
}

/** Returns the cached approved amount, or 0n if there's no entry (never
 *  approved yet, or a previously invalidated entry), callers can always
 *  do a plain `cached >= amountNeeded` comparison without a separate
 *  null-check. */
export async function getCachedApproval(
  chainId: number, owner: string, token: string, spender: string,
): Promise<CachedApproval> {
  const key = cacheKey(chainId, owner, token, spender);
  const local = _cache.get(key);

  if (!kvAvailable()) {
    // No shared store configured, this instance's own memory is the only
    // source of truth there is.
    return local ? toCachedApproval(local) : { amount: 0n, updatedAt: 0 };
  }

  // Always consult KV, the cross-instance source of truth, rather than
  // trusting a local copy indefinitely. Local memory can still win, but
  // ONLY when it's strictly newer than whatever KV returned: that covers
  // the brief window right after THIS instance's own write, before KV's
  // own read-after-write consistency catches up, never a standing
  // override. This also means invalidateCachedApproval (called from a
  // DIFFERENT instance than the one that has a local copy) is correctly
  // seen on the very next read, instead of being invisible to any
  // instance that had already cached a value.
  const remote = await kvGet<StoredApproval>(key);

  if (local && (!remote || local.updatedAt >= remote.updatedAt)) {
    return toCachedApproval(local);
  }
  if (remote) {
    _cache.set(key, remote); // refresh local copy to match the authoritative value
    return toCachedApproval(remote);
  }
  return { amount: 0n, updatedAt: 0 };
}

/** Records a freshly-confirmed approval. Call this ONLY after the approve
 *  transaction has actually been confirmed on-chain (a successful receipt
 *  client-side, or a confirmed Circle tx status server-side), never right
 *  after broadcasting, the same race the rest of this codebase is careful
 *  about elsewhere (see lib/txReceipt.ts's header comment). */
export async function setCachedApproval(
  chainId: number, owner: string, token: string, spender: string, amount: bigint,
): Promise<void> {
  const key = cacheKey(chainId, owner, token, spender);
  const value: StoredApproval = { amount: amount.toString(), updatedAt: Date.now() };
  _cache.set(key, value);
  if (kvAvailable()) await kvSet(key, value);
}

/** Clears a cache entry, the safety net for when a downstream action
 *  (batchPay, deploy, a swap's internal transferFrom, …) reverts in a way
 *  that indicates the real on-chain allowance wasn't actually what the
 *  cache believed. Clearing it means the NEXT attempt re-checks honestly
 *  (sees nothing cached, so requests a fresh approve) instead of repeating
 *  the same wrong skip forever. */
export async function invalidateCachedApproval(
  chainId: number, owner: string, token: string, spender: string,
): Promise<void> {
  const key = cacheKey(chainId, owner, token, spender);
  _cache.delete(key);
  if (kvAvailable()) await kvDelete(key);
}
