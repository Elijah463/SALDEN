'use client';
/**
 * @file lib/usePayrollSync.ts
 *
 * Centralises the "does the employee/group/payroll-setup data on screen
 * match the latest on-chain-anchored IPFS snapshot?" concern, so every page
 * that needs employee data gets consistent behaviour — previously this only
 * existed inside dashboard/page.tsx, which meant a refresh on /ai-agent or
 * /transaction-history left employees/groups empty until the user visited
 * the dashboard at least once in that session.
 *
 * SaldenRegistry.sol anchors a single IPFS CID per organisation and exposes
 * both the full CID (getCID) and a cheap keccak256 hash of it (getCIDHash).
 * That hash is the real "is there a newer database?" signal this hook is
 * built around — it lets us check for staleness with a single cheap RPC
 * read, no wallet signature and no IPFS fetch, on every visit.
 *
 * Sequence once `registryClone` + `address` are known:
 *   1. hydrateFromCache() — instant, local IndexedDB only, no network,
 *      no signature. Paints whatever was cached from the last successful
 *      sync/load immediately, closing the "empty dashboard on refresh" gap.
 *   2. getCIDHash() — cheap on-chain read (no wallet popup) — compares the
 *      current anchor against the cached snapshot's hash.
 *      a. Hashes match           -> done, nothing else happens.
 *      b. Hashes differ + no     -> load silently (first-ever visit, or the
 *         visible data to lose      local cache was empty). Nothing to
 *                                   clobber, so no need to prompt.
 *      c. Hashes differ + there  -> do NOT overwrite silently — a teammate,
 *         IS data on screen         another device, or a scheduled AI-agent
 *                                   run may have anchored newer data while
 *                                   THIS tab also has local edits in flight.
 *                                   Sets `syncAvailable` so the UI can show
 *                                   a "Newer data available — Sync now"
 *                                   prompt; the actual load only happens
 *                                   when the user calls `syncNow()`.
 *   3. Re-checked on window focus (throttled) so a long-lived tab notices
 *      changes made elsewhere without requiring a hard refresh.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '@/context/AppContext';
import { REGISTRY_ABI } from '@/lib/contracts/abis';

export type PayrollSyncStatus = 'idle' | 'checking' | 'loading' | 'done' | 'error';

// Minimal structural shape — avoids coupling this file to a specific
// wagmi/viem generic version. Only the methods actually used are declared.
interface MinimalPublicClient {
  readContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }) => Promise<unknown>;
}
interface MinimalWalletClient {
  signMessage: (args: { message: string }) => Promise<string>;
}

interface UsePayrollSyncOpts {
  registryClone: string | null | undefined;
  address:       string | null | undefined;
  publicClient:  MinimalPublicClient | undefined;
  walletClient:  MinimalWalletClient | undefined;
  /** Minimum time between focus-triggered re-checks, in ms. Default 60s —
   *  frequent enough to catch real changes, cheap enough (one RPC read) to
   *  not matter if the user tabs back and forth a lot. */
  refocusThrottleMs?: number;
}

// bytes32(0) — what SaldenRegistry.getCIDHash() returns before any CID has
// ever been anchored for this organisation.
const ZERO_HASH = ('0x' + '0'.repeat(64)) as `0x${string}`;

export function usePayrollSync({
  registryClone, address, publicClient, walletClient, refocusThrottleMs = 60_000,
}: UsePayrollSyncOpts) {
  const { state, dispatch, hydrateFromCache, loadData, addToast } = useApp();
  const [status, setStatus] = useState<PayrollSyncStatus>('idle');
  const [currentCid, setCurrentCid] = useState<string | null>(null);
  const lastCheckedAt = useRef<number>(0);
  const inFlight      = useRef(false);

  // Identical sessionStorage key format to dashboard/page.tsx's own `sign`
  // helper (by design) — the two transparently share a cached signature
  // within the same tab instead of double-prompting the wallet.
  const sign = useCallback(async (msg: string): Promise<string> => {
    if (!walletClient || !address) throw new Error('No wallet');
    const storageKey = `salden_sig::${address.toLowerCase()}::${btoa(msg).slice(0, 32)}`;
    try {
      const cached = sessionStorage.getItem(storageKey);
      if (cached) return cached;
    } catch { /* sessionStorage blocked (private browsing edge cases) */ }
    const sig = await walletClient.signMessage({ message: msg });
    try { sessionStorage.setItem(storageKey, sig); } catch { /* ignore write errors */ }
    return sig;
  }, [walletClient, address]);

  const runCheck = useCallback(async () => {
    if (!registryClone || !address || !publicClient) return;
    if (inFlight.current) return;
    inFlight.current = true;
    lastCheckedAt.current = Date.now();
    setStatus('checking');

    try {
      // Step 1 — instant local paint, no network, no signature.
      const { hydrated, cid: cachedCid, cidHash: cachedHash } = await hydrateFromCache(address);
      if (cachedCid) setCurrentCid(cachedCid);

      // Step 2 — cheap on-chain freshness check.
      const onChainHash = await publicClient.readContract({
        address:      registryClone as `0x${string}`,
        abi:          REGISTRY_ABI,
        functionName: 'getCIDHash',
        args:         [],
      }) as `0x${string}`;

      if (!onChainHash || onChainHash === ZERO_HASH) {
        // Nothing anchored on-chain yet — nothing to sync.
        setStatus('done');
        return;
      }

      if (cachedHash && cachedHash.toLowerCase() === onChainHash.toLowerCase()) {
        // Local cache is already current — nothing to do.
        dispatch({ type: 'SET_SYNC_AVAILABLE', payload: { available: false, cid: null } });
        setStatus('done');
        return;
      }

      // Hashes differ (or there was no cache at all) — we need the actual
      // CID string before we can act on it.
      const cid = await publicClient.readContract({
        address:      registryClone as `0x${string}`,
        abi:          REGISTRY_ABI,
        functionName: 'getCID',
        args:         [],
      }) as string;
      if (!cid) { setStatus('done'); return; }

      const hasVisibleData = hydrated || state.employees.length > 0;

      if (!hasVisibleData) {
        // Nothing on screen to lose — load silently (first-ever visit, or
        // an empty local cache). This matches the previous dashboard-only
        // "load if empty" behaviour, now available on every page.
        if (!walletClient) { setStatus('done'); return; }
        setStatus('loading');
        const { loaded } = await loadData({ walletAddress: address, cid, signMessage: sign });
        setStatus('done');
        if (loaded) { setCurrentCid(cid); addToast('Restored your employee data.', 'success'); }
      } else {
        // There's already data on screen — do not silently overwrite it.
        // Surface the prompt and let the user decide via syncNow().
        dispatch({ type: 'SET_SYNC_AVAILABLE', payload: { available: true, cid } });
        setStatus('done');
      }
    } catch (err) {
      console.error('[usePayrollSync] Freshness check failed:', err);
      setStatus('error');
    } finally {
      inFlight.current = false;
    }
  }, [registryClone, address, publicClient, walletClient, hydrateFromCache, loadData, dispatch, sign, addToast, state.employees.length]);

  // Initial check once the registry clone + wallet are known.
  useEffect(() => {
    void runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registryClone, address, publicClient]);

  // Re-check on window focus (throttled) — catches changes made elsewhere
  // (another device, a teammate, a scheduled AI-agent run) without forcing
  // the user to hard-refresh a long-lived tab.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onFocus = () => {
      if (Date.now() - lastCheckedAt.current >= refocusThrottleMs) void runCheck();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [runCheck, refocusThrottleMs]);

  const syncNow = useCallback(async () => {
    if (!address || !state.pendingCid) return;
    setStatus('loading');
    try {
      const { loaded } = await loadData({ walletAddress: address, cid: state.pendingCid, signMessage: sign });
      setStatus('done');
      if (loaded) { setCurrentCid(state.pendingCid); addToast('Synced the latest payroll data.', 'success'); }
    } catch (err) {
      console.error('[usePayrollSync] syncNow failed:', err);
      setStatus('error');
      addToast('Sync failed — please try again.', 'warning');
    }
  }, [address, state.pendingCid, loadData, sign, addToast]);

  return {
    status,
    syncAvailable: state.syncAvailable,
    pendingCid:    state.pendingCid,
    currentCid,
    syncNow,
  };
}
