/**
 * @file lib/agent/agentIdentity.ts
 * SERVER-SIDE ONLY.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * Audit finding (critical): app/api/agent/chat/route.ts used to take
 * `context.agentWalletId`, `context.agentAddress`, and `context.payrollClone`
 * directly from the request body and hand them to executeAutonomousTransfer /
 * executeAutonomousBatchPay. The session token proves the caller controls
 * `walletAddress` — it never proved those other three fields actually
 * belonged to that wallet. Anyone with a valid session for their OWN wallet
 * could supply someone else's agentWalletId/payrollClone in the request body
 * and have that victim's agent wallet execute a payment to an address of the
 * attacker's choosing. This file removes that trust boundary entirely by
 * having the server derive both values itself, from facts it can verify
 * independently of anything the client sends:
 *
 *   - agentWalletId  → looked up from Circle via the SAME deterministic
 *                       refId the server used when creating the wallet
 *                       (see activate/route.ts). Circle is the source of
 *                       truth; the client's claim is never consulted.
 *   - payrollClone   → read directly from the on-chain factory's
 *                       `payrollOf(employer)` view function. The chain is
 *                       the source of truth; again, the client's claim is
 *                       never consulted.
 *
 * Every call site that used to read context.agentWalletId / agentAddress /
 * payrollClone for anything that moves money (execute_payment,
 * execute_payroll_run, the cron executor, schedule/sync) must go through
 * resolveAgentWallet() / resolvePayrollClone() instead. context.agentAddress
 * is still fine to use for purely informational purposes (e.g. what the
 * system prompt tells the model the agent's address is) since nothing bad
 * happens if that string is wrong — it only becomes a problem the moment
 * it's used to decide where money goes.
 */

import { getAddress, zeroAddress } from 'viem';
import { getServerPublicClient } from './chain';
import { CONTRACTS } from '@/lib/contracts/config';
import { MULTI_TOKEN_FACTORY_ABI } from '@/lib/contracts/abis';
import { getAgentWalletByRefId } from '@/lib/circle/agent-wallet';

/** Same derivation used in app/api/agent/activate/route.ts when the wallet
 *  was first created — kept here as the single source of truth for the
 *  formula so the two never drift apart. */
export function agentWalletRefId(walletAddress: string): string {
  return `salden-agent-${walletAddress.toLowerCase()}`;
}

export interface ResolvedAgentWallet {
  walletId: string;
  address: `0x${string}`;
}

/** Returns null if the employer has no active agent wallet — callers should
 *  treat that exactly like the old "agent wallet is not active" failure
 *  path, not as an unexpected error. */
export async function resolveAgentWallet(walletAddress: string): Promise<ResolvedAgentWallet | null> {
  try {
    const wallet = await getAgentWalletByRefId(agentWalletRefId(walletAddress));
    if (!wallet) return null;
    if (wallet.state !== 'LIVE') return null; // e.g. still PENDING or FROZEN — not safe to use yet
    return { walletId: wallet.walletId, address: getAddress(wallet.address) };
  } catch {
    return null;
  }
}

/** Returns null if this employer has no deployed payroll clone. Reads
 *  on-chain, so this is always up to date with reality — no stale cache,
 *  no possibility of the client lying about which clone it "should" be. */
export async function resolvePayrollClone(walletAddress: string): Promise<`0x${string}` | null> {
  try {
    const publicClient = getServerPublicClient();
    const clone = await publicClient.readContract({
      address:      CONTRACTS.MULTI_TOKEN_FACTORY,
      abi:          MULTI_TOKEN_FACTORY_ABI,
      functionName: 'payrollOf',
      args:         [getAddress(walletAddress)],
    }) as `0x${string}`;

    if (!clone || clone.toLowerCase() === zeroAddress.toLowerCase()) return null;
    return getAddress(clone);
  } catch {
    return null;
  }
}
