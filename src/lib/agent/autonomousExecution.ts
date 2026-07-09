/**
 * @file lib/agent/autonomousExecution.ts
 * SERVER-SIDE ONLY.
 *
 * Executes a batchPay directly from the AI Agent's own Circle-managed
 * wallet — no human wallet signature involved. This is ONLY safe to call
 * when the calling code (chat/route.ts) has already determined the user's
 * instruction was fully explicit; ambiguous instructions must go through
 * propose_unlisted_payment / propose_payroll_run instead, which hand off to
 * a human confirmation card signed by the EMPLOYER's own wallet.
 *
 * Verified against SaldenMultiTokenPayrollFactory.sol before writing this:
 *   - batchPay() pulls funds via
 *       SafeTransferLib.safeTransferFrom(payToken, msg.sender, address(this), totalPayroll)
 *     i.e. from WHOEVER CALLS IT, not from owner(). The `isAgent` role only
 *     grants permission to call batchPay — it does NOT grant access to the
 *     employer's funds. This means the agent pays from ITS OWN wallet
 *     balance, which is exactly the intended design (each user's agent has
 *     its own dedicated, separately-funded wallet — see the Agent Wallet
 *     page where the user tops it up).
 *   - The existing manual dashboard flow wraps batchPay's calldata through
 *     the Arc Memo contract's callWithMemo(target, data, memo, value), and
 *     that flow's own code comment confirms "msg.sender is preserved" by
 *     this wrapper. So the agent must ALSO route through callWithMemo
 *     (not call batchPay directly) for msg.sender inside batchPay to
 *     correctly resolve to the agent wallet's own address, and to keep the
 *     on-chain memo/receipt trail consistent with manual payments.
 *   - Since batchPay requires the CALLER to have already approved the
 *     payroll contract for the token amount, and the agent wallet is a
 *     separate address from the employer's, the agent wallet needs its own
 *     ERC-20 allowance against the payroll contract — this did not exist
 *     anywhere in the codebase before this file, so it's implemented here
 *     (lazy check-and-approve, once, to a generous ceiling — the actual
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

import { encodeFunctionData, formatUnits, parseUnits } from 'viem';
import { getServerPublicClient } from './chain';
import { executeContractCall, pollTxStatus, type TxResponse } from '@/lib/circle/agent-wallet';
import { requestFaucetDrip } from '@/lib/circle/faucet';
import { ERC20_ABI, MEMO_ABI, MEMO_CONTRACT_ADDRESS, MULTI_TOKEN_PAYROLL_ABI } from '@/lib/contracts/abis';

export interface AutonomousPayResult {
  ok:              boolean;
  txHash?:         string;
  /** true when the tx was submitted but not yet confirmed within our short
   *  poll window — not a failure, just still pending. */
  pending?:        boolean;
  error?:          string;
  faucetAttempted?: boolean;
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
  /** Unique per logical payment attempt — used to derive Circle idempotency
   *  keys for both the approve and batchPay calls so a retried request
   *  can't double-spend. */
  idempotencyKeyBase:   string;
}

// Generous fixed ceiling for the one-time allowance top-up — NOT the actual
// per-payment limit. Real spend limits (per-tx, per-day) are enforced by
// spendLimits.ts in chat/route.ts BEFORE this function is ever invoked; this
// number only avoids re-approving (and re-waiting on) a fresh allowance
// before every single autonomous payment.
export const ALLOWANCE_CEILING_USDC = '1000000';

// Short, bounded polls — see the timeout note in the file header. A tx that
// hasn't confirmed within this window is reported as `pending`, not failed.
const APPROVE_POLL_ATTEMPTS = 6;   // ~12s
const PAY_POLL_ATTEMPTS     = 8;   // ~16s
const POLL_INTERVAL_MS      = 2000;

async function pollWithBudget(txId: string, attempts: number): Promise<TxResponse | null> {
  try {
    return await pollTxStatus(txId, attempts, POLL_INTERVAL_MS);
  } catch {
    return null; // timed out within our budget — caller treats this as "pending", not failed
  }
}

export interface BalanceCheckResult {
  ok:              boolean;
  balance:         bigint;
  faucetAttempted: boolean;
  error?:          string;
}

/**
 * Reads the agent wallet's balance for `tokenAddress` and, if it's short of
 * `needed`, requests one testnet faucet drip and re-checks once. Shared by
 * both executeAutonomousTransfer and executeAutonomousBatchPay below (was
 * previously duplicated verbatim in each) and by the Inngest scheduled-
 * payment execution path (lib/inngest/functions.ts), which needs this same
 * check but drives its own submit/poll steps rather than calling all the
 * way through to executeAutonomousTransfer/BatchPay.
 */
export async function checkAndTopUpBalance(params: {
  agentWalletAddress: string;
  tokenAddress:       string;
  tokenDecimals:      number;
  needed:              bigint;
}): Promise<BalanceCheckResult> {
  const publicClient = getServerPublicClient();

  let balance: bigint;
  try {
    balance = await publicClient.readContract({
      address: params.tokenAddress as `0x${string}`, abi: ERC20_ABI,
      functionName: 'balanceOf', args: [params.agentWalletAddress as `0x${string}`],
    }) as bigint;
  } catch {
    return { ok: false, balance: 0n, faucetAttempted: false, error: 'Could not read the agent wallet\'s balance.' };
  }

  let faucetAttempted = false;
  if (balance < params.needed) {
    faucetAttempted = true;
    try { await requestFaucetDrip(params.agentWalletAddress); } catch { /* re-check regardless */ }
    await new Promise(r => setTimeout(r, 4000));
    try {
      balance = await publicClient.readContract({
        address: params.tokenAddress as `0x${string}`, abi: ERC20_ABI,
        functionName: 'balanceOf', args: [params.agentWalletAddress as `0x${string}`],
      }) as bigint;
    } catch { /* keep prior balance */ }

    if (balance < params.needed) {
      return {
        ok: false, balance, faucetAttempted,
        error: `The agent wallet only has ${formatUnits(balance, params.tokenDecimals)} but this payment needs ${formatUnits(params.needed, params.tokenDecimals)}, even after requesting testnet funds. Fund the agent wallet from the Agent Wallet page and try again.`,
      };
    }
  }

  return { ok: true, balance, faucetAttempted };
}

/**
 * Autonomous single-recipient payment. Unlike executeAutonomousBatchPay,
 * this is a direct ERC-20 transfer(to, amount) — it moves funds straight
 * from the agent wallet's own balance, so (unlike batchPay's transferFrom
 * pattern) NO allowance/approval step is needed at all. The memo is fired
 * as a separate, best-effort transaction to the Memo contract's own
 * address with an empty target — mirroring the exact pattern the existing
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
  const balanceCheck = await checkAndTopUpBalance({
    agentWalletAddress: params.agentWalletAddress,
    tokenAddress:        params.tokenAddress,
    tokenDecimals:       params.tokenDecimals,
    needed:              params.amount,
  });
  if (!balanceCheck.ok) return { ok: false, faucetAttempted: balanceCheck.faucetAttempted, error: balanceCheck.error };
  const faucetAttempted = balanceCheck.faucetAttempted;

  try {
    const tx = await executeContractCall({
      walletId:             params.agentWalletId,
      contractAddress:      params.tokenAddress,
      abiFunctionSignature: 'transfer(address,uint256)',
      abiParameters:        [params.recipient, params.amount.toString()],
      idempotencyKey:       `${params.idempotencyKeyBase}-transfer`,
    });

    const confirmed = await pollWithBudget(tx.id, PAY_POLL_ATTEMPTS);

    // Best-effort memo — fired after the real transfer, never blocks or
    // fails the payment result if it errors.
    try {
      const memoJson = JSON.stringify(params.memo);
      const memoHex  = (`0x${Buffer.from(memoJson, 'utf8').toString('hex')}`) as `0x${string}`;
      void MEMO_ABI;
      await executeContractCall({
        walletId:             params.agentWalletId,
        contractAddress:      MEMO_CONTRACT_ADDRESS,
        abiFunctionSignature: 'callWithMemo(address,bytes,bytes,uint256)',
        abiParameters:        ['0x0000000000000000000000000000000000000000', '0x', memoHex, '0'],
        idempotencyKey:       `${params.idempotencyKeyBase}-memo`,
      });
    } catch { /* memo is purely informational — never surface its failure */ }

    if (!confirmed) return { ok: true, pending: true, faucetAttempted, txHash: tx.txHash };
    if (confirmed.state === 'FAILED') return { ok: false, faucetAttempted, error: 'The payment transaction failed on-chain. No funds were moved.' };
    return { ok: true, txHash: confirmed.txHash, faucetAttempted };
  } catch (err) {
    return { ok: false, faucetAttempted, error: `Failed to execute the payment: ${(err as Error).message}` };
  }
}

export async function executeAutonomousBatchPay(params: AutonomousPayParams): Promise<AutonomousPayResult> {
  const publicClient = getServerPublicClient();
  const totalNeeded = params.amounts.reduce((sum, a) => sum + a, 0n);

  if (totalNeeded <= 0n || params.employees.length === 0) {
    return { ok: false, error: 'No valid recipients or amount to pay.' };
  }

  // ── 1. Balance check — the agent pays from its OWN wallet ────────────────
  const balanceCheck = await checkAndTopUpBalance({
    agentWalletAddress: params.agentWalletAddress,
    tokenAddress:        params.tokenAddress,
    tokenDecimals:       params.tokenDecimals,
    needed:              totalNeeded,
  });
  if (!balanceCheck.ok) return { ok: false, faucetAttempted: balanceCheck.faucetAttempted, error: balanceCheck.error };
  const faucetAttempted = balanceCheck.faucetAttempted;

  // ── 2. Allowance check — batchPay pulls via transferFrom(msg.sender, ...),
  //    so the AGENT wallet (not the employer) must approve the payroll
  //    contract directly. ──────────────────────────────────────────────────
  let allowance: bigint;
  try {
    allowance = await publicClient.readContract({
      address: params.tokenAddress as `0x${string}`, abi: ERC20_ABI,
      functionName: 'allowance',
      args: [params.agentWalletAddress as `0x${string}`, params.payrollCloneAddress as `0x${string}`],
    }) as bigint;
  } catch {
    return { ok: false, error: 'Could not read the agent wallet\'s token allowance.', faucetAttempted };
  }

  if (allowance < totalNeeded) {
    try {
      const approveTx = await executeContractCall({
        walletId:             params.agentWalletId,
        contractAddress:      params.tokenAddress,
        abiFunctionSignature: 'approve(address,uint256)',
        abiParameters:        [params.payrollCloneAddress, parseUnits(ALLOWANCE_CEILING_USDC, params.tokenDecimals).toString()],
        idempotencyKey:       `${params.idempotencyKeyBase}-approve`,
      });
      const confirmed = await pollWithBudget(approveTx.id, APPROVE_POLL_ATTEMPTS);
      if (!confirmed || confirmed.state !== 'CONFIRMED') {
        return {
          ok: false, faucetAttempted,
          error: 'The agent wallet\'s spending approval hasn\'t confirmed on-chain yet. Please ask me to try the payment again in a moment.',
        };
      }
    } catch (err) {
      return { ok: false, faucetAttempted, error: `Failed to approve the payroll contract to spend from the agent wallet: ${(err as Error).message}` };
    }
  }

  // ── 3. Execute batchPay via the Memo wrapper (preserves msg.sender as the
  //    agent wallet — see file header for why this must not call batchPay
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
    // with the manual flow — executeContractCall needs the signature as a
    // string, not the ABI array, since Circle's API takes a human-readable
    // signature rather than a JSON ABI fragment.
    void MEMO_ABI;

    const payTx = await executeContractCall({
      walletId:             params.agentWalletId,
      contractAddress:      MEMO_CONTRACT_ADDRESS,
      abiFunctionSignature: 'callWithMemo(address,bytes,bytes,uint256)',
      abiParameters:        [params.payrollCloneAddress, batchData, memoHex, '0'],
      idempotencyKey:       `${params.idempotencyKeyBase}-pay`,
    });

    const confirmed = await pollWithBudget(payTx.id, PAY_POLL_ATTEMPTS);
    if (!confirmed) {
      // Submitted, but didn't confirm within our short budget — this is NOT
      // a failure. Report the tx id so the caller can tell the user to
      // check status shortly (get_transaction_status once we have a hash).
      return { ok: true, pending: true, faucetAttempted, txHash: payTx.txHash };
    }
    if (confirmed.state === 'FAILED') {
      return { ok: false, faucetAttempted, error: 'The payment transaction failed on-chain. No funds were moved.' };
    }
    return { ok: true, txHash: confirmed.txHash, faucetAttempted };
  } catch (err) {
    return { ok: false, faucetAttempted, error: `Failed to execute the payment: ${(err as Error).message}` };
  }
}
