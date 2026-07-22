/**
 * @file lib/swap/useSwapQuote.ts
 * Debounced live LI.FI quote fetching for the swap page. Extracted from
 * app/wallet/swap/page.tsx so quote-fetching bugs (stale responses, wrong
 * amount scaling, debounce timing) have one obvious place to look.
 */

import { useState, useEffect, useRef } from 'react';
import { toRawAmount, fromRawAmount, type TokenMeta } from './tokens';

export interface LifiQuoteResponse {
  estimate: {
    fromAmount:        string;
    toAmount:           string;
    toAmountMin:        string;
    approvalAddress:    `0x${string}`;
    executionDuration:  number;
  };
  transactionRequest: { to: `0x${string}`; data: `0x${string}`; value?: string };
  toolDetails?: { name?: string };
}

export interface SwapQuoteState {
  quote:      LifiQuoteResponse | null;
  amountOut:  string;
  quoting:    boolean;
  quoteError: string;
}

/** Debounced (500ms) live quote — refetches whenever tokenIn/tokenOut/
 *  amountIn/address change, and safely discards any response that arrives
 *  after a newer request has already superseded it (fast typing can fire
 *  several requests before the first one resolves). */
export function useSwapQuote(
  tokenIn: TokenMeta | null,
  tokenOut: TokenMeta | null,
  amountIn: string,
  address: string | undefined,
): SwapQuoteState {
  const [quote,      setQuote]      = useState<LifiQuoteResponse | null>(null);
  const [amountOut,  setAmountOut]  = useState('');
  const [quoting,     setQuoting]    = useState(false);
  const [quoteError,  setQuoteError] = useState('');
  const requestId = useRef(0);

  useEffect(() => {
    setAmountOut('');
    setQuote(null);
    setQuoteError('');

    if (!tokenIn || !tokenOut || !address || !amountIn || parseFloat(amountIn) <= 0) return;
    if (!tokenIn.address || !tokenOut.address) {
      setQuoteError('This token is missing its contract address configuration.');
      return;
    }
    if (tokenIn.symbol === tokenOut.symbol) return;

    const thisRequestId = ++requestId.current;
    setQuoting(true);

    const rawAmount = toRawAmount(amountIn, tokenIn.decimals).toString();
    const timer = setTimeout(() => {
      fetch(`/api/lifi/quote?fromToken=${tokenIn.address}&toToken=${tokenOut.address}&fromAmount=${rawAmount}&fromAddress=${address}`)
        .then(res => res.json())
        .then((data: { quote: LifiQuoteResponse | null; error?: string }) => {
          if (thisRequestId !== requestId.current) return; // stale — a newer request has already superseded this one
          if (!data.quote) {
            setQuoteError(data.error || 'No route available for this pair right now.');
            return;
          }
          setQuote(data.quote);
          setAmountOut(fromRawAmount(data.quote.estimate.toAmount, tokenOut.decimals));
        })
        .catch(() => { if (thisRequestId === requestId.current) setQuoteError('Could not fetch a quote right now.'); })
        .finally(() => { if (thisRequestId === requestId.current) setQuoting(false); });
    }, 500);

    return () => clearTimeout(timer);
  }, [tokenIn, tokenOut, amountIn, address]);

  return { quote, amountOut, quoting, quoteError };
}
