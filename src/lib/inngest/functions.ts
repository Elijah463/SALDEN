/**
 * @file lib/inngest/functions.ts
 * SERVER-SIDE ONLY.
 *
 * Two Inngest functions that together replace
 * app/api/agent/cron/run-schedules/route.ts's Vercel-Cron-triggered loop:
 *
 *   1. checkDueSchedules   — cron-triggered (`* /15 * * * *`), finds due
 *      schedules and fans out one `agent/schedule.execute` event per
 *      schedule. Does no money-moving itself.
 *   2. executeScheduledPayment — event-triggered, does the actual
 *      multi-step execution for exactly one schedule: re-resolves the
 *      agent wallet + payroll clone from first principles (never trusts
 *      the snapshotted values on the schedule object — same rule the old
 *      route.ts enforced, see agentIdentity.ts), runs a compliance check
 *      per recipient that fails closed on error, submits the payment, and
 *      polls for on-chain confirmation using step.run + step.sleep so the
 *      wait never blocks Vercel compute or risks a function timeout.
 *
 * ── The bug this design specifically avoids ─────────────────────────────
 * markScheduleRun() (scheduleStore.ts) looks a schedule up from an
 * in-memory Map before mutating it. That Map is a same-instance,
 * best-effort fast path — it is NOT guaranteed to contain the schedule on
 * whatever instance ends up running a given Inngest step (checkpointed
 * steps, retries, and the cron vs. execute functions themselves can all
 * land on different Vercel instances). If markScheduleRun() silently
 * no-ops because the Map lookup misses, the schedule's `nextRunAt` never
 * advances and `status` never becomes 'completed'/'failed' — so the very
 * next cron tick sees it as still due and pays it again. This file never
 * calls markScheduleRun(). Every completion path below builds the full
 * updated AgentSchedule record from data already in hand (the `schedule`
 * object carried in the event payload, plus this run's own results) via
 * buildUpdatedRecord(), and writes it with upsertSchedule() — which does
 * a real KV/in-memory write keyed by wallet+id, not a Map lookup-then-
 * mutate.
 *
 * ── KNOWN pre-existing limitation this migration does NOT fix ──────────
 * scheduleStore.ts's own file header documents that KV mirroring is
 * best-effort and falls back to a bare in-memory Map when no KV store is
 * attached to this Vercel project. That in-memory Map is exactly as
 * unreliable across Inngest's serverless invocations as it was across
 * Vercel Cron's — arguably more likely to matter, since Inngest may
 * schedule the cron function and each execute function on different
 * instances more often than Vercel Cron did. If a KV store is not
 * attached, getDueSchedules() may see an empty store on whatever instance
 * handles a given tick, and this migration does not change that. Attach a
 * KV store (Vercel dashboard → Storage) before relying on this in
 * production; see scheduleStore.ts for the exact env vars it reads.
 */

import { getAddress, parseUnits, encodeFunctionData } from 'viem';
import { inngest } from './client';
import type { AgentSchedule } from '@/lib/db/indexeddb';
import { getDueSchedules, upsertSchedule, computeNextRun } from '@/lib/agent/scheduleStore';
import { resolveAgentWallet, resolvePayrollClone } from '@/lib/agent/agentIdentity';
import { executeCheckOfacCompliance } from '@/lib/agent/toolExecutors';
import { checkAndTopUpBalance, ALLOWANCE_CEILING_USDC } from '@/lib/agent/autonomousExecution';
import { executeContractCall, getTxStatus } from '@/lib/circle/agent-wallet';
import { getServerPublicClient } from '@/lib/agent/chain';
import { ERC20_ABI, MEMO_CONTRACT_ADDRESS, MULTI_TOKEN_PAYROLL_ABI } from '@/lib/contracts/abis';
import { sendInvoiceEmail } from '@/lib/email/sendInvoiceEmail';
import { track } from '@/lib/analytics';

const SCHEDULE_EXECUTE_EVENT = 'agent/schedule.execute' as const;

interface ScheduleExecuteEventData {
  schedule: AgentSchedule;
}

// Bounded, non-blocking confirmation windows. Each attempt is one
// step.run (a fast Circle status check) followed by one step.sleep — the
// sleep costs zero Vercel compute, so these windows can be generous
// without risking a function timeout the way the old route.ts's blocking
// setTimeout-based polling did (see autonomousExecution.ts's own timeout
// note). Tuned for Arc Testnet block times; raise if mainnet confirmation
// is meaningfully slower.
const APPROVE_POLL_ATTEMPTS = 20; // 20 × 5s = up to 100s
const PAY_POLL_ATTEMPTS     = 30; // 30 × 5s = up to 150s
const POLL_SLEEP            = '5s';

// Keep in sync with the `retries` option on executeScheduledPayment below
// — used to detect "this is the last attempt" in the catch-all handler.
const MAX_RETRIES = 2;

// ── Shared record-building helper ───────────────────────────────────────
// The ONE place either function writes a schedule's result. Builds the
// complete next AgentSchedule from the schedule already in hand — never
// reads scheduleStore's internal in-memory Map — then persists it via
// upsertSchedule(). Mirrors markScheduleRun()'s exact status/nextRunAt
// rules so behavior is unchanged from the reader's point of view; only
// the (unsafe, in-memory-Map-dependent) lookup mechanism is different.
function buildUpdatedRecord(
  schedule: AgentSchedule,
  result: { status: 'success' | 'failed'; txHash?: string; nextRunAt?: number },
): AgentSchedule {
  const now = Date.now();
  const runHistory = [
    ...schedule.runHistory,
    { timestamp: now, status: result.status, txHash: result.txHash },
  ].slice(-50);

  const updated: AgentSchedule = { ...schedule, lastRunAt: now, runHistory };
  if (result.status === 'failed') {
    updated.status = 'failed';
  } else if (result.nextRunAt) {
    updated.nextRunAt = result.nextRunAt; // recurring — schedule the next run
    updated.status = 'active';
  } else {
    updated.status = 'completed'; // one-off — done
  }
  return updated;
}

function buildFailedRecord(schedule: AgentSchedule, txHash?: string): AgentSchedule {
  return buildUpdatedRecord(schedule, { status: 'failed', txHash });
}

// ── 1. Cron: find due schedules, fan out one event per schedule ─────────────

export const checkDueSchedules = inngest.createFunction(
  { id: 'agent-check-due-schedules', triggers: { cron: '*/15 * * * *' } },
  async ({ step }) => {
    const due = await step.run('fetch-due-schedules', async () => getDueSchedules(Date.now()));

    if (due.length === 0) {
      return { checked: 0, fannedOut: 0 };
    }

    // Idempotent event IDs (schedule id + the nextRunAt it was due at) so
    // that if this cron step is ever retried by Inngest for an unrelated
    // transient reason, the SAME due tick doesn't fan out twice — Inngest
    // dedupes events by id, only the first triggers a run. Once the
    // schedule's nextRunAt actually advances (a genuinely new due tick),
    // the id changes too, so real future runs are never suppressed.
    const events = due.map((schedule) => ({
      name: SCHEDULE_EXECUTE_EVENT,
      id: `schedule-execute-${schedule.id}-${schedule.nextRunAt}`,
      data: { schedule } satisfies ScheduleExecuteEventData,
    }));

    await step.sendEvent('fan-out-schedule-execution', events);

    return { checked: due.length, fannedOut: events.length, scheduleIds: due.map((s) => s.id) };
  },
);

// ── 2. Event-triggered: execute exactly one schedule ─────────────────────────

export const executeScheduledPayment = inngest.createFunction(
  { id: 'agent-execute-scheduled-payment', retries: MAX_RETRIES, triggers: { event: SCHEDULE_EXECUTE_EVENT } },
  async ({ event, step, attempt }) => {
    const schedule = (event.data as ScheduleExecuteEventData).schedule;

    // Local, closure-capturing poll helper — step.run + step.sleep only,
    // never a blocking wait. Returns null if the window is exhausted
    // without reaching a terminal (CONFIRMED/FAILED) state.
    async function pollForConfirmation(
      label: string,
      txId: string,
      maxAttempts: number,
    ): Promise<{ state: string; txHash?: string } | null> {
      for (let i = 0; i < maxAttempts; i++) {
        const status = await step.run(`poll-${label}-tx-${i}`, async () => {
          try {
            const result = await getTxStatus(txId);
            return { state: result.state, txHash: result.txHash };
          } catch {
            // A transient Circle API hiccup on the STATUS CHECK itself is
            // not the same as the transaction failing — treat it as "no
            // new information yet" and let the loop try again after the
            // next sleep, rather than failing the whole payment over a
            // flaky read.
            return { state: 'UNKNOWN', txHash: undefined as string | undefined };
          }
        });

        if (status.state === 'CONFIRMED' || status.state === 'FAILED') return status;
        if (i < maxAttempts - 1) await step.sleep(`sleep-${label}-tx-${i}`, POLL_SLEEP);
      }
      return null;
    }

    try {
      // ── Resolve agent wallet server-side — never trust the snapshot ──────
      const agent = await step.run('resolve-agent-wallet', async () => resolveAgentWallet(schedule.walletAddress));
      if (!agent) {
        await step.run('mark-failed-no-wallet', async () => {
          await upsertSchedule(buildFailedRecord(schedule));
        });
        return { scheduleId: schedule.id, ok: false, reason: 'no-agent-wallet' as const };
      }

      if (!schedule.tokenAddress || !schedule.resolvedPayments?.length) {
        await step.run('mark-failed-missing-data', async () => {
          await upsertSchedule(buildFailedRecord(schedule));
        });
        return { scheduleId: schedule.id, ok: false, reason: 'missing-snapshot-data' as const };
      }

      const needsPayrollClone = schedule.resolvedPayments.length > 1 || !!schedule.payrollCloneAddress;
      const payrollCloneAddress = needsPayrollClone
        ? await step.run('resolve-payroll-clone', async () => resolvePayrollClone(schedule.walletAddress))
        : null;

      const isSingleTransfer = schedule.resolvedPayments.length === 1 && !payrollCloneAddress;
      if (!isSingleTransfer && !payrollCloneAddress) {
        await step.run('mark-failed-no-clone', async () => {
          await upsertSchedule(buildFailedRecord(schedule));
        });
        return { scheduleId: schedule.id, ok: false, reason: 'no-payroll-clone' as const };
      }

      // ── Compliance / OFAC screening — fails CLOSED on error ──────────────
      // Every recipient must come back explicitly "not sanctioned". If the
      // check for ANY recipient errors (provider unavailable, bad network,
      // etc.) that recipient is treated as blocked, exactly like a positive
      // hit — an agent autonomously moving real funds must never proceed on
      // "we couldn't tell".
      const compliance = await step.run('compliance-check', async () => {
        const blocked: string[] = [];
        let anyErrored = false;
        for (const p of schedule.resolvedPayments!) {
          const result = await executeCheckOfacCompliance(p.address);
          if (!result.ok || result.sanctioned) blocked.push(p.address);
          if (!result.ok) anyErrored = true;
        }
        return { blocked, anyErrored };
      });

      if (compliance.blocked.length > 0) {
        await step.run('mark-failed-compliance', async () => {
          await upsertSchedule(buildFailedRecord(schedule));
        });
        return {
          scheduleId: schedule.id, ok: false,
          reason: compliance.anyErrored ? ('compliance-check-unavailable' as const) : ('compliance-blocked' as const),
          blockedAddresses: compliance.blocked,
        };
      }

      const decimals = schedule.tokenDecimals ?? 6;
      const idempotencyKeyBase = `schedule-${schedule.id}-${schedule.nextRunAt}`;
      const amounts = schedule.resolvedPayments.map((p) => parseUnits(p.amount, decimals));
      const totalNeeded = amounts.reduce((sum, a) => sum + a, 0n);

      // ── Balance check (+ one testnet faucet retry) ───────────────────────
      const balanceCheck = await step.run('check-balance', async () => {
        const result = await checkAndTopUpBalance({
          agentWalletAddress: agent.address,
          tokenAddress:        schedule.tokenAddress!,
          tokenDecimals:       decimals,
          needed:              totalNeeded,
        });
        return { ok: result.ok, error: result.error };
      });

      if (!balanceCheck.ok) {
        await step.run('mark-failed-balance', async () => {
          await upsertSchedule(buildFailedRecord(schedule));
        });
        return { scheduleId: schedule.id, ok: false, reason: 'insufficient-balance' as const, error: balanceCheck.error };
      }

      // ── Allowance + approve (batchPay path only) ──────────────────────────
      if (!isSingleTransfer) {
        const allowanceStr = await step.run('read-allowance', async () => {
          const publicClient = getServerPublicClient();
          const allowance = await publicClient.readContract({
            address:      schedule.tokenAddress! as `0x${string}`,
            abi:          ERC20_ABI,
            functionName: 'allowance',
            args:         [agent.address as `0x${string}`, payrollCloneAddress as `0x${string}`],
          }) as bigint;
          return allowance.toString();
        });
        const allowance = BigInt(allowanceStr);

        if (allowance < totalNeeded) {
          const approveTx = await step.run('submit-approve-tx', async () => {
            const tx = await executeContractCall({
              walletId:             agent.walletId,
              contractAddress:      schedule.tokenAddress!,
              abiFunctionSignature: 'approve(address,uint256)',
              abiParameters:        [payrollCloneAddress, parseUnits(ALLOWANCE_CEILING_USDC, decimals).toString()],
              idempotencyKey:       `${idempotencyKeyBase}-approve`,
            });
            return { id: tx.id, txHash: tx.txHash };
          });

          const approveResult = await pollForConfirmation('approve', approveTx.id, APPROVE_POLL_ATTEMPTS);
          if (!approveResult || approveResult.state !== 'CONFIRMED') {
            await step.run('mark-failed-approve', async () => {
              await upsertSchedule(buildFailedRecord(schedule, approveResult?.txHash));
            });
            return {
              scheduleId: schedule.id, ok: false,
              reason: approveResult?.state === 'FAILED' ? ('approve-reverted' as const) : ('approve-timed-out' as const),
            };
          }
        }
      }

      // ── Submit the actual payment ─────────────────────────────────────────
      const payTx = isSingleTransfer
        ? await step.run('submit-transfer-tx', async () => {
            const recipient = getAddress(schedule.resolvedPayments![0].address);
            const tx = await executeContractCall({
              walletId:             agent.walletId,
              contractAddress:      schedule.tokenAddress!,
              abiFunctionSignature: 'transfer(address,uint256)',
              abiParameters:        [recipient, amounts[0].toString()],
              idempotencyKey:       `${idempotencyKeyBase}-transfer`,
            });
            return { id: tx.id, txHash: tx.txHash };
          })
        : await step.run('submit-batchpay-tx', async () => {
            const employees = schedule.resolvedPayments!.map((p) => getAddress(p.address));
            const memo = {
              protocol: 'salden', type: 'scheduledPayrollRun', scheduleId: schedule.id,
              group: schedule.group, date: new Date().toISOString(),
            };
            const memoHex = (`0x${Buffer.from(JSON.stringify(memo), 'utf8').toString('hex')}`) as `0x${string}`;
            const batchData = encodeFunctionData({
              abi: MULTI_TOKEN_PAYROLL_ABI,
              functionName: 'batchPay',
              args: [employees as `0x${string}`[], amounts, schedule.tokenAddress! as `0x${string}`],
            });
            const tx = await executeContractCall({
              walletId:             agent.walletId,
              contractAddress:      MEMO_CONTRACT_ADDRESS,
              abiFunctionSignature: 'callWithMemo(address,bytes,bytes,uint256)',
              abiParameters:        [payrollCloneAddress, batchData, memoHex, '0'],
              idempotencyKey:       `${idempotencyKeyBase}-pay`,
            });
            return { id: tx.id, txHash: tx.txHash };
          });

      // ── Wait for confirmation — step.run + step.sleep, never blocking ────
      const payResult = await pollForConfirmation('pay', payTx.id, PAY_POLL_ATTEMPTS);

      if (!payResult) {
        await step.run('mark-failed-confirmation-timeout', async () => {
          await upsertSchedule(buildFailedRecord(schedule, payTx.txHash));
        });
        return {
          scheduleId: schedule.id, ok: false, reason: 'confirmation-timed-out' as const,
          txHash: payTx.txHash,
          note: 'Submitted but not confirmed within the monitoring window — check the block explorer before assuming it failed; funds may still have moved.',
        };
      }

      if (payResult.state === 'FAILED') {
        await step.run('mark-failed-onchain-revert', async () => {
          await upsertSchedule(buildFailedRecord(schedule, payResult.txHash));
        });
        return { scheduleId: schedule.id, ok: false, reason: 'onchain-revert' as const, txHash: payResult.txHash };
      }

      // Best-effort memo for the single-transfer path (batchPay's memo is
      // already bundled into the submitted tx via the Memo wrapper above).
      // Never allowed to fail the run.
      if (isSingleTransfer) {
        await step.run('submit-transfer-memo', async () => {
          try {
            const memo = { protocol: 'salden', type: 'scheduledPayment', scheduleId: schedule.id, date: new Date().toISOString() };
            const memoHex = (`0x${Buffer.from(JSON.stringify(memo), 'utf8').toString('hex')}`) as `0x${string}`;
            await executeContractCall({
              walletId:             agent.walletId,
              contractAddress:      MEMO_CONTRACT_ADDRESS,
              abiFunctionSignature: 'callWithMemo(address,bytes,bytes,uint256)',
              abiParameters:        ['0x0000000000000000000000000000000000000000', '0x', memoHex, '0'],
              idempotencyKey:       `${idempotencyKeyBase}-memo`,
            });
          } catch { /* purely informational — never surface this failure */ }
          return { attempted: true };
        });
      }

      const nextRunAt = schedule.type === 'recurring' && schedule.recurrence
        ? computeNextRun(schedule.nextRunAt ?? Date.now(), schedule.recurrence)
        : undefined;

      await step.run('mark-schedule-success', async () => {
        await upsertSchedule(buildUpdatedRecord(schedule, { status: 'success', txHash: payResult.txHash, nextRunAt }));
      });

      await step.run('track-payroll-executed', async () => {
        const volumeUsdc = schedule.resolvedPayments!.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
        await track({
          event:         'payroll_executed',
          walletAddress: schedule.walletAddress,
          employeeCount: schedule.resolvedPayments!.length,
          volumeUsdc,
          txHash:        payResult.txHash ?? payTx.txHash ?? '',
        });
      });

      // ── Invoice receipt email — skip gracefully, never fail the run ──────
      await step.run('send-invoice-email', async () => {
        if (!schedule.recipientEmail) return { skipped: true, reason: 'no-recipient-email' as const };
        return sendInvoiceEmail({
          recipientEmail: schedule.recipientEmail,
          walletAddress:  schedule.walletAddress,
          ref:            `SCH-${schedule.id.slice(0, 8).toUpperCase()}`,
          txHash:         payResult.txHash ?? payTx.txHash ?? '',
          timestamp:      Date.now(),
          recipientCount: schedule.resolvedPayments!.length,
          token:          schedule.token,
          amount:         schedule.amount,
          executedBy:     'ai_agent',
        });
      });

      return { scheduleId: schedule.id, ok: true, txHash: payResult.txHash };
    } catch (err) {
      // Catch-all: only fires after this invocation's own step retries
      // (network blips inside a step, etc.) have already been exhausted
      // AND this is the LAST function-level attempt Inngest will make —
      // otherwise re-throw so Inngest's normal retry can proceed. This
      // exists so a genuinely broken schedule (bad data, a permanently
      // failing dependency) gets marked 'failed' — and therefore stops
      // matching getDueSchedules()'s `status === 'active'` filter — instead
      // of silently retrying forever and re-fanning-out every 15 minutes.
      if (attempt >= MAX_RETRIES) {
        await step.run('mark-failed-unexpected-error', async () => {
          await upsertSchedule(buildFailedRecord(schedule));
        });
        return {
          scheduleId: schedule.id, ok: false, reason: 'unexpected-error' as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      throw err;
    }
  },
);

export const inngestFunctions = [checkDueSchedules, executeScheduledPayment];
