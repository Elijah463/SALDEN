/**
 * @file lib/agent/agentPermissionCache.ts
 * SERVER-SIDE ONLY.
 *
 * Caches "this employer's agent wallet has been granted isAgent() on both
 * the payroll clone and the registry clone" once confirmed true on-chain,
 * so no future page load — on any browser, any device — needs to re-run
 * the on-chain isAgent() checks or show the permission wizard again.
 *
 * This is safe to treat as a pure UI optimization, not a security
 * boundary: the actual enforcement of "is this address really allowed to
 * call batchPay()/updateCID()" happens in the Solidity contracts
 * themselves (their own isAgent() modifier), on every real call,
 * regardless of what this cache says. If this cache were ever wrong (a
 * grant transaction failed after the client already marked it done, say),
 * the worst case is a transaction that reverts on-chain with a real,
 * decodable error (see lib/contracts/decodeError.ts) — not an
 * unauthorised action actually going through.
 *
 * Same storage pattern as employerLimits.ts / agentMode.ts.
 */

import { kvGet, kvSet, kvAvailable } from '@/lib/kv';

const _memory = new Map<string, boolean>();

function memKey(walletAddress: string): string {
  return walletAddress.toLowerCase();
}

function kvKey(walletAddress: string): string {
  return `agentPermissionsGranted:${memKey(walletAddress)}`;
}

/** Returns true only once both on-chain grants have been confirmed and
 *  recorded via markAgentPermissionsGranted() below — false otherwise
 *  (including "never checked"), so the caller still runs its own
 *  on-chain verification the first time. */
export async function getAgentPermissionsGranted(walletAddress: string): Promise<boolean> {
  const key = memKey(walletAddress);
  if (_memory.get(key)) return true;

  if (kvAvailable()) {
    const stored = await kvGet<boolean>(kvKey(walletAddress));
    if (stored === true) {
      _memory.set(key, true);
      return true;
    }
  }
  return false;
}

export async function markAgentPermissionsGranted(walletAddress: string): Promise<void> {
  const key = memKey(walletAddress);
  _memory.set(key, true);
  await kvSet(kvKey(walletAddress), true);
}
