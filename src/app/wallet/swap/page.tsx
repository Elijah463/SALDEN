'use client';
/**
 * @file app/wallet/swap/page.tsx
 *
 * Real swap using Circle Arc App Kit (kit.swap()).
 * No mocked rates, no fake tx hashes, no hardcoded logic.
 *
 * PACKAGES REQUIRED (add to package.json before deploying):
 *   npm install @circle-fin/app-kit @circle-fin/adapter-viem-v2
 *
 * ENV REQUIRED:
 *   NEXT_PUBLIC_KIT_KEY=<your kit key from Circle Console>
 *
 * Flow:
 *   1. User selects tokenIn + tokenOut + amount
 *   2. kit.swap() is called with KIT_KEY — Circle routes via on-chain DEX
 *   3. Real tx hash returned → shown with ArcScan link
 *   4. amountOut from result shown (not a hardcoded rate)
 *
 * Supported tokens on Arc Testnet: USDC, EURC, cirBTC
 */

import { useState, useCallback, useEffect } from 'react';
import { useRouter }           from 'next/navigation';
import {
  ArrowLeft, ArrowDown, ChevronDown, Loader2,
  ExternalLink, CheckCircle2, X, AlertTriangle,
} from 'lucide-react';
import { AppLayout }           from '@/components/layout/AppLayout';
import { NetworkGuard }        from '@/components/shared/NetworkGuard';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { useCircleAdapter }    from '@/lib/circle/useCircleAdapter';
import { getAppKit }           from '@/lib/circle/appKit';
import { txLink }              from '@/lib/contracts/config';

// ── Supported tokens on Arc Testnet ─────────────────────────────────────────

type ChainToken = 'USDC' | 'EURC' | 'cirBTC';

interface TokenMeta {
  symbol:   ChainToken;
  name:     string;
  color:    string;
  bg:       string;
  icon:     string;     // emoji or short char for simplicity
}

const TOKENS: TokenMeta[] = [
  { symbol: 'USDC',   name: 'USD Coin',      color: '#2775CA', bg: '#EFF6FF', icon: '$' },
  { symbol: 'EURC',   name: 'Euro Coin',      color: '#1B3A6B', bg: '#EEF2FF', icon: '€' },
  { symbol: 'cirBTC', name: 'Circle Bitcoin', color: '#F7931A', bg: '#FFF7ED', icon: '₿' },
];

// ── Token Selector ───────────────────────────────────────────────────────────

function TokenIcon({ token, size = 28 }: { token: TokenMeta; size?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: token.color,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, color: '#fff', fontWeight: 800,
      fontSize: size * 0.42,
    }}>
      {token.icon}
    </div>
  );
}

function TokenSelector({
  value, exclude, onChange,
}: { value: TokenMeta | null; exclude?: ChainToken; onChange: (t: TokenMeta) => void }) {
  const [open, setOpen] = useState(false);
  const options = TOKENS.filter(t => t.symbol !== exclude);

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(p => !p)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '8px 12px', borderRadius: 99,
          background: '#fff', border: '1.5px solid #E2E8F0',
          cursor: 'pointer', fontFamily: 'inherit',
          fontWeight: 700, fontSize: 14, color: '#0F172A',
          minWidth: 130,
        }}
      >
        {value
          ? <><TokenIcon token={value} size={20} /> {value.symbol}</>
          : <span style={{ color: '#4F46E5' }}>Select</span>
        }
        <ChevronDown size={13} color="#94A3B8" style={{ marginLeft: 'auto' }} />
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 10 }} />
          <div style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 8, zIndex: 20,
            background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12,
            boxShadow: '0 8px 24px rgba(0,0,0,0.10)', minWidth: 180, overflow: 'hidden',
          }}>
            {options.map(t => (
              <button key={t.symbol}
                onClick={() => { onChange(t); setOpen(false); }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                  padding: '12px 16px', background: 'none', border: 'none',
                  cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#F8F9FA'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
              >
                <TokenIcon token={t} size={22} />
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{t.symbol}</div>
                  <div style={{ fontSize: 11, color: '#94A3B8' }}>{t.name}</div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Token input box ──────────────────────────────────────────────────────────

function TokenBox({
  label, token, excludeToken, amount, editable,
  onTokenChange, onAmountChange, loading,
}: {
  label:          string;
  token:          TokenMeta | null;
  excludeToken?:  ChainToken;
  amount:         string;
  editable:       boolean;
  onTokenChange:  (t: TokenMeta) => void;
  onAmountChange?: (v: string) => void;
  loading?:       boolean;
}) {
  return (
    <div style={{
      background: '#F8F9FA', borderRadius: 16, padding: '16px 18px',
      border: '1.5px solid #F1F5F9',
    }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#94A3B8',
        textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 10 }}>
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <TokenSelector value={token} exclude={excludeToken} onChange={onTokenChange} />
        <div style={{ flex: 1, textAlign: 'right' }}>
          {editable ? (
            <input
              type="number" value={amount} min="0" step="any"
              onChange={e => onAmountChange?.(e.target.value)}
              placeholder="0.00"
              style={{
                width: '100%', background: 'none', border: 'none', outline: 'none',
                fontSize: 24, fontWeight: 800, color: '#0F172A',
                textAlign: 'right', fontFamily: "'JetBrains Mono', monospace",
              }}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', minHeight: 36 }}>
              {loading
                ? <Loader2 size={20} color="#94A3B8" style={{ animation: 'spin 0.7s linear infinite' }} />
                : <span style={{ fontSize: 24, fontWeight: 800, color: '#0F172A',
                    fontFamily: "'JetBrains Mono', monospace" }}>
                    {amount || '—'}
                  </span>
              }
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Step progress ────────────────────────────────────────────────────────────

const SWAP_STEPS = [
  { key: 'approve', label: 'Approve token spending' },
  { key: 'swap',    label: 'Execute swap on-chain'  },
  { key: 'confirm', label: 'Confirm transaction'    },
] as const;

function StepProgress({ currentStep }: { currentStep: string }) {
  return (
    <div style={{ marginTop: 16 }}>
      {SWAP_STEPS.map((step, i) => {
        const done    = SWAP_STEPS.findIndex(s => s.key === currentStep) > i;
        const active  = step.key === currentStep;
        return (
          <div key={step.key} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <div style={{
              width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
              background: done ? '#14B8A6' : active ? '#4F46E5' : '#E2E8F0',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {done
                ? <CheckCircle2 size={13} color="#fff" />
                : active
                  ? <Loader2 size={13} color="#fff" style={{ animation: 'spin 0.7s linear infinite' }} />
                  : <span style={{ fontSize: 10, color: '#94A3B8', fontWeight: 700 }}>{i + 1}</span>
              }
            </div>
            <span style={{ fontSize: 13, color: done ? '#14B8A6' : active ? '#4F46E5' : '#94A3B8', fontWeight: active ? 700 : 500 }}>
              {step.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

type SwapStep = 'approve' | 'swap' | 'confirm' | '';

export default function SwapPage() {
  const router = useRouter();
  const { isConnected, loginMethod } = useEffectiveAddress();
  const { adapter, isAdapterReady, loading: adapterLoading, error: adapterError } = useCircleAdapter();

  const [tokenIn,   setTokenIn]   = useState<TokenMeta | null>(null);
  const [tokenOut,  setTokenOut]  = useState<TokenMeta | null>(null);
  const [amountIn,  setAmountIn]  = useState('');
  const [amountOut, setAmountOut] = useState('');
  const [swapping,  setSwapping]  = useState(false);
  const [swapStep,  setSwapStep]  = useState<SwapStep>('');
  const [error,     setError]     = useState('');
  const [successTx, setSuccessTx] = useState<string | null>(null);

  const kitKey = process.env.NEXT_PUBLIC_KIT_KEY ?? '';

  function swapTokens() {
    const tmpIn  = tokenIn;
    const tmpAmt = amountOut;
    setTokenIn(tokenOut);
    setTokenOut(tmpIn);
    setAmountIn(tmpAmt);
    setAmountOut('');
  }

  // Clear amountOut when inputs change
  useEffect(() => { setAmountOut(''); }, [tokenIn, tokenOut, amountIn]);

  const handleSwap = useCallback(async () => {
    if (!tokenIn || !tokenOut || !amountIn || parseFloat(amountIn) <= 0) return;
    if (!adapter || !isAdapterReady) {
      setError('Wallet adapter not ready. Please ensure your wallet is connected.');
      return;
    }
    if (!kitKey) {
      setError('Kit key not configured. Set NEXT_PUBLIC_KIT_KEY in your environment.');
      return;
    }

    setSwapping(true);
    setError('');
    setAmountOut('');

    try {
      setSwapStep('approve');
      const kit = await getAppKit();

      // Real kit.swap() call — no simulation, no fake hashes
      const result = await kit.swap({
        from: {
          adapter,
          chain: 'Arc_Testnet',
          // Same type-only gap as bridge/page.tsx's kit.bridge() call:
          // createAdapterFromProvider() (adapter-viem-v2) declares a
          // narrower return type than kit.swap() (app-kit) requires —
          // missing getTokenDecimals in its TS signature even though the
          // concrete ViemAdapter instance it builds has the full method
          // set. Cast anchored to kit.swap's own parameter type (not a
          // hand-typed guess) so it self-corrects if the packages
          // realign. See bridge/page.tsx for the fuller writeup.
        } as unknown as Parameters<typeof kit.swap>[0]['from'],
        tokenIn:  tokenIn.symbol,
        tokenOut: tokenOut.symbol,
        amountIn: amountIn,
        config: {
          kitKey,
        },
      });

      setSwapStep('confirm');

      // amountOut comes from the real swap result
      const outAmount = (result as { amountOut?: string }).amountOut;
      setAmountOut(outAmount ?? '');

      // txHash comes from the real on-chain transaction
      const txHash = (result as { txHash?: string; transactionHash?: string })
        .txHash ?? (result as { transactionHash?: string }).transactionHash ?? '';

      setSuccessTx(txHash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Swap failed';
      if (/reject|cancel|denied/i.test(msg)) {
        setError('Transaction cancelled.');
      } else {
        setError(msg);
      }
    } finally {
      setSwapping(false);
      setSwapStep('');
    }
  }, [tokenIn, tokenOut, amountIn, adapter, isAdapterReady, kitKey]);

  const canSwap = tokenIn && tokenOut && amountIn && parseFloat(amountIn) > 0 && !swapping && isAdapterReady;

  // ── External-wallet-only notice ──────────────────────────────────────────
  // NOTE: this used to infer "must be Circle social login" purely from
  // "the adapter isn't ready yet" (isConnected && !isAdapterReady &&
  // !adapterLoading) — but the adapter can fail to become ready for a
  // genuinely external wallet too (a slow/failed provider resolution,
  // an adapter construction error), which wrongly told real
  // external-wallet users they needed to connect an external wallet.
  // Check the actual login method instead — it's the real source of
  // truth, not an inference from adapter state.
  const isCircleSocialLogin = loginMethod === 'circle';

  return (
    <NetworkGuard>
      <AppLayout title="Swap">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <button onClick={() => router.back()}
            style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#4F46E5', fontFamily: 'inherit', padding: 0 }}>
            <ArrowLeft size={16} /> Back
          </button>

          {/* No wallet */}
          {!isConnected && (
            <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 20, padding: 32, textAlign: 'center' }}>
              <p style={{ color: '#64748B', fontSize: 14 }}>Connect your wallet to swap tokens.</p>
            </div>
          )}

          {/* Circle social login notice */}
          {isCircleSocialLogin && (
            <div style={{ background: '#FFFBEB', border: '1px solid #FED7AA', borderRadius: 14, padding: '14px 18px', display: 'flex', gap: 12 }}>
              <AlertTriangle size={18} color="#D97706" style={{ flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#92400E', marginBottom: 4 }}>External wallet required for Swap</div>
                <div style={{ fontSize: 13, color: '#78350F', lineHeight: 1.6 }}>
                  Circle App Kit Swap requires a browser wallet (MetaMask, Rabby, etc.) connected via WalletConnect or injected provider. Please connect an external wallet to use Swap.
                </div>
              </div>
            </div>
          )}

          {/* Adapter error */}
          {adapterError && (
            <div style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 14, padding: '12px 16px', fontSize: 13, color: '#DC2626' }}>
              {adapterError}
            </div>
          )}

          {isConnected && !isCircleSocialLogin && (
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
                  loading={swapping && swapStep === 'swap'}
                />
              </div>

              {/* Notice: actual output determined by on-chain execution */}
              {tokenIn && tokenOut && amountIn && (
                <p style={{ fontSize: 12, color: '#94A3B8', marginTop: 10, lineHeight: 1.5 }}>
                  Actual output determined by Circle App Kit on-chain execution. Rate varies by market conditions.
                </p>
              )}

              {/* Step progress during swap */}
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

              <div style={{ marginTop: 12, padding: '10px 14px', background: '#F8F9FA', borderRadius: 10 }}>
                <p style={{ fontSize: 12, color: '#64748B', margin: 0 }}>
                  Powered by Circle Arc App Kit — on-chain DEX routing on Arc Testnet.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Success modal */}
        {successTx && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <div style={{ background: '#fff', borderRadius: 20, padding: 32, maxWidth: 380, width: '100%', textAlign: 'center', position: 'relative' }}>
              <button onClick={() => { setSuccessTx(null); setAmountIn(''); setAmountOut(''); }}
                style={{ position: 'absolute', top: 16, right: 16, background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8' }}>
                <X size={20} />
              </button>
              <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#ECFDF5', border: '2px solid #6EE7B7', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <CheckCircle2 size={32} color="#059669" />
              </div>
              <h3 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', marginBottom: 8 }}>Swap Successful</h3>
              {amountOut && (
                <p style={{ fontSize: 14, color: '#64748B', marginBottom: 12 }}>
                  Received <strong style={{ color: '#0F172A' }}>{amountOut} {tokenOut?.symbol}</strong>
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
