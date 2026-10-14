/**
 * @file lib/agent/autonomousExecution.ts
 * SERVER-SIDE ONLY.
 *
 * Executes a batchPay directly from the AI Agent's own Circle-managed
 * wallet, no human wallet signature involved. This is ONLY safe to call
 * when the calling code (chat/route.ts) has already determined the user's
 * instruction was fully explicit; ambiguous instructions must go through
 * propose_unlisted_payment / propose_payroll_run instead, which hand off to
 * a human confirmation card signed by the EMPLOYER's own wallet.
 *
 * Verified against SaldenMultiTokenPayrollFactory.sol before writing this:
 *   - batchPay() pulls funds via
 *       SafeTransferLib.safeTransferFrom(payToken, msg.sender, address(this), totalPayroll)
 *     i.e. from WHOEVER CALLS IT, not from owner(). The `isAgent` role only
 *     grants permission to call batchPay, it does NOT grant access to the
 *     employer's funds. This means the agent pays from ITS OWN wallet
 *     balance, which is exactly the intended design (each user's agent has
 *     its own dedicated, separately-funded wallet, see the Agent Wallet
 *     page where the user tops it up).
 *   - The existing manual dashboard flow wraps batchPay's calldata through
 *     the Arc Memo contract's memo(target, data, memoId, memoData), see
 *     lib/contracts/abis.ts for why this is `memo`, not `callWithMemo`
 *     (an earlier version of this codebase had the wrong function name,
 *     which reverted on every call since it doesn't exist on the real
 *     contract), and that flow's own code comment confirms "msg.sender
 *     is preserved" by this wrapper. So the agent must ALSO route through
 *     the Memo contract (not call batchPay directly) for msg.sender
 *     inside batchPay to correctly resolve to the agent wallet's own
 *     address, and to keep the on-chain memo/receipt trail consistent
 *     with manual payments.
 *   - Since batchPay requires the CALLER to have already approved the
 *     payroll contract for the token amount, and the agent wallet is a
 *     separate address from the employer's, the agent wallet needs its own
 *     ERC-20 allowance against the payroll contract, this did not exist
 *     anywhere in the codebase before this file, so it's implemented here
 *     (lazy check-and-approve, once, to a generous ceiling, the actual
 *     per-payment and per-day caps are enforced off-chain by spendLimits.ts
 *     BEFORE this function is ever called, not by the on-chain allowance).
 *
 * Timeout note: this function polls for on-chain confirmation, which can
 * take longer than a default Vercel serverless function timeout (10s on
 * Hobby). The route calling this MUST export `maxDuration` (see
 * app/api/agent/chat/route.ts) and this module intentionally uses short,
 * bounded polling windows rather than the library default (60s) so a slow
 * confirmation degrades to "submitted, still confirming" instead of
 * blocking the whole chat response indefinitely.
 */

import { encodeFunctionData, formatUnits, keccak256 } from 'viem';
import { getServerPublicClient } from './chain';
import { executeContractCall, pollTxStatus, type TxResponse } from '@/lib/circle/agent-wallet';
import { isCircleTxSuccess } from '@/lib/circle/txState';
import { ERC20_ABI, MEMO_ABI, MEMO_CONTRACT_ADDRESS, MULTI_TOKEN_PAYROLL_ABI } from '@/lib/contracts/abis';
import { arcChain } from '@/lib/contracts/config';
import { getCachedApproval, setCachedApproval, invalidateCachedApproval } from '@/lib/approvals/approvalCache';

export interface AutonomousPayResult {
  ok:              boolean;
  txHash?:         string;
  /** true when the tx was submitted but not yet confirmed within our short
   *  poll window, not a failure, just still pending. */
  pending?:        boolean;
  /** Circle's own transaction id, present whenever `pending` is true, so
   *  the caller (chat/route.ts) can pass it to the client, which can keep
   *  checking /api/agent/tx-status on its own schedule after this chat
   *  turn's response has already been sent. Without this, a pending
   *  result had no way to ever be revisited, see this file's header and
   *  app/api/agent/tx-status/route.ts. */
  transactionId?:  string;
  error?:          string;
}

interface AutonomousPayParams {
  agentWalletId:        string;
  agentWalletAddress:   string;
  payrollCloneAddress:  string;
  employees:            string[];   // checksummed addresses
  amounts:              bigint[];   // raw token units, same order as employees
  tokenAddress:         string;
  tokenDecimals:        number;
  memo:                 Record<string, unknown>;
  /** Unique per logical payment attempt, used to derive Circle idempotency
   *  keys for both the approve and batchPay calls so a retried request
   *  can't double-spend. */
  idempotencyKeyBase:   string;
}


// Short, bounded polls, see the timeout note in the file header. A tx that
// hasn't confirmed within this window is reported as `pending`, not failed.
const APPROVE_POLL_ATTEMPTS = 6;   // ~12s
const PAY_POLL_ATTEMPTS     = 8;   // ~16s
const POLL_INTERVAL_MS      = 2000;

async function pollWithBudget(txId: string, attempts: number): Promise<TxResponse | null> {
  try {
    return await pollTxStatus(txId, attempts, POLL_INTERVAL_MS);
  } catch {
    return null; // timed out within our budget, caller treats this as "pending", not failed
  }
}

export interface BalanceCheckResult {
  ok:      boolean;
  balance: bigint;
  error?:  string;
}

/**
 * Reads the agent wallet's balance for `tokenAddress` and reports whether it
 * covers `needed`. Shared by both autonomous execution paths and the Inngest
 * scheduled-payment path. There is no automatic top-up: mainnet funds must be
 * sent by the employer, so a shortfall is reported, not patched over.
 */
export async function checkAgentBalance(params: {
  agentWalletAddress: string;
  tokenAddress:       string;
  tokenDecimals:      number;
  needed:             bigint;
}): Promise<BalanceCheckResult> {
  const publicClient = getServerPublicClient();

  let balance: bigint;
  try {
    balance = await publicClient.readContract({
      address: params.tokenAddress as `0x${string}`, abi: ERC20_ABI,
      functionName: 'balanceOf', args: [params.agentWalletAddress as `0x${string}`],
    }) as bigint;
  } catch {
    return { ok: false, balance: 0n, error: 'Could not read the agent wallet\'s balance.' };
  }

  if (balance < params.needed) {
    return {
      ok: false, balance,
      error: `The agent wallet only has ${formatUnits(balance, params.tokenDecimals)} but this payment needs ${formatUnits(params.needed, params.tokenDecimals)}. Fund the agent wallet from the Agent Wallet page and try again.`,
    };
  }

  return { ok: true, balance };
}

/**
 * Autonomous single-recipient payment. Unlike executeAutonomousBatchPay,
 * this is a direct ERC-20 transfer(to, amount), it moves funds straight
 * from the agent wallet's own balance, so (unlike batchPay's transferFrom
 * pattern) NO allowance/approval step is needed at all. The memo is fired
 * as a separate, best-effort transaction to the Memo contract's own
 * address with an empty target, mirroring the exact pattern the existing
 * manual wallet/send/page.tsx already uses for plain sends (as opposed to
 * batchPay, which wraps the real call through the Memo contract). A memo
 * failure must never block or fail the actual payment.
 */
export async function executeAutonomousTransfer(params: {
  agentWalletId:      string;
  agentWalletAddress: string;
  recipient:          string;
  amount:             bigint;
  tokenAddress:       string;
  tokenDecimals:      number;
  memo:               Record<string, unknown>;
  idempotencyKeyBase: string;
}): Promise<AutonomousPayResult> {
  const balanceCheck = await checkAgentBalance({
    agentWalletAddress: params.agentWalletAddress,
    tokenAddress:        params.tokenAddress,
    tokenDecimals:       params.tokenDecimals,
    needed:              params.amount,
  });
  if (!balanceCheck.ok) return { ok: false, error: balanceCheck.error };

  try {
    const tx = await executeContractCall({
      walletId:             params.agentWalletId,
      contractAddress:      params.tokenAddress,
      abiFunctionSignature: 'transfer(address,uint256)',
      abiParameters:        [params.recipient, params.amount.toString()],
      idempotencyKey:       `${params.idempotencyKeyBase}-transfer`,
    });

    const confirmed = await pollWithBudget(tx.id, PAY_POLL_ATTEMPTS);

    // Best-effort memo, fired after the real transfer, never blocks or
    // fails the payment result if it errors.
    try {
      const memoJson = JSON.stringify(params.memo);
      const memoHex  = (`0x${Buffer.from(memoJson, 'utf8').toString('hex')}`) as `0x${string}`;
      void MEMO_ABI;
      await executeContractCall({
        walletId:             params.agentWalletId,
        contractAddress:      MEMO_CONTRACT_ADDRESS,
        abiFunctionSignature: 'memo(address,bytes,bytes32,bytes)',
        abiParameters:        ['0x0000000000000000000000000000000000000000', '0x', keccak256(memoHex), memoHex],
        idempotencyKey:       `${params.idempotencyKeyBase}-memo`,
      });
    } catch { /* memo is purely informational, never surface its failure */ }

    if (!confirmed) return { ok: true, pending: true, txHash: tx.txHash, transactionId: tx.id };
    if (confirmed.state === 'FAILED') return { ok: false, error: 'The payment transaction failed on-chain. No funds were moved.' };
    return { ok: true, txHash: confirmed.txHash };
  } catch (err) {
    return { ok: false, error: `Failed to execute the payment: ${(err as Error).message}` };
  }
}

/** Live allowance the agent wallet has granted the payroll contract for this token. */
async function readOnchainAllowance(params: AutonomousPayParams): Promise<bigint> {
  return await getServerPublicClient().readContract({
    address: params.tokenAddress as `0x${string}`, abi: ERC20_ABI,
    functionName: 'allowance',
    args: [params.agentWalletAddress as `0x${string}`, params.payrollCloneAddress as `0x${string}`],
  }) as bigint;
}

/**
 * Cache-first allowance lookup (keeps the approval cache's purpose: no
 * repeated approves). A cache entry is trusted and used directly. A miss is
 * seeded from the chain so the cache starts from the real value. Every batchPay
 * then keeps the entry accurate: success subtracts the spent amount, and any
 * uncertain outcome invalidates it so the next payment re-reads the chain.
 */
async function resolveAllowance(params: AutonomousPayParams): Promise<bigint> {
  const cached = await getCachedApproval(
    arcChain.id, params.agentWalletAddress, params.tokenAddress, params.payrollCloneAddress
  );
  if (cached.updatedAt > 0) return cached.amount;
  const live = await readOnchainAllowance(params);
  await setCachedApproval(arcChain.id, params.agentWalletAddress, params.tokenAddress, params.payrollCloneAddress, live);
  return live;
}

async function syncCacheAfterPay(params: AutonomousPayParams, spent: bigint, allowanceBefore: bigint, succeeded: boolean) {
  if (succeeded) {
    const remaining = allowanceBefore > spent ? allowanceBefore - spent : 0n;
    await setCachedApproval(arcChain.id, params.agentWalletAddress, params.tokenAddress, params.payrollCloneAddress, remaining);
  } else {
    await invalidateCachedApproval(arcChain.id, params.agentWalletAddress, params.tokenAddress, params.payrollCloneAddress);
  }
}

export async function executeAutonomousBatchPay(params: AutonomousPayParams): Promise<AutonomousPayResult> {
  const totalNeeded = params.amounts.reduce((sum, a) => sum + a, 0n);

  if (totalNeeded <= 0n || params.employees.length === 0) {
    return { ok: false, error: 'No valid recipients or amount to pay.' };
  }

  // ── 1. Balance check, the agent pays from its OWN wallet ────────────────
  const balanceCheck = await checkAgentBalance({
    agentWalletAddress: params.agentWalletAddress,
    tokenAddress:        params.tokenAddress,
    tokenDecimals:       params.tokenDecimals,
    needed:              totalNeeded,
  });
  if (!balanceCheck.ok) return { ok: false, error: balanceCheck.error };

  // ── 2. Allowance check, batchPay pulls via transferFrom(msg.sender, ...)
  //    so the AGENT wallet (not the employer) must approve the payroll
  //    contract directly. Uses the same unified approval cache every other
  //    approval flow in the app now uses (lib/approvals/approvalCache.ts)
  //    instead of a live on-chain read, this agent wallet's own address is
  //    naturally a distinct cache key from any human user's wallet, so
  //    there's no risk of this colliding with a different flow's entry. ──
  // Read the live on-chain allowance, not a cached value. transferFrom reduces
  // the allowance on every batchPay, so a cached "approved" amount goes stale
  // and the next batchPay would revert once cumulative spend passes the ceiling.
  const allowance = await resolveAllowance(params);
  // The allowance this payment actually runs against: the approve below raises it to the ceiling.
  let effectiveAllowance = allowance;

  if (allowance < totalNeeded) {
    try {
      // Approve exactly what this payment needs. The approval cache then skips
      // future approves while the approved amount still covers them.
      const approveAmount = totalNeeded;
      const approveTx = await executeContractCall({
        walletId:             params.agentWalletId,
        contractAddress:      params.tokenAddress,
        abiFunctionSignature: 'approve(address,uint256)',
        abiParameters:        [params.payrollCloneAddress, approveAmount.toString()],
        idempotencyKey:       `${params.idempotencyKeyBase}-approve`,
      });
      const confirmed = await pollWithBudget(approveTx.id, APPROVE_POLL_ATTEMPTS);
      if (!confirmed || !isCircleTxSuccess(confirmed.state)) {
        await invalidateCachedApproval(arcChain.id, params.agentWalletAddress, params.tokenAddress, params.payrollCloneAddress);
        return {
          ok: false, error: 'The agent wallet\'s spending approval hasn\'t confirmed on-chain yet. Please ask me to try the payment again in a moment.'
        };
      }
      // Cache only what is confirmed on-chain, so a failed approve can never
      // make a later payment skip an approval it still needs.
      await setCachedApproval(arcChain.id, params.agentWalletAddress, params.tokenAddress, params.payrollCloneAddress, approveAmount);
      effectiveAllowance = approveAmount;
    } catch (err) {
      await invalidateCachedApproval(arcChain.id, params.agentWalletAddress, params.tokenAddress, params.payrollCloneAddress);
      return { ok: false, error: `Failed to approve the payroll contract to spend from the agent wallet: ${(err as Error).message}` };
    }
  }

  // ── 3. Execute batchPay via the Memo wrapper (preserves msg.sender as the
  //    agent wallet, see file header for why this must not call batchPay
  //    directly). ────────────────────────────────────────────────────────
  try {
    const memoJson = JSON.stringify(params.memo);
    const memoHex  = (`0x${Buffer.from(memoJson, 'utf8').toString('hex')}`) as `0x${string}`;
    const batchData = encodeFunctionData({
      abi: MULTI_TOKEN_PAYROLL_ABI,
      functionName: 'batchPay',
      args: [params.employees as `0x${string}`[], params.amounts, params.tokenAddress as `0x${string}`],
    });

    // MEMO_ABI is referenced here only for documentation/type-consistency
    // with the manual flow, executeContractCall needs the signature as a
    // string, not the ABI array, since Circle's API takes a human-readable
    // signature rather than a JSON ABI fragment.
    void MEMO_ABI;

    const payTx = await executeContractCall({
      walletId:             params.agentWalletId,
      contractAddress:      MEMO_CONTRACT_ADDRESS,
      abiFunctionSignature: 'memo(address,bytes,bytes32,bytes)',
      abiParameters:        [params.payrollCloneAddress, batchData, keccak256(memoHex), memoHex],
      idempotencyKey:       `${params.idempotencyKeyBase}-pay`,
    });

    const confirmed = await pollWithBudget(payTx.id, PAY_POLL_ATTEMPTS);
    // Success subtracts what was spent. Failure or an unconfirmed result
    // invalidates the entry, so the next payment re-reads the chain instead
    // of trusting a number that may now be wrong.
    await syncCacheAfterPay(params, totalNeeded, effectiveAllowance, !!confirmed && confirmed.state !== 'FAILED');
    if (!confirmed) {
      // Submitted, but didn't confirm within our short budget, this is NOT
      // a failure. Report the tx id so the caller can tell the user to
      // check status shortly (get_transaction_status once we have a hash),
      // and so the client can keep polling this specific transaction after
      // this chat turn's response has already gone out, see
      // app/api/agent/tx-status/route.ts.
      return { ok: true, pending: true, txHash: payTx.txHash, transactionId: payTx.id };
    }
    if (confirmed.state === 'FAILED') {
      return { ok: false, error: 'The payment transaction failed on-chain. No funds were moved.' };
    }
    return { ok: true, txHash: confirmed.txHash };
  } catch (err) {
    await syncCacheAfterPay(params, totalNeeded, effectiveAllowance, false);
    return { ok: false, error: `Failed to execute the payment: ${(err as Error).message}` };
  }
}
