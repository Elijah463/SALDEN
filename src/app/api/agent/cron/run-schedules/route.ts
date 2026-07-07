/**
 * @file app/api/agent/cron/run-schedules/route.ts
 * Triggered by Vercel Cron (see vercel.json) — checks for due schedules and
 * executes them via the agent's own wallet, using the exact same
 * autonomousExecution.ts functions the chat-driven execute_* tools use.
 *
 * Secured with CRON_SECRET (Vercel's documented pattern: set this env var,
 * Vercel automatically sends it as a Bearer token on cron-triggered
 * requests) so this can't be hit by an arbitrary caller to trigger
 * unscheduled fund movement.
 *
 * SECURITY NOTE: this no longer trusts schedule.agentWalletId /
 * schedule.agentWalletAddress / schedule.payrollCloneAddress as stored —
 * those are snapshotted client-side at schedule-creation time and, before
 * this fix, schedule/sync/route.ts accepted them from the client without
 * verifying they actually belonged to the syncing wallet. This route now
 * re-resolves both values itself via lib/agent/agentIdentity.ts
 * (Circle refId lookup + on-chain payrollOf read) keyed off
 * schedule.walletAddress, and ignores whatever was stored on the schedule
 * object for those three fields. See agentIdentity.ts for the full
 * writeup of why this matters.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAddress, parseUnits } from 'viem';
import { getDueSchedules, markScheduleRun, computeNextRun } from '@/lib/agent/scheduleStore';
import { executeAutonomousBatchPay, executeAutonomousTransfer } from '@/lib/agent/autonomousExecution';
import { resolveAgentWallet, resolvePayrollClone } from '@/lib/agent/agentIdentity';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const expected = process.env.CRON_SECRET;
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const due = await getDueSchedules(Date.now());
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];

  for (const schedule of due) {
    try {
      // Re-resolve the agent wallet and payroll clone from first
      // principles instead of trusting the snapshotted fields — see file
      // header. A schedule with no active agent wallet or no matching
      // on-chain clone simply fails cleanly here, same as it would have
      // if the fields were genuinely missing before.
      const agent = await resolveAgentWallet(schedule.walletAddress);
      if (!agent) {
        await markScheduleRun(schedule.id, { status: 'failed' });
        results.push({ id: schedule.id, ok: false, error: 'No active agent wallet found for this schedule\'s employer.' });
        continue;
      }

      if (!schedule.tokenAddress || !schedule.resolvedPayments?.length) {
        await markScheduleRun(schedule.id, { status: 'failed' });
        results.push({ id: schedule.id, ok: false, error: 'Schedule is missing required snapshot data.' });
        continue;
      }

      // Only resolve the payroll clone on-chain if this schedule actually
      // needs one (multi-recipient runs) — saves an RPC call for simple
      // single-recipient transfers.
      const needsPayrollClone = schedule.resolvedPayments.length > 1 || !!schedule.payrollCloneAddress;
      const payrollCloneAddress = needsPayrollClone ? await resolvePayrollClone(schedule.walletAddress) : null;

      const decimals = schedule.tokenDecimals ?? 6;
      const idempotencyKeyBase = `schedule-${schedule.id}-${schedule.nextRunAt}`;

      let ok = false;
      let txHash: string | undefined;
      let error: string | undefined;

      if (schedule.resolvedPayments.length === 1 && !payrollCloneAddress) {
        // Single recipient with no payroll contract context — a direct
        // transfer rather than a batchPay (mirrors execute_payment).
        const p = schedule.resolvedPayments[0];
        const result = await executeAutonomousTransfer({
          agentWalletId: agent.walletId,
          agentWalletAddress: agent.address,
          recipient: getAddress(p.address),
          amount: parseUnits(p.amount, decimals),
          tokenAddress: schedule.tokenAddress,
          tokenDecimals: decimals,
          memo: { protocol: 'salden', type: 'scheduledPayment', scheduleId: schedule.id, date: new Date().toISOString() },
          idempotencyKeyBase,
        });
        ok = result.ok; txHash = result.txHash; error = result.error;
      } else if (payrollCloneAddress) {
        const result = await executeAutonomousBatchPay({
          agentWalletId: agent.walletId,
          agentWalletAddress: agent.address,
          payrollCloneAddress,
          employees: schedule.resolvedPayments.map(p => getAddress(p.address)),
          amounts: schedule.resolvedPayments.map(p => parseUnits(p.amount, decimals)),
          tokenAddress: schedule.tokenAddress,
          tokenDecimals: decimals,
          memo: { protocol: 'salden', type: 'scheduledPayrollRun', scheduleId: schedule.id, group: schedule.group, date: new Date().toISOString() },
          idempotencyKeyBase,
        });
        ok = result.ok; txHash = result.txHash; error = result.error;
      } else {
        error = 'Multiple recipients but no payroll contract found on-chain for this employer.';
      }

      const nextRunAt = schedule.type === 'recurring' && schedule.recurrence
        ? computeNextRun(schedule.nextRunAt ?? Date.now(), schedule.recurrence)
        : undefined;

      await markScheduleRun(schedule.id, { status: ok ? 'success' : 'failed', txHash, nextRunAt });
      results.push({ id: schedule.id, ok, error });
    } catch (err) {
      await markScheduleRun(schedule.id, { status: 'failed' });
      results.push({ id: schedule.id, ok: false, error: (err as Error).message });
    }
  }

  return NextResponse.json({ checked: due.length, results });
}
