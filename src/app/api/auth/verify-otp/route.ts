/**
 * @file app/api/auth/verify-otp/route.ts
 * Verifies a submitted OTP against the HMAC-signed token returned by send-otp.
 * Completely stateless — works across any number of Vercel Lambda instances.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyOTPToken } from '@/lib/otp-token';

export async function POST(req: NextRequest) {
  try {
    const { email, otp, token, walletAddress } = await req.json();

    if (!email || !otp || !token) {
      return NextResponse.json(
        { error: 'email, otp, and token are required' },
        { status: 400 }
      );
    }

    const result = verifyOTPToken(token, email, String(otp));

    if (!result.valid) {
      return NextResponse.json({ error: result.error }, { status: 401 });
    }

    return NextResponse.json({
      success:       true,
      email,
      walletAddress: walletAddress ?? null,
      message:       'Verified successfully',
    });
  } catch (err) {
    console.error('[verify-otp] Error:', err);
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
  }
}
