/**
 * @file app/api/auth/google/route.ts
 *
 * POST /api/auth/google
 * Body: { credential: string }   ← Google Identity Services JWT
 *
 * 1. Verify the Google credential via Google's tokeninfo endpoint.
 * 2. Create / get the Circle user for that email.
 * 3. If the user has no wallet yet → return a challengeId for the client SDK.
 * 4. If the user already has a wallet  → return the wallet address directly.
 *
 * The client executes the Circle Web SDK challenge (PIN setup) if needed,
 * then calls GET /api/auth/wallet-address?userId=... to get the final address.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getUserFirstWallet, initializeUserWallet } from '@/lib/circle/user-wallet';

export async function POST(req: NextRequest) {
  try {
    const { credential } = await req.json();

    if (!credential) {
      return NextResponse.json({ error: 'Google credential is required' }, { status: 400 });
    }

    // ── Step 1: Verify the Google credential ─────────────────────────────────
    const tokenInfoRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`
    );

    if (!tokenInfoRes.ok) {
      return NextResponse.json({ error: 'Invalid Google credential' }, { status: 401 });
    }

    const tokenInfo = await tokenInfoRes.json();

    // Verify it was issued for OUR app
    const expectedClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (expectedClientId && tokenInfo.aud !== expectedClientId) {
      return NextResponse.json({ error: 'Google credential not issued for this app' }, { status: 401 });
    }

    if (tokenInfo.error_description) {
      return NextResponse.json({ error: tokenInfo.error_description }, { status: 401 });
    }

    const email        = tokenInfo.email as string;
    const emailVerified = tokenInfo.email_verified === 'true' || tokenInfo.email_verified === true;

    if (!email || !emailVerified) {
      return NextResponse.json({ error: 'Email not verified by Google' }, { status: 401 });
    }

    // ── Step 2: Create / get Circle user and check for existing wallet ────────
    const { session, wallet, isNewUser } = await getUserFirstWallet(email);

    // ── Step 3a: Returning user — wallet already exists ───────────────────────
    if (!isNewUser && wallet) {
      return NextResponse.json({
        success:       true,
        isNewUser:     false,
        email,
        walletAddress: wallet.address,
        userToken:     session.userToken,
        encryptionKey: session.encryptionKey,
      });
    }

    // ── Step 3b: New user — initialize wallet and return challenge ────────────
    const challengeId = await initializeUserWallet(session.userToken);

    return NextResponse.json({
      success:       true,
      isNewUser:     true,
      email,
      challengeId,
      userToken:     session.userToken,
      encryptionKey: session.encryptionKey,
    });
  } catch (err) {
    console.error('[google-auth] Error:', err);
    const message = err instanceof Error ? err.message : 'Authentication failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
