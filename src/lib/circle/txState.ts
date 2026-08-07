/**
 * @file lib/circle/txState.ts
 *
 * Circle's real transaction state machine, confirmed against Circle's own
 * skills repo (circlefin/skills, use-developer-controlled-wallets/SKILL.md):
 *
 *   INITIATED -> CLEARED -> QUEUED -> SENT -> CONFIRMED -> COMPLETE
 *
 * CONFIRMED means "included in a block, awaiting finality" — it is
 * documented as a non-terminal intermediate state. COMPLETE is the actual
 * terminal success state ("succeeded and is finalized on-chain"). Circle's
 * own guidance: "ALWAYS poll transaction status until terminal state
 * (COMPLETE, FAILED, DENIED, CANCELLED) before treating as done."
 *
 * Every Circle transaction-status polling loop in this app used to check
 * only for `state === 'CONFIRMED'`. On Arc Testnet's fast block times, a
 * transaction can move CONFIRMED -> COMPLETE inside a single ~3s polling
 * interval — meaning the very state a poll was watching for could already
 * be gone by the time the next poll ran, so the loop kept looking for a
 * moment that had already passed, right up to its timeout. That is the
 * root cause behind "stuck on Approve even after entering the correct
 * PIN" for social-login (Circle) users specifically, across every page
 * that writes on their behalf — swap, send, payroll execution, premium
 * upgrade, scheduled/autonomous agent payments. External wallets never
 * hit this at all: they wait on the chain directly via viem's
 * waitForTransactionReceipt (see lib/txReceipt.ts), not this polling.
 *
 * Also: FAILED was the only recognized failure state in most of these
 * call sites. DENIED (rejected by risk screening) and CANCELLED
 * (cancelled before on-chain submission) are equally real terminal
 * failure states Circle documents — previously left to poll all the way
 * to timeout instead of failing immediately with the real reason.
 *
 * Single source of truth so this can't silently drift back out of sync
 * across its several call sites the way the original duplicated checks did.
 */

export const CIRCLE_TX_SUCCESS_STATES: ReadonlySet<string> = new Set(['CONFIRMED', 'COMPLETE']);
export const CIRCLE_TX_FAILURE_STATES: ReadonlySet<string> = new Set(['FAILED', 'DENIED', 'CANCELLED']);

export function isCircleTxSuccess(state: string | undefined | null): boolean {
  return !!state && CIRCLE_TX_SUCCESS_STATES.has(state);
}

export function isCircleTxFailure(state: string | undefined | null): boolean {
  return !!state && CIRCLE_TX_FAILURE_STATES.has(state);
}

export function isCircleTxTerminal(state: string | undefined | null): boolean {
  return isCircleTxSuccess(state) || isCircleTxFailure(state);
}

export function circleTxFailureMessage(state: string | undefined | null): string {
  if (state === 'DENIED')    return 'Transaction was denied by risk screening.';
  if (state === 'CANCELLED') return 'Transaction was cancelled before it reached the blockchain.';
  return 'Transaction reverted on-chain. No funds moved — check the block explorer for the exact reason.';
}

/** Thrown specifically for a genuine terminal Circle failure state
 *  (FAILED/DENIED/CANCELLED) — distinguishable via `instanceof` from a
 *  transient poll error (a network blip fetching /api/circle/tx-status),
 *  which callers should swallow and retry rather than abort on. Using a
 *  real error type here instead of matching on the message text (the
 *  original approach) means a caller's catch block can't silently
 *  swallow a genuine failure just because its wording didn't happen to
 *  contain whatever substring that catch block was checking for. */
export class CircleTxFailedError extends Error {
  constructor(state: string | undefined | null) {
    super(circleTxFailureMessage(state));
    this.name = 'CircleTxFailedError';
  }
}
