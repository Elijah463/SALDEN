import { NextRequest, NextResponse } from 'next/server';
import { getSwapQuote } from '@/lib/lifi/client';
import { arcChain } from '@/lib/contracts/config';
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

  // Slippage is a fraction (0.1 = 10%). Callers can override via ?slippage=.
  const slippageParam = req.nextUrl.searchParams.get('slippage');
  const slippage = slippageParam ? parseFloat(slippageParam) : 0.1;

  const { quote, reason } = await getSwapQuote({
    chainId: arcChain.id,
    fromToken, toToken, fromAmount, fromAddress,
    slippage,
  });

  if (!quote) {
    return NextResponse.json({ quote: null, error: reason || 'No route available for this pair right now.' });
  }
  return NextResponse.json({ quote });
}
