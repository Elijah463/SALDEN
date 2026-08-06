/**
 * @file lib/txReceipt.ts
 *
 * viem's publicClient.waitForTransactionReceipt() resolves successfully
 * once a transaction is MINED — including when it reverted on-chain. It
 * only REJECTS on a timeout or network/RPC error. The receipt it returns
 * has its own `status` field ('success' | 'reverted') that has to be
 * checked explicitly; nothing does that automatically.
 *
 * This codebase was calling waitForTransactionReceipt() at ~12 call sites
 * and, in several of them, immediately marking the operation as
 * successful afterward — without ever reading `receipt.status`. A batchPay
 * (or any other write) that reverted on-chain would still resolve that
 * await, and the surrounding code would report success anyway. That's
 * the root cause of "the blockchain rejected it but the app said it
 * worked."
 *
 * Use this everywhere a receipt is awaited and the result determines
 * what the user is told. Throws a clear, catchable error on revert so it
 * flows straight into each call site's existing catch/error-state
 * handling — no new error-handling pattern needed anywhere that already
 * wraps its logic in try/catch.
 */

import type { PublicClient, TransactionReceipt } from 'viem';
import { WaitForTransactionReceiptTimeoutError } from 'viem';

// Arc's public testnet RPC intermittently rate-limits (HTTP 429) under load.
// Without a bounded timeout here, a rate-limited poll loop can leave this
// await pending for viem's full default window (several minutes on some
// chains), which is what was showing up as: the "Confirming on-chain…"
// setup modal stuck indefinitely, Settings > Save Profile never showing a
// success (or even a failure) toast, and the payment execution modal
// appearing to hang with no progress — in every case the transaction had
// often already landed on-chain; the app just never found out because the
// receipt poll itself was starved. 45s is generous for Arc's normal block
// time plus a few rate-limited retries, while still giving the person a
// clear, timely message instead of an indefinite silent wait.
const RECEIPT_TIMEOUT_MS = 45_000;

export async function waitForSuccessfulReceipt(
  publicClient: PublicClient,
  hash: `0x${string}`,
): Promise<TransactionReceipt> {
  let receipt: TransactionReceipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: RECEIPT_TIMEOUT_MS,
      pollingInterval: 2_500,
    });
  } catch (err) {
    if (err instanceof WaitForTransactionReceiptTimeoutError) {
      throw new Error(
        `Still waiting for the network to confirm this transaction (${hash}). It may still land — check the block explorer in a moment before retrying, to avoid sending it twice.`,
      );
    }
    throw err;
  }
  if (receipt.status !== 'success') {
    throw new Error(
      `Transaction reverted on-chain (${hash}). No funds moved — check the block explorer for the exact revert reason before retrying.`,
    );
  }
  return receipt;
}
