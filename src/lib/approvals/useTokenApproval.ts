'use client';
/**
 * @file lib/approvals/useTokenApproval.ts
 * CLIENT-SIDE.
 *
 * The single hook every client-side flow that needs an ERC-20 approval
 * should use, instead of its own copy of "read live allowance → approve if
 * short → wait for receipt". Replaces that duplicated block in:
 *   - app/wallet/swap/page.tsx        (approve tokenIn for LI.FI's router)
 *   - app/pricing/page.tsx            (approve USDC for the deploy factory)
 *   - app/dashboard/page.tsx          (approve USDC for a payroll batchPay)
 *   - components/agent/AgentConfirmationCards.tsx (two in-chat payment
 *     flows — an unlisted single payment and a full payroll run)
 *
 * Works for BOTH of the app's login methods unchanged — it's built on
 * useUniversalWrite, which already branches on external-wallet (wagmi) vs
 * Circle social-login signing, so nothing here needs to know which one is
 * active.
 *
 * ── The flow (unified across every call site) ──────────────────────────
 *   1. Ask the server cache (GET /api/approvals) whether this wallet has
 *      already approved this spender for this token, and for how much.
 *   2. If the cached amount already covers what's needed → done, no wallet
 *      prompt at all.
 *   3. If not → request a fresh on-chain approve (same UniversalWrite path
 *      every other write in this app uses), wait for it to actually be
 *      confirmed on-chain (never just broadcast — see lib/txReceipt.ts's
 *      header for the exact race this avoids, which used to make Swap and
 *      Dashboard's payroll runs intermittently revert with
 *      TRANSFER_FROM_FAILED), then record the new amount in the cache
 *      (POST /api/approvals) so the next action, anywhere in the app,
 *      sees it immediately.
 *
 * The cache is a UX/perf convenience, never the actual source of truth for
 * whether a transfer is allowed — the ERC-20 contract itself always has
 * final say (see approvalCache.ts's header). If a downstream action
 * reverts in a way that suggests the cache was wrong (e.g. the allowance
 * was revoked some other way), call `invalidateApproval` in that catch
 * block so the next attempt re-checks honestly instead of repeating the
 * same mistake — see AgentConfirmationCards.tsx / dashboard/page.tsx for
 * where that's wired in.
 */

import { useCallback } from 'react';
import { usePublicClient } from 'wagmi';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { useUniversalWrite } from '@/lib/circle/useUniversalWrite';
import { waitForSuccessfulReceipt } from '@/lib/txReceipt';
import { arcTestnet } from '@/lib/contracts/config';
import { ERC20_ABI } from '@/lib/contracts/abis';

export interface EnsureApprovalParams {
  token:   `0x${string}`;
  spender: `0x${string}`;
  /** Raw token units (already scaled by the token's decimals) needed for
   *  the action about to run. */
  amount:  bigint;
  onStatusChange?: (msg: string) => void;
}

async function fetchCachedAmount(chainId: number, owner: string, token: string, spender: string): Promise<bigint> {
  try {
    const res = await fetch(`/api/approvals?chainId=${chainId}&owner=${owner}&token=${token}&spender=${spender}`, {
      cache: 'no-store',
    });
    if (!res.ok) return 0n; // fail-open toward "not approved" — worst case is one extra approve prompt, never a skipped one
    const data = await res.json() as { amount?: string };
    return data.amount ? BigInt(data.amount) : 0n;
  } catch {
    return 0n;
  }
}

async function writeCachedAmount(chainId: number, owner: string, token: string, spender: string, amount: bigint): Promise<void> {
  try {
    await fetch('/api/approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chainId, owner, token, spender, amount: amount.toString() }),
    });
  } catch {
    // Best-effort — if this fails, the next action's GET simply sees no
    // cache entry and re-approves, which is correct (if slightly
    // redundant) rather than unsafe.
  }
}

export interface UseTokenApprovalResult {
  /** Ensures `spender` can pull at least `amount` of `token` from the
   *  current wallet. Returns the approve transaction hash if a fresh
   *  on-chain approve was actually sent, or `null` if the cache already
   *  covered the needed amount and nothing was sent. Throws on failure —
   *  same contract as useUniversalWrite, so existing try/catch call sites
   *  don't need new error handling. */
  ensureApproval:    (params: EnsureApprovalParams) => Promise<`0x${string}` | null>;
  /** Clears the cached entry for (token, spender) — call this from a
   *  downstream action's catch block when the failure looks
   *  allowance-related, so the next attempt re-approves instead of
   *  repeating a stale skip. */
  invalidateApproval: (token: `0x${string}`, spender: `0x${string}`) => Promise<void>;
}

export function useTokenApproval(): UseTokenApprovalResult {
  const { address }        = useEffectiveAddress();
  const { writeContract }  = useUniversalWrite();
  const publicClient       = usePublicClient({ chainId: arcTestnet.id });

  const ensureApproval = useCallback(async (
    { token, spender, amount, onStatusChange }: EnsureApprovalParams,
  ): Promise<`0x${string}` | null> => {
    if (!address) throw new Error('Not logged in.');

    const cached = await fetchCachedAmount(arcTestnet.id, address, token, spender);
    if (cached >= amount) return null; // already covered — skip the wallet entirely

    onStatusChange?.('Requesting approval…');
    const approveTxHash = await writeContract(
      { address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] },
      onStatusChange,
    );

    // Same race lib/txReceipt.ts's header describes: the downstream action
    // (swap/batchPay/deploy) needs the allowance actually LIVE on-chain,
    // not just broadcast. Only cache the new amount once it's confirmed —
    // caching an amount that never lands would make the next action skip
    // an approve it still genuinely needs. This throws rather than
    // silently skipping the wait if publicClient is unavailable — every
    // current call site already guards for that before calling
    // ensureApproval at all, so this should never actually fire today,
    // but the hook itself shouldn't depend on every caller remembering to
    // duplicate that guard to stay correct.
    if (!publicClient) throw new Error('No RPC client available to confirm the approval — please try again.');
    await waitForSuccessfulReceipt(publicClient, approveTxHash);

    await writeCachedAmount(arcTestnet.id, address, token, spender, amount);
    return approveTxHash;
  }, [address, writeContract, publicClient]);

  const invalidateApproval = useCallback(async (
    token: `0x${string}`, spender: `0x${string}`,
  ): Promise<void> => {
    if (!address) return;
    try {
      await fetch('/api/approvals', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chainId: arcTestnet.id, owner: address, token, spender }),
      });
    } catch {
      // Best-effort — worst case the stale entry lingers until it's
      // overwritten by a future successful approve.
    }
  }, [address]);

  return { ensureApproval, invalidateApproval };
}
