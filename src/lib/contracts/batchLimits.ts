/**
 * @file lib/contracts/batchLimits.ts
 * Recipient-per-transaction caps, verified against the deployed contracts
 * (contracts/SaldenEnterprisePayroll.sol and
 * contracts/SaldenMultiTokenPayrollFactory.sol) — both revert on-chain
 * with a `BatchTooLarge(provided, max)` custom error above the contract's
 * own `MAX_BATCH_SIZE`.
 *
 * A payroll run with more recipients than the active batch cap must be
 * split into sequential batchPay calls of at most that many recipients
 * each — used by both the manual "Process Payment" flow
 * (app/dashboard/page.tsx) and the AI agent's payroll-run proposal
 * (components/agent/AgentConfirmationCards.tsx) so the two stay in sync
 * rather than each hardcoding their own copy.
 *
 * ── CLONE_MAX_BATCH_SIZE is intentionally LOWER than the contract's own
 *    MAX_BATCH_SIZE (1,000) — this was the actual cause of premium-tier
 *    batches reverting ──────────────────────────────────────────────────
 * SaldenMultiTokenPayroll.sol's own header comment documents Arc Network's
 * block gas limit as 30,000,000, and calculates a full 1,000-recipient
 * batchPay at ≈50,000 (cold safeTransferFrom) + 1,000 × 32,000 (warm
 * safeTransfer) ≈ 32.05M gas — which is ABOVE that 30M limit, not below
 * it (the comment's own "must be ≥ 33M" conclusion doesn't match the 30M
 * figure two lines above it). The contract's on-chain `MAX_BATCH_SIZE`
 * check only validates the recipient *count* — it has no way to enforce
 * an actual block-gas ceiling, so nothing on-chain stops a caller from
 * submitting a batch that passes that check but still can't fit in a
 * block. That's exactly what was happening: a premium batch anywhere
 * close to 1,000 recipients passed the contract's own size check and
 * then reverted from exceeding the real block gas limit — free tier
 * never showed this, since its 100-recipient cap only needs ≈3.25M gas,
 * nowhere near the ceiling.
 *
 * Recalculating against the contract's own 30M figure: (30,000,000 −
 * 50,000) / 32,000 ≈ 935 is the actual theoretical maximum — and that
 * doesn't yet include the Memo contract wrapper's own overhead (every
 * payroll call is wrapped in memo(target, data, memoId, memoData) — see
 * dashboard/page.tsx and AgentConfirmationCards.tsx), which adds calldata
 * and external-call cost on top of batchPay's own internals, or normal
 * gas-estimation variance. 800 leaves a deliberate safety margin under
 * that ~935 theoretical ceiling rather than cutting it close.
 *
 * STANDALONE_MAX_BATCH_SIZE (100) needs no equivalent adjustment — its
 * gas cost (≈3.25M) is nowhere near the block gas limit regardless.
 *
 * These are otherwise just the deployed contracts' `constant`s, compiled
 * into bytecode and unable to change post-deployment, so hardcoding them
 * here (rather than reading MAX_BATCH_SIZE() on-chain before every run)
 * is safe and avoids one more RPC round trip on an already RPC-sensitive
 * path.
 */

/** SaldenEnterprisePayroll.MAX_BATCH_SIZE — the free-tier standalone contract. */
export const STANDALONE_MAX_BATCH_SIZE = 100;

/** Practical, gas-safe cap for the premium clone's batchPay — deliberately
 *  well under the contract's own declared MAX_BATCH_SIZE (1,000); see this
 *  file's header comment for the full gas-budget reasoning. Applies to
 *  both the manual "Process Payment" flow and the AI agent's payroll-run
 *  proposal automatically, since both import this same constant. */
export const CLONE_MAX_BATCH_SIZE = 800;

/** Splits a list of recipients into sequential chunks no larger than the
 *  active contract's cap. `isClone` selects which cap applies. */
export function chunkForBatchPay<T>(items: T[], isClone: boolean): T[][] {
  const size = isClone ? CLONE_MAX_BATCH_SIZE : STANDALONE_MAX_BATCH_SIZE;
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
