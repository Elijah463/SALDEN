import { NextRequest, NextResponse } from 'next/server';
import { getTokenPrice } from '@/lib/lifi/client';

export async function GET(req: NextRequest) {
  const chainId = req.nextUrl.searchParams.get('chainId');
  const token   = req.nextUrl.searchParams.get('token');

  if (!chainId || !token) {
    return NextResponse.json({ error: 'chainId and token are required' }, { status: 400 });
  }
  const chainIdNum = Number(chainId);
  if (!Number.isFinite(chainIdNum)) {
    return NextResponse.json({ error: 'chainId must be numeric' }, { status: 400 });
  }

  const price = await getTokenPrice(chainIdNum, token);
  if (!price) {
    // Not a hard error — the token/chain just isn't priced by LI.FI right
    // now (e.g. a brand-new testnet asset). Callers show no USD line.
    return NextResponse.json({ price: null });
  }
  return NextResponse.json({ price });
}
