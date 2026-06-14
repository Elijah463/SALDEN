/**
 * @file app/api/agent/status/route.ts
 */
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get('wallet');
  if (!wallet) return NextResponse.json({ error: 'wallet required' }, { status: 400 });

  // In production, look up from DB. Return sensible defaults.
  return NextResponse.json({
    active:    false,
    schedules: 0,
    walletAddress: null,
  });
}
