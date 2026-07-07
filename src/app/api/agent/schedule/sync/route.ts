/**
 * @file app/api/agent/schedule/sync/route.ts
 * The client calls this whenever it opens "Manage AI Agent" (or right after
 * creating/editing a schedule), pushing its IndexedDB-held schedules into
 * the server-side store (see lib/agent/scheduleStore.ts — now KV-backed
 * with an in-memory fallback, rather than memory-only).
 *
 * SECURITY NOTE: schedule.agentWalletId / agentWalletAddress /
 * payrollCloneAddress used to be trusted verbatim from the client. Since
 * the cron executor used to read those fields directly to decide where
 * money goes, a client could previously claim ANY agentWalletId/clone
 * address on a schedule tied to their own (session-authenticated)
 * walletAddress, and the cron job would happily pay out of a wallet that
 * wasn't theirs. This route now re-derives all three fields itself via
 * lib/agent/agentIdentity.ts (server-verified: Circle refId lookup +
 * on-chain payrollOf read) and overwrites whatever the client sent before
 * anything is persisted. The cron route (run-schedules/route.ts) also
 * independently re-resolves these at execution time as defense in depth —
 * this route being correct is not the only thing standing between a
 * malicious payload and a real transfer, but it should be correct anyway
 * so schedules display accurate data in the UI.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '@/lib/agent/auth';
import { upsertSchedules, getSchedulesForWallet } from '@/lib/agent/scheduleStore';
import { resolveAgentWallet, resolvePayrollClone } from '@/lib/agent/agentIdentity';
import type { AgentSchedule } from '@/lib/db/indexeddb';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { walletAddress: string; schedules: AgentSchedule[] };
    const { walletAddress, schedules } = body;

    if (!walletAddress || !Array.isArray(schedules)) {
      return NextResponse.json({ error: 'walletAddress and schedules are required' }, { status: 400 });
    }

    const authHeader = req.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const session = verifySessionToken(token, walletAddress);
    if (!session.ok) {
      return NextResponse.json({ error: 'Your session has expired. Please sign in again.' }, { status: 401 });
    }

    // Defensive: only accept records that genuinely belong to this wallet,
    // and cap the batch size so a malformed client payload can't be used to
    // exhaust the store.
    const candidates = schedules
      .filter((s): s is AgentSchedule => !!s && typeof s === 'object' && typeof s.id === 'string' && s.walletAddress?.toLowerCase() === walletAddress.toLowerCase())
      .slice(0, 200);

    // Re-derive the fields that decide where money goes — never trust the
    // client's claim, no matter what it put in the request body. Resolved
    // ONCE per request (not once per schedule) since every schedule in
    // this batch belongs to the same walletAddress.
    const agent = await resolveAgentWallet(walletAddress);
    const payrollClone = await resolvePayrollClone(walletAddress);

    const valid = candidates.map(s => ({
      ...s,
      agentWalletId:      agent?.walletId,
      agentWalletAddress: agent?.address,
      payrollCloneAddress: payrollClone ?? undefined,
    }));

    await upsertSchedules(valid);
    return NextResponse.json({ ok: true, synced: valid.length });
  } catch (err) {
    console.error('[schedule/sync]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const wallet = req.nextUrl.searchParams.get('wallet');
    if (!wallet) return NextResponse.json({ error: 'wallet required' }, { status: 400 });

    const authHeader = req.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const session = verifySessionToken(token, wallet);
    if (!session.ok) {
      return NextResponse.json({ error: 'Your session has expired. Please sign in again.' }, { status: 401 });
    }

    return NextResponse.json({ schedules: await getSchedulesForWallet(wallet) });
  } catch (err) {
    console.error('[schedule/sync]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
