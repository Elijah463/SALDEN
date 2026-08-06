/**
 * @file lib/useRegistryCloneAccess.ts
 * CLIENT-SIDE.
 *
 * Self-healing lookup for `registryClone` (the employer's deployed
 * SaldenRegistry contract address) — every account gets one of these
 * regardless of free/premium tier, unlike `payrollClone` (see
 * lib/useCloneAccess.ts, which this file mirrors exactly).
 *
 * dashboard/page.tsx and ai-agent/page.tsx already each carry their own
 * inline version of this exact check (cache-first via
 * lib/serverCloneCache.ts, then an on-chain getRegistry() fallback with
 * retries) — this file does NOT replace those; they carry extra
 * page-specific state (the onboarding-CTA gating, registryStatus) not
 * worth the regression risk of refactoring right now.
 *
 * What this file is for: every OTHER page that reads
 * state.registryClone but never had any version of this check —
 * Settings' Contract Information tile and Compliance's Registry Sync
 * check both just trusted state.registryClone blindly, which stays null
 * (hiding both address rows / showing "No registry clone deployed") for
 * anyone who lands there without first visiting a page that resolves it
 * — e.g. a fresh browser/device, or opening Settings straight from a
 * bookmark. Usage: call `useRegistryCloneAccess()` once per page that
 * needs this (no arguments) — it writes into AppContext via SET_REGISTRY;
 * callers keep reading `state.registryClone` exactly as before.
 */

import { useEffect, useRef } from 'react';
import { usePublicClient } from 'wagmi';
import { useApp } from '@/context/AppContext';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { CONTRACTS, arcTestnet } from '@/lib/contracts/config';
import { REGISTRY_FACTORY_ABI } from '@/lib/contracts/abis';
import { readCloneCache, writeCloneCache } from '@/lib/cloneCache';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function useRegistryCloneAccess(): void {
  const { state, dispatch } = useApp();
  const { registryClone } = state;
  const { address } = useEffectiveAddress();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  // Guards against re-running this lookup on every render once it's been
  // attempted — an exhausted, still-empty result stays that way until a
  // fresh mount rather than retrying in a loop.
  const attempted = useRef(false);

  useEffect(() => {
    if (registryClone || !address || !publicClient || attempted.current) return;
    attempted.current = true;
    let cancelled = false;
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 1200;

    (async () => {
      try {
        const cached = await readCloneCache(address);
        if (cancelled) return;
        if (cached.registryClone) {
          dispatch({ type: 'SET_REGISTRY', payload: cached.registryClone });
          return;
        }
      } catch { /* cache is best-effort — fall through to the on-chain check */ }

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const existing = await publicClient.readContract({
            address:      CONTRACTS.REGISTRY_FACTORY,
            abi:          REGISTRY_FACTORY_ABI,
            functionName: 'getRegistry',
            args:         [address as `0x${string}`],
          }) as `0x${string}`;

          if (cancelled) return;
          if (existing && existing.toLowerCase() !== ZERO_ADDRESS) {
            dispatch({ type: 'SET_REGISTRY', payload: existing });
            writeCloneCache(address, { registryClone: existing });
          }
          return;
        } catch (err) {
          if (cancelled) return;
          if (attempt < MAX_ATTEMPTS) {
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            continue;
          }
          // Non-fatal after retries — same reasoning as useCloneAccess.ts's
          // identical catch: every caller already handles a missing
          // registryClone gracefully, so an exhausted lookup just leaves
          // it null rather than surfacing a hard error.
          console.warn('[useRegistryCloneAccess] getRegistry check failed after retries:', err);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [registryClone, address, publicClient, dispatch]);
}
