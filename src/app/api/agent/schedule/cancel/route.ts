/**
 * @file app/api/agent/schedule/cancel/route.ts
 * Cancels (permanently removes) a scheduled payment. Called from the
 * "Cancel Payment" action on each schedule card in Manage AI Agent.
 *
 * SECURITY: the schedule id alone is not proof of ownership — it's just an
 * opaque string the client already has (visible in its own IndexedDB/UI).
 * Without an ownership check here, a valid session for wallet A could
 * cancel a schedule belonging to wallet B by simply passing its id. This
 * route verifies the schedule's own walletAddress matches the
 * session-authenticated walletAddress before removing anything.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '@/lib/agent/auth';
import { getSchedulesForWallet, removeSchedule } from '@/lib/agent/scheduleStore';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { walletAddress: string; scheduleId: string };
    const { walletAddress, scheduleId } = body;

    if (!walletAddress || !scheduleId) {
      return NextResponse.json({ error: 'walletAddress and scheduleId are required' }, { status: 400 });
    }

    const authHeader = req.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const session = verifySessionToken(token, walletAddress);
    if (!session.ok) {
      return NextResponse.json({ error: 'Your session has expired. Please sign in again.' }, { status: 401 });
    }

    // Ownership check — only remove a schedule that genuinely belongs to
    // this session-authenticated wallet.
    const mine = await getSchedulesForWallet(walletAddress);
    const owned = mine.some(s => s.id === scheduleId);
    if (!owned) {
      return NextResponse.json({ error: 'Schedule not found.' }, { status: 404 });
    }

    await removeSchedule(scheduleId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[schedule/cancel]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
