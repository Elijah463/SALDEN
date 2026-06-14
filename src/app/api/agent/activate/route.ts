/**
 * @file app/api/agent/activate/route.ts
 *
 * Activates or deactivates the AI Agent's Circle developer-controlled wallet.
 *
 * KEY DESIGN: We do NOT use a server-side Map to store wallet IDs.
 * Serverless cold starts wipe module-level state. Instead, the client
 * sends its stored walletId on subsequent calls. The server validates
 * it against Circle's API each time. The walletId is persisted in the
 * client's AppContext / localStorage.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAgentWallet, getAgentWallet } from '@/lib/circle/agent-wallet';
import { isValidEthAddress } from '@/lib/validation';

export async function POST(req: NextRequest) {
  try {
    const { walletAddress, action, existingWalletId } = await req.json();

    if (!walletAddress || !action) {
      return NextResponse.json(
        { error: 'walletAddress and action required' },
        { status: 400 }
      );
    }

    // Basic address validation
    if (!isValidEthAddress(walletAddress)) {
      return NextResponse.json(
        { error: 'Invalid wallet address format' },
        { status: 400 }
      );
    }

    if (action === 'activate') {
      // If client already has a walletId, verify it's still valid
      if (existingWalletId) {
        try {
          const existing = await getAgentWallet(existingWalletId);
          return NextResponse.json({
            active:       true,
            agentAddress: existing.address,
            walletId:     existing.walletId,
            message:      'Agent wallet re-verified and ready.',
          });
        } catch {
          // Wallet not found — fall through to create a new one
        }
      }

      // Create a fresh agent wallet
      // Idempotency key is deterministic so duplicate calls return the same wallet
      const idempotencyKey = `salden-agent-${walletAddress.toLowerCase()}`;
      const wallet = await createAgentWallet(idempotencyKey);

      return NextResponse.json({
        active:       true,
        agentAddress: wallet.address,
        walletId:     wallet.walletId,   // CLIENT must persist this in AppContext
        message:
          'Agent wallet created. Save the walletId. Add the agentAddress via addAgent() on your payroll contract.',
      });
    }

    if (action === 'deactivate') {
      return NextResponse.json({
        active:  false,
        message: 'Agent deactivated. Call removeAgent() on your payroll contract to revoke Onchain permissions.',
      });
    }

    return NextResponse.json(
      { error: 'Invalid action. Use "activate" or "deactivate".' },
      { status: 400 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
