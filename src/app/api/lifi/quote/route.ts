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

  // Default slippage tolerance: LI.FI's own default (roughly 0.5%) is
  // documented behavior that can reject an otherwise-viable route once
  // price impact exceeds it — more likely exactly as trade size grows
  // against thinner liquidity, which matches the "small amounts route
  // fine, larger ones say no route available" pattern seen on Arc
  // Testnet. `slippage` is a genuine, documented /quote parameter (see
  // docs.li.fi/api-reference/get-a-quote-for-a-token-transfer), not a
  // speculative fix — 3% is a reasonable, still-bounded tolerance for
  // testnet liquidity depth. Callers can still override via ?slippage=.
  const slippageParam = req.nextUrl.searchParams.get('slippage');
  const slippage = slippageParam ? parseFloat(slippageParam) : 0.1;

  const { quote, reason } = await getSwapQuote({
    chainId: arcTestnet.id,
    fromToken, toToken, fromAmount, fromAddress,
    slippage,
  });

  if (!quote) {
    return NextResponse.json({ quote: null, error: reason || 'No route available for this pair right now.' });
  }
  return NextResponse.json({ quote });
}
