/**
 * @file app/api/circle/tx-status/route.ts
 *
 * GET /api/circle/tx-status?transactionId=X
 * GET /api/circle/tx-status?walletId=X            (fallback — see user-wallet.ts)
 *
 * Polled by the client after a Circle challenge completes, to find out
 * whether the resulting transaction actually confirmed on-chain or
 * reverted — this is the SAME "don't just trust that a promise resolved,
 * check the real status" principle as waitForSuccessfulReceipt() (see
 * lib/txReceipt.ts) for the external-wallet path. No entity secret
 * needed here — this is a read-only status check, not a mutation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserTxStatus, getMostRecentTransaction } from '@/lib/circle/user-wallet';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const transactionId = searchParams.get('transactionId');
    const walletId       = searchParams.get('walletId');

    if (transactionId) {
      const status = await getUserTxStatus(transactionId);
      return NextResponse.json(status);
    }

    if (walletId) {
      const status = await getMostRecentTransaction(walletId);
      if (!status) return NextResponse.json({ error: 'No transactions found for this wallet yet.' }, { status: 404 });
      return NextResponse.json(status);
    }

    return NextResponse.json({ error: 'transactionId or walletId is required.' }, { status: 400 });
  } catch (err) {
    console.error('[tx-status] Error:', err);
    const message = err instanceof Error ? err.message : 'Could not check transaction status';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
