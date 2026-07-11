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

export async function waitForSuccessfulReceipt(
  publicClient: PublicClient,
  hash: `0x${string}`,
): Promise<TransactionReceipt> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(
      `Transaction reverted on-chain (${hash}). No funds moved — check the block explorer for the exact revert reason before retrying.`,
    );
  }
  return receipt;
}
