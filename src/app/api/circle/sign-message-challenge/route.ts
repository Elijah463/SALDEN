/**
 * @file app/api/circle/sign-message-challenge/route.ts
 *
 * POST /api/circle/sign-message-challenge
 * Body: { email, message }
 *
 * Sibling to /api/circle/write-challenge — same structure, same
 * debugging approach (see that route's header comment), but for signing
 * a plain message instead of executing a contract call. Needed by any
 * flow that derives a signature-based encryption key rather than sending
 * a transaction — currently only lib/usePayrollSync.ts's IPFS
 * employee-data sync.
 *
 * Returns { challengeId, userToken, encryptionKey, walletId } — the
 * client uses these with executeCircleMessageSigningChallenge() (see
 * lib/circle/executeChallenge.ts) to prompt the user's PIN and get the
 * signature back directly (no polling needed here, unlike a
 * transaction — see that function's header for why).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserFirstWallet, createMessageSigningChallenge } from '@/lib/circle/user-wallet';

const IP_RATE_MAP = new Map<string, { count: number; resetAt: number }>();
const IP_RATE_LIMIT  = 30;
const IP_RATE_WINDOW = 10 * 60 * 1000;

function checkIPRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = IP_RATE_MAP.get(ip);
  if (!record || now > record.resetAt) {
    IP_RATE_MAP.set(ip, { count: 1, resetAt: now + IP_RATE_WINDOW });
    return true;
  }
  if (record.count >= IP_RATE_LIMIT) return false;
  record.count += 1;
  return true;
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!checkIPRateLimit(ip)) {
      return NextResponse.json({ error: 'Too many requests. Please wait a moment and try again.' }, { status: 429 });
    }

    const body = await req.json() as { email?: string; message?: string };
    const { email, message } = body;

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'email is required.' }, { status: 400 });
    }
    if (!message || typeof message !== 'string') {
      return NextResponse.json({ error: 'message is required.' }, { status: 400 });
    }

    const { session, wallet } = await getUserFirstWallet(email);

    if (!wallet) {
      return NextResponse.json({ error: 'No wallet found for this account yet — finish setting up your wallet first.' }, { status: 400 });
    }

    const challengeId = await createMessageSigningChallenge({
      userToken: session.userToken,
      walletId:  wallet.id,
      message,
      idempotencyKey: `sign-${wallet.id}-${Date.now()}`,
    });

    return NextResponse.json({
      challengeId,
      userToken:     session.userToken,
      encryptionKey: session.encryptionKey,
      walletId:      wallet.id,
    });
  } catch (err) {
    console.error('[sign-message-challenge] Error:', err);
    const message = err instanceof Error ? err.message : 'Could not create signing challenge';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
