/**
 * @file app/api/agent/spend/record/route.ts
 *
 * Called by the client ONLY after an unlisted-payment proposal has
 * actually been confirmed and mined on-chain (see AgentConfirmationCards.tsx).
 * Records the amount against that wallet's daily spend ceiling so
 * subsequent proposals in the same day are checked against the real
 * cumulative total, not just the per-transaction ceiling.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { recordProposedSpend } from '@/lib/agent/spendLimits';
import { verifySessionToken } from '@/lib/agent/auth';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { walletAddress?: string; amount?: number; txHash?: string };
    const { walletAddress, amount, txHash } = body;

    if (!walletAddress || !isAddress(walletAddress)) {
      return NextResponse.json({ error: 'A valid wallet address is required.' }, { status: 400 });
    }
    if (!amount || !Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'A valid payment amount is required.' }, { status: 400 });
    }
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return NextResponse.json({ error: 'A confirmed transaction hash is required.' }, { status: 400 });
    }

    const auth = req.headers.get('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const session = verifySessionToken(token, walletAddress);
    if (!session.ok) {
      return NextResponse.json({ error: 'Your session has expired. Please sign in again.' }, { status: 401 });
    }

    recordProposedSpend(walletAddress, amount);
    return NextResponse.json({ recorded: true });

  } catch {
    return NextResponse.json({ error: 'Could not record spend. Please try again.' }, { status: 500 });
  }
}
