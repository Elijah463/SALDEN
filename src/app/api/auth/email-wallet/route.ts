/**
 * @file app/api/auth/email-wallet/route.ts
 *
 * POST /api/auth/email-wallet
 * Body: { email: string }
 *
 * Called by OTPForm after successful OTP verification to provision a
 * Circle wallet for email-OTP users — equivalent to what /api/auth/google
 * does for Google OAuth users.
 *
 * Response shapes:
 *   Returning user (wallet already exists):
 *     { success: true, isNewUser: false, walletAddress: string }
 *
 *   New user (wallet needs to be set up via Circle SDK):
 *     { success: true, isNewUser: true, challengeId: string,
 *       userToken: string, encryptionKey: string }
 *
 * The client must call executeCircleChallenge() for new users, then poll
 * GET /api/auth/wallet-address?userId=<email> for the final address.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getUserFirstWallet,
  initializeUserWallet,
} from '@/lib/circle/user-wallet';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { email?: string };
    const email = (body.email ?? '').trim().toLowerCase();

    if (!email || !email.includes('@')) {
      return NextResponse.json(
        { error: 'A valid email address is required.' },
        { status: 400 }
      );
    }

    // Creates the Circle user if not already existing (idempotent),
    // gets their session, and checks for a live wallet.
    const { session, wallet, isNewUser } = await getUserFirstWallet(email);

    // ── Returning user: wallet already live ──────────────────────────────────
    if (!isNewUser && wallet) {
      return NextResponse.json({
        success:       true,
        isNewUser:     false,
        walletAddress: wallet.address,
      });
    }

    // ── New user: initialise wallet and return challenge for client SDK ───────
    const challengeId = await initializeUserWallet(session.userToken);

    return NextResponse.json({
      success:       true,
      isNewUser:     true,
      challengeId,
      userToken:     session.userToken,
      encryptionKey: session.encryptionKey,
    });

  } catch (err) {
    console.error('[email-wallet] Error:', err);
    const message = err instanceof Error ? err.message : 'Failed to provision wallet';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
