import { NextRequest, NextResponse } from 'next/server';
import { getSwapQuote } from '@/lib/lifi/client';
import { arcTestnet } from '@/lib/contracts/config';
import { isValidEthAddress } from '@/lib/validation';

export async function GET(req: NextRequest) {
  const fromToken   = req.nextUrl.searchParams.get('fromToken');
  const toToken     = req.nextUrl.searchParams.get('toToken');
  const fromAmount  = req.nextUrl.searchParams.get('fromAmount');
  const fromAddress = req.nextUrl.searchParams.get('fromAddress');

  if (!fromToken || !toToken || !fromAmount || !fromAddress) {
    return NextResponse.json({ error: 'fromToken, toToken, fromAmount, fromAddress are required' }, { status: 400 });
  }
  if (!isValidEthAddress(fromToken) || !isValidEthAddress(toToken) || !isValidEthAddress(fromAddress)) {
    return NextResponse.json({ error: 'fromToken, toToken, fromAddress must be valid addresses' }, { status: 400 });
  }
  if (!/^\d+$/.test(fromAmount)) {
    return NextResponse.json({ error: 'fromAmount must be a raw integer amount' }, { status: 400 });
  }

  const quote = await getSwapQuote({
    chainId: arcTestnet.id,
    fromToken, toToken, fromAmount, fromAddress,
  });

  if (!quote) {
    return NextResponse.json({ quote: null, error: 'No route available for this pair right now.' });
  }
  return NextResponse.json({ quote });
}
