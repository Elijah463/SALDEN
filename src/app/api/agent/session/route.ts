/**
 * @file app/api/agent/session/route.ts
 *
 * POST with { walletAddress }              → { nonce, message } to sign
 * POST with { walletAddress, signature }   → { token } short-lived session
 *
 * See lib/agent/auth.ts for the full flow explanation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { issueNonce, verifyAndIssueSession } from '@/lib/agent/auth';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { walletAddress?: string; signature?: string };
    const { walletAddress, signature } = body;

    if (!walletAddress || !isAddress(walletAddress)) {
      return NextResponse.json({ error: 'A valid wallet address is required.' }, { status: 400 });
    }

    if (!signature) {
      const { message } = issueNonce(walletAddress);
      return NextResponse.json({ message });
    }

    const result = await verifyAndIssueSession(walletAddress, signature);
    if ('error' in result) {
      return NextResponse.json({ error: 'Signature verification failed. Please try signing in again.' }, { status: 401 });
    }
    return NextResponse.json({ token: result.token });

  } catch {
    return NextResponse.json({ error: 'Could not start session. Please try again.' }, { status: 500 });
  }
}
