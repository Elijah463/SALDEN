/**
 * @file app/api/agent/tx-status/route.ts
 *
 * GET /api/agent/tx-status?id=<circleTransactionId>&wallet=<employerWallet>
 * Header: Authorization: Bearer <session token>
 *
 * Closes the actual root cause of "the transaction succeeded on-chain but
 * the chat interface stayed stuck on 'QUEUED' forever": executeAutonomousTransfer/
 * executeAutonomousBatchPay (lib/agent/autonomousExecution.ts) only poll for
 * confirmation for a few seconds before the chat response has to return —
 * a transaction that's still SENT (not yet CONFIRMED) at that point comes
 * back as `pending: true`, and the resulting ActionLogEntry/AgentEvent is
 * rendered with a static 'QUEUED' status. Nothing was ever polling that
 * entry again afterward, even though the transaction typically confirms a
 * few seconds later — the UI just never found out.
 *
 * This route lets the CLIENT (components/agent/ChatInterface.tsx) keep
 * checking a specific pending transaction after the chat turn has already
 * finished, using Circle's own getTxStatus() (agent-wallet.ts) — the same
 * one-shot status check already used server-side, just re-exposed for a
 * client that's polling on its own schedule instead of blocking a single
 * request.
 *
 * Requires a valid session token bound to the employer wallet (same
 * pattern as the other protected /api/agent/* routes) — a Circle
 * transaction id is opaque, but there's no reason to make tx state
 * checkable by anyone who guesses/observes one.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '@/lib/agent/auth';
import { getTxStatus } from '@/lib/circle/agent-wallet';

export async function GET(req: NextRequest) {
  try {
    const id     = req.nextUrl.searchParams.get('id');
    const wallet = req.nextUrl.searchParams.get('wallet');
    if (!id)     return NextResponse.json({ error: 'id is required.' }, { status: 400 });
    if (!wallet) return NextResponse.json({ error: 'wallet is required.' }, { status: 400 });

    const authHeader = req.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const session = verifySessionToken(token, wallet);
    if (!session.ok) return NextResponse.json({ error: session.error }, { status: 401 });

    const status = await getTxStatus(id);
    return NextResponse.json({ state: status.state, txHash: status.txHash });
  } catch (err) {
    console.error('[agent/tx-status] Error:', err);
    const message = err instanceof Error ? err.message : 'Could not check transaction status';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
