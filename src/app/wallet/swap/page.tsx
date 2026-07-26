'use client';
/**
 * @file app/wallet/swap/page.tsx
 *
 * Real swap powered by LI.FI (quote + actual on-chain execution) — Circle
 * App Kit's kit.swap() has been replaced here after confirmation it wasn't
 * working, and it also only ever worked for external wallets (Circle's
 * swap adapter needs a standard EIP-1193 provider, which a Circle
 * social-login session doesn't expose). LI.FI's flow works for both
 * wallet types, since execution here is just approve + a single
 * transaction — routed through useUniversalWrite the same way every other
 * on-chain write in this app is, rather than a wallet-type-specific SDK
 * call.
 *
 * This page is deliberately just an orchestrator — the actual logic lives in:
 *   - lib/swap/tokens.ts       — token config, raw-amount conversion
 *   - lib/swap/useSwapQuote.ts — debounced live LI.FI quote fetching
 *   - components/wallet/SwapUI.tsx — token icon/selector/input box, step progress
 * so a bug in any one of quote-fetching / token config / UI rendering /
 * execution has one obvious, small place to look instead of hunting
 * through one large file.
 *
 * Flow:
 *   1. User selects tokenIn + tokenOut + amount
 *   2. useSwapQuote (debounced) → GET /api/lifi/quote → live estimated
 *      amountOut + the actual transactionRequest to execute (LI.FI API
 *      key stays server-side in that route — never exposed here)
 *   3. On Swap: approve tokenIn for quote.estimate.approvalAddress if the
 *      current allowance is insufficient, then send
 *      quote.transactionRequest via useUniversalWrite.sendTransaction
 *   4. Real tx hash shown with ArcScan link once mined
 *
 * Supported tokens on Arc Testnet: USDC, EURC, cirBTC
 */

import { useState, useCallback, useEffect } from 'react';
import { useRouter }           from 'next/navigation';
import { usePublicClient }     from 'wagmi';
import {
  ArrowLeft, ArrowDown, Loader2, ExternalLink, CheckCircle2, X, AlertTriangle,
} from 'lucide-react';
import { AppLayout }           from '@/components/layout/AppLayout';
import { NetworkGuard }        from '@/components/shared/NetworkGuard';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { useUniversalWrite }   from '@/lib/circle/useUniversalWrite';
import { txLink, arcTestnet }  from '@/lib/contracts/config';
import { ERC20_ABI }           from '@/lib/contracts/abis';
import { TOKENS, toRawAmount, fromRawAmount, type TokenMeta } from '@/lib/swap/tokens';
import { useSwapQuote }        from '@/lib/swap/useSwapQuote';
import { useTokenDecimals, withResolvedDecimals } from '@/lib/swap/useTokenDecimals';
import { TokenBox, StepProgress } from '@/components/wallet/SwapUI';

type SwapStep = 'approve' | 'swap' | 'confirm' | '';

export default function SwapPage() {
  const router = useRouter();
  const { address, isConnected } = useEffectiveAddress();
  const { writeContract: universalWrite, sendTransaction, canWrite } = useUniversalWrite();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  const [tokenIn,   setTokenIn]   = useState<TokenMeta | null>(TOKENS[0]);
  const [tokenOut,  setTokenOut]  = useState<TokenMeta | null>(TOKENS[1]);
  const [amountIn,  setAmountIn]  = useState('');
  const [swapping,  setSwapping]  = useState(false);
  const [swapStep,  setSwapStep]  = useState<SwapStep>('');
  const [error,     setError]     = useState('');
  const [successTx, setSuccessTx] = useState<string | null>(null);
  const [lastReceivedAmount, setLastReceivedAmount] = useState('');

  // Real on-chain decimals override the hardcoded guesses in tokens.ts where available
  const resolvedDecimals = useTokenDecimals([tokenIn, tokenOut]);
  const effTokenIn  = withResolvedDecimals(tokenIn,  resolvedDecimals);
  const effTokenOut = withResolvedDecimals(tokenOut, resolvedDecimals);

  const { quote, amountOut, quoting, quoteError } = useSwapQuote(effTokenIn, effTokenOut, amountIn, address);

  // ── Wallet balances for both tokens — mirrors the Bridge page's balance
  //    display, shown for both From and To here (Bridge only shows From) ──
  const [balanceIn,         setBalanceIn]         = useState<string | null>(null);
  const [balanceInLoading,  setBalanceInLoading]  = useState(false);
  const [balanceOut,        setBalanceOut]        = useState<string | null>(null);
  const [balanceOutLoading, setBalanceOutLoading] = useState(false);

  const fetchTokenBalance = useCallback(async (token: TokenMeta | null): Promise<string | null> => {
    if (!token || !address || !publicClient || !token.address) return null;
    try {
      const raw = await publicClient.readContract({
        address: token.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [address as `0x${string}`],
      }) as bigint;
      return fromRawAmount(raw.toString(), token.decimals);
    } catch { return null; }
  }, [address, publicClient]);

  useEffect(() => {
    let cancelled = false;
    setBalanceInLoading(true);
    fetchTokenBalance(effTokenIn).then(b => { if (!cancelled) { setBalanceIn(b); setBalanceInLoading(false); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effTokenIn?.symbol, effTokenIn?.decimals, address, fetchTokenBalance]);

  useEffect(() => {
    let cancelled = false;
    setBalanceOutLoading(true);
    fetchTokenBalance(effTokenOut).then(b => { if (!cancelled) { setBalanceOut(b); setBalanceOutLoading(false); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effTokenOut?.symbol, effTokenOut?.decimals, address, fetchTokenBalance]);

  function swapTokens() {
    const tmpIn  = tokenIn;
    const tmpAmt = amountOut;
    setTokenIn(tokenOut);
    setTokenOut(tmpIn);
    setAmountIn(tmpAmt);
  }

  const handleSwap = useCallback(async () => {
    if (!effTokenIn || !effTokenOut || !amountIn || parseFloat(amountIn) <= 0) return;
    if (!quote) { setError('Get a quote before swapping.'); return; }
    if (!canWrite || !address || !publicClient) { setError('Connect your wallet to swap.'); return; }
    if (!effTokenIn.address) { setError('Missing token contract address.'); return; }

    setSwapping(true);
    setError('');

    try {
      const rawAmount = toRawAmount(amountIn, effTokenIn.decimals);

      // Approve LI.FI's contract to spend tokenIn, if not already approved
      // for at least this amount.
      setSwapStep('approve');
      const allowance = await publicClient.readContract({
        address: effTokenIn.address, abi: ERC20_ABI, functionName: 'allowance',
        args: [address as `0x${string}`, quote.estimate.approvalAddress],
      }) as bigint;

      if (allowance < rawAmount) {
        const approveTxHash = await universalWrite({
          address: effTokenIn.address, abi: ERC20_ABI, functionName: 'approve',
          args: [quote.estimate.approvalAddress, rawAmount],
        });
        // BUG FIX: the swap transaction right below depends on this
        // allowance actually being live on-chain. Previously we moved on
        // the instant the approve tx was *broadcast*, not once it was
        // *mined* — so the swap's internal transferFrom would run against
        // an allowance that was still 0 (approve still pending in the
        // mempool), reverting with TRANSFER_FROM_FAILED. That's also why
        // clicking Swap a second time "just worked": by then the approve
        // from the first attempt had finally landed. Waiting for the
        // receipt here closes that race for good.
        await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
      }

      // Execute the swap — LI.FI's own pre-built, already-encoded transaction
      setSwapStep('swap');
      const value = quote.transactionRequest.value ? BigInt(quote.transactionRequest.value) : undefined;
      const txHash = await sendTransaction({
        to: quote.transactionRequest.to, data: quote.transactionRequest.data, value,
      });

      setSwapStep('confirm');
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') throw new Error('Swap transaction reverted on-chain.');

      setLastReceivedAmount(amountOut);
      setSuccessTx(txHash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Swap failed';
      setError(/reject|cancel|denied/i.test(msg) ? 'Transaction cancelled.' : msg);
    } finally {
      setSwapping(false);
      setSwapStep('');
    }
  }, [effTokenIn, effTokenOut, amountIn, amountOut, quote, canWrite, address, publicClient, universalWrite, sendTransaction]);

  const canSwap = !!effTokenIn && !!effTokenOut && !!amountIn && parseFloat(amountIn) > 0 && !!quote && !swapping && !quoting && canWrite;

  // ── Quote panel figures — all derived straight from the live LI.FI quote ──
  let priceLabel: string | null = null;
  let feesLabel:  string | null = null;
  let timeLabel:  string | null = null;
  if (quote && effTokenIn && effTokenOut) {
    const fromAmt = parseFloat(fromRawAmount(quote.estimate.fromAmount, effTokenIn.decimals));
    const toAmt   = parseFloat(fromRawAmount(quote.estimate.toAmount, effTokenOut.decimals));
    if (fromAmt > 0) {
      const rate = toAmt / fromAmt;
      priceLabel = `1 ${effTokenIn.symbol} = ~${rate.toFixed(rate < 1 ? 6 : 4)} ${effTokenOut.symbol}`;
    }
    const allCosts = [...(quote.estimate.feeCosts ?? []), ...(quote.estimate.gasCosts ?? [])];
    const totalUsd = allCosts.reduce((sum, c) => sum + (c.amountUSD ? parseFloat(c.amountUSD) : 0), 0);
    feesLabel = allCosts.length ? `$${totalUsd.toFixed(2)}` : 'No provider fee';
    if (quote.estimate.executionDuration) timeLabel = `~${quote.estimate.executionDuration} secs`;
  }

  return (
    <NetworkGuard>
      <AppLayout title="Swap">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <button onClick={() => router.push('/wallet')} style={{
            display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none',
            cursor: 'pointer', color: '#64748B', fontSize: 13, fontWeight: 500, padding: 0, marginBottom: 0,
            fontFamily: 'inherit',
          }}>
            <ArrowLeft size={15} /> Back to Wallet
          </button>

          {!isConnected && (
            <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 20, padding: 32, textAlign: 'center' }}>
              <p style={{ color: '#64748B', fontSize: 14 }}>Connect your wallet to swap tokens.</p>
            </div>
          )}

          {isConnected && (
            <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 20, padding: 24 }}>
              <h2 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', marginBottom: 20 }}>Swap Tokens</h2>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <TokenBox
                  label="From"
                  token={tokenIn}
                  excludeToken={tokenOut?.symbol}
                  amount={amountIn}
                  editable
                  onTokenChange={setTokenIn}
                  onAmountChange={setAmountIn}
                  balance={balanceIn}
                  balanceLoading={balanceInLoading}
                />

                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <button onClick={swapTokens}
                    style={{
                      width: 36, height: 36, borderRadius: '50%',
                      background: '#fff', border: '2px solid #E2E8F0',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.08)', transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#EEF2FF'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#fff'; }}
                  >
                    <ArrowDown size={16} color="#4F46E5" />
                  </button>
                </div>

                <TokenBox
                  label="To (estimated)"
                  token={tokenOut}
                  excludeToken={tokenIn?.symbol}
                  amount={amountOut}
                  editable={false}
                  onTokenChange={setTokenOut}
                  loading={quoting}
                  balance={balanceOut}
                  balanceLoading={balanceOutLoading}
                />
              </div>

              {quoteError && !quoting && (
                <p style={{ fontSize: 12, color: '#D97706', marginTop: 10, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <AlertTriangle size={12} /> {quoteError}
                </p>
              )}

              {quote && !quoting && (
                <div style={{
                  background: '#F8FAFC', border: '1px solid #F1F5F9', borderRadius: 14,
                  padding: '12px 16px', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8,
                }}>
                  {priceLabel && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 12, color: '#94A3B8' }}>Price</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#0F172A' }}>{priceLabel}</span>
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, color: '#94A3B8' }}>Minimum received</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#0F172A' }}>
                      {fromRawAmount(quote.estimate.toAmountMin, effTokenOut?.decimals ?? 6)} {effTokenOut?.symbol}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, color: '#94A3B8' }}>Fees</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#0F172A' }}>{feesLabel}</span>
                  </div>
                  {timeLabel && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 12, color: '#94A3B8' }}>Estimated time</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#0F172A' }}>{timeLabel}</span>
                    </div>
                  )}
                </div>
              )}

              {swapping && swapStep && <StepProgress currentStep={swapStep} />}

              {error && (
                <div style={{ marginTop: 14, padding: '10px 14px', background: '#FEF2F2', borderRadius: 10, fontSize: 13, color: '#DC2626' }}>
                  {error}
                </div>
              )}

              <button
                onClick={handleSwap}
                disabled={!canSwap}
                style={{
                  width: '100%', marginTop: 18, padding: '14px 0', borderRadius: 12,
                  background: !canSwap ? '#E2E8F0' : '#14B8A6',
                  border: 'none', color: !canSwap ? '#94A3B8' : '#fff',
                  fontSize: 15, fontWeight: 700, cursor: !canSwap ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}
              >
                {swapping ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Swapping…</> : 'Swap'}
              </button>

              <p style={{ textAlign: 'center', fontSize: 11, color: '#CBD5E1', marginTop: 12 }}>
                Powered by LI.FI
              </p>
            </div>
          )}
        </div>

        {/* Success modal */}
        {successTx && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <div style={{ background: '#fff', borderRadius: 20, padding: 32, maxWidth: 380, width: '100%', textAlign: 'center', position: 'relative' }}>
              <button onClick={() => { setSuccessTx(null); setAmountIn(''); }}
                style={{ position: 'absolute', top: 16, right: 16, background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8' }}>
                <X size={20} />
              </button>
              <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#059669', boxShadow: '0 0 0 8px rgba(5,150,105,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <CheckCircle2 size={32} color="#fff" fill="#059669" />
              </div>
              <h3 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', marginBottom: 8 }}>Swap Successful</h3>
              {lastReceivedAmount && (
                <p style={{ fontSize: 14, color: '#64748B', marginBottom: 12 }}>
                  Received <strong style={{ color: '#0F172A' }}>~{lastReceivedAmount} {tokenOut?.symbol}</strong>
                </p>
              )}
              {successTx && (
                <a href={txLink(successTx)} target="_blank" rel="noreferrer"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#4F46E5', fontFamily: "'JetBrains Mono', monospace", textDecoration: 'none' }}>
                  {successTx.slice(0, 10)}…{successTx.slice(-6)} <ExternalLink size={13} />
                </a>
              )}
            </div>
          </div>
        )}

        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </AppLayout>
    </NetworkGuard>
  );
}
