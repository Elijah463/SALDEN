/**
 * @file app/api/agent/status/route.ts
 *
 * GET /api/agent/status?wallet=0x...&walletId=<circleWalletId>
 *
 * If walletId is provided → verify against Circle API → return active status.
 * If no walletId           → return { active: false }.
 *
 * The client persists the walletId in localStorage after activation and sends
 * it on every status check. This is stateless-friendly for serverless (no
 * in-memory maps that cold starts would wipe).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentWallet }            from '@/lib/circle/agent-wallet';

export async function GET(req: NextRequest) {
  const wallet   = req.nextUrl.searchParams.get('wallet');
  const walletId = req.nextUrl.searchParams.get('walletId');

  if (!wallet) {
    return NextResponse.json({ error: 'wallet param required' }, { status: 400 });
  }

  // No walletId stored on client yet → agent not activated
  if (!walletId) {
    return NextResponse.json({ active: false });
  }

  try {
    const agentWallet = await getAgentWallet(walletId);

    // Only report active if the wallet is in a usable state
    if (agentWallet.state !== 'LIVE') {
      return NextResponse.json({ active: false });
    }

    return NextResponse.json({
      active:     true,
      agentWallet: agentWallet.address,
      walletId:    agentWallet.walletId,
      // encryptionPublicKey is managed client-side after activation
    });
  } catch {
    // walletId invalid or Circle API down — treat as inactive
    return NextResponse.json({ active: false });
  }
}
