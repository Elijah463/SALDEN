/**
 * @file app/api/auth/wallet-address/route.ts
 *
 * GET /api/auth/wallet-address?userId=<email>
 *
 * Called by the client AFTER the Circle Web SDK challenge is executed.
 * Returns the Circle wallet address for the given userId (email).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserFirstWallet } from '@/lib/circle/user-wallet';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const userId = req.nextUrl.searchParams.get('userId');

    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    }

    const { wallet } = await getUserFirstWallet(userId);

    if (!wallet) {
      return NextResponse.json(
        { error: 'Wallet not ready yet — challenge may not be complete' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success:       true,
      walletAddress: wallet.address,
      walletId:      wallet.id,
      blockchain:    wallet.blockchain,
    });
  } catch (err) {
    console.error('[wallet-address] Error:', err);
    const message = err instanceof Error ? err.message : 'Failed to get wallet';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
