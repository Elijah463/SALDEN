/**
 * @file lib/contracts/batchLimits.ts
 * Recipient-per-transaction caps, verified 1:1 against the deployed
 * contracts (contracts/SaldenEnterprisePayroll.sol and
 * contracts/SaldenMultiTokenPayrollFactory.sol) — both revert on-chain
 * with a `BatchTooLarge(provided, max)` custom error above these counts.
 *
 * A payroll run with more recipients than the active contract's cap must
 * be split into sequential batchPay calls of at most this many recipients
 * each — used by both the manual "Process Payment" flow
 * (app/dashboard/page.tsx) and the AI agent's payroll-run proposal
 * (components/agent/AgentConfirmationCards.tsx) so the two stay in sync
 * rather than each hardcoding their own copy.
 *
 * These are Solidity `constant`s compiled into the contract bytecode —
 * they cannot change for an already-deployed contract, so hardcoding them
 * here (rather than reading MAX_BATCH_SIZE() on-chain before every run) is
 * safe and avoids one more RPC round trip on an already RPC-sensitive path.
 */

/** SaldenEnterprisePayroll.MAX_BATCH_SIZE — the free-tier standalone contract. */
export const STANDALONE_MAX_BATCH_SIZE = 100;

/** SaldenMultiTokenPayrollFactory clone's MAX_BATCH_SIZE — the premium per-employer contract. */
export const CLONE_MAX_BATCH_SIZE = 1_000;

/** Splits a list of recipients into sequential chunks no larger than the
 *  active contract's cap. `isClone` selects which cap applies. */
export function chunkForBatchPay<T>(items: T[], isClone: boolean): T[][] {
  const size = isClone ? CLONE_MAX_BATCH_SIZE : STANDALONE_MAX_BATCH_SIZE;
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
