/**
 * @file lib/agent/agentPermissionCache.ts
 * SERVER-SIDE ONLY.
 *
 * Caches "this employer's agent wallet has been granted isAgent() on both
 * the payroll clone and the registry clone" once confirmed true on-chain,
 * so no future page load, on any browser, any device, needs to re-run
 * the on-chain isAgent() checks or show the permission wizard again.
 *
 * This is safe to treat as a pure UI optimization, not a security
 * boundary: the actual enforcement of "is this address really allowed to
 * call batchPay()/updateCID()" happens in the Solidity contracts
 * themselves (their own isAgent() modifier), on every real call,
 * regardless of what this cache says. If this cache were ever wrong (a
 * grant transaction failed after the client already marked it done, say),
 * the worst case is a transaction that reverts on-chain with a real,
 * decodable error (see lib/contracts/decodeError.ts), not an
 * unauthorised action actually going through.
 *
 * Stored in KV only. A read failure returns false, so the caller runs its
 * own on-chain check instead of trusting a cache it can't read.
 */

import { kvGetStrict, kvSet, kvAvailable } from '@/lib/kv';

function kvKey(walletAddress: string): string {
  return `agentPermissionsGranted:${walletAddress.toLowerCase()}`;
}

/** True only once both on-chain grants have been confirmed and recorded.
 *  False otherwise, including when the store cannot be read. */
export async function getAgentPermissionsGranted(walletAddress: string): Promise<boolean> {
  try {
    return (await kvGetStrict<boolean>(kvKey(walletAddress))) === true;
  } catch {
    return false;
  }
}

/** Records a confirmed grant. Returns false if it could not be saved; the next
 *  check then simply runs on-chain again. */
export async function markAgentPermissionsGranted(walletAddress: string): Promise<boolean> {
  if (!kvAvailable()) return false;
  return kvSet(kvKey(walletAddress), true);
}
