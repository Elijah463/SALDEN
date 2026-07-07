/**
 * @file lib/useCloneAccess.ts
 * CLIENT-SIDE.
 *
 * Self-healing lookup for `payrollClone` (the employer's deployed
 * SaldenMultiTokenPayroll contract address).
 *
 * ── History, so nobody re-deletes this by accident ─────────────────────
 * This file previously read a contract called `SaldenPayrollFactory` via
 * `NEXT_PUBLIC_PAYROLL_FACTORY_ADDRESS` — a contract that was never
 * actually deployed. That env var was unset, so the read always resolved
 * against the zero address and silently fell through to `payrollClone`
 * anyway. Its only caller (ai-agent/page.tsx) removed it, and since that
 * left it with zero remaining callers, it was deleted as dead code.
 *
 * That deletion surfaced a real, separate gap though: `payrollClone` had
 * NO on-chain fallback at all. It only ever comes from (a) pricing/page.tsx
 * right after a fresh deploy, or (b) whatever was last synced into
 * payrollSetup (IPFS/local storage) — both a CACHE, not a live check. A
 * failed sync, a cleared browser, or a new device all left it empty with
 * nothing to recover it, unlike `registryClone`, which already has this
 * exact kind of self-healing effect in both ai-agent/page.tsx and
 * dashboard/page.tsx.
 *
 * The fix was written inline as a duplicated useEffect in both of those
 * pages first. This file replaces both copies with the one, correctly-
 * wired version — reading the REAL, actually-deployed
 * SaldenMultiTokenPayrollFactory via NEXT_PUBLIC_MULTI_TOKEN_FACTORY_ADDRESS
 * (CONTRACTS.MULTI_TOKEN_FACTORY) — so there's exactly one place to
 * maintain if the ABI or contract ever changes, instead of two copies that
 * could quietly drift apart.
 *
 * Usage: call `useCloneAccess()` once per page that needs this (no
 * arguments, matching the hook's original calling convention). It writes
 * straight into AppContext via SET_PAYROLL_CLONE when it finds something —
 * callers keep reading `state.payrollClone` as before; nothing about how
 * pages consume the value has changed, only where the fallback lookup
 * itself lives.
 */

import { useEffect } from 'react';
import { usePublicClient } from 'wagmi';
import { useApp } from '@/context/AppContext';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { CONTRACTS } from '@/lib/contracts/config';
import { MULTI_TOKEN_FACTORY_ABI } from '@/lib/contracts/abis';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function useCloneAccess(): void {
  const { state, dispatch } = useApp();
  const { payrollClone } = state;
  const { address } = useEffectiveAddress();
  const publicClient = usePublicClient();

  useEffect(() => {
    // Never overrides a value we already have — this is ONLY a fallback
    // for when payrollSetup's cached/synced value is missing.
    if (payrollClone || !address || !publicClient) return;
    let cancelled = false;

    (async () => {
      try {
        const existing = await publicClient.readContract({
          address:      CONTRACTS.MULTI_TOKEN_FACTORY,
          abi:          MULTI_TOKEN_FACTORY_ABI,
          functionName: 'payrollOf',
          args:         [address as `0x${string}`],
        }) as `0x${string}`;

        if (cancelled) return;
        if (existing && existing.toLowerCase() !== ZERO_ADDRESS) {
          dispatch({ type: 'SET_PAYROLL_CLONE', payload: existing });
        }
      } catch {
        /* Non-fatal — every page that calls this already handles a
           missing clone gracefully (free-tier / upgrade-to-premium
           paths), so a failed lookup here just means staying in that
           same state rather than silently recovering. Matches the
           registryClone self-healing effect's error handling right next
           to where this hook is called. */
      }
    })();

    return () => { cancelled = true; };
  }, [payrollClone, address, publicClient, dispatch]);
}
