'use client';
/**
 * @file app/wallet/bridge/page.tsx
 *
 * Real cross-chain bridge using Circle Arc App Kit (kit.bridge()) + CCTP v2.
 *
 * PACKAGES REQUIRED:
 *   npm install @circle-fin/app-kit @circle-fin/adapter-viem-v2
 *
 * Forwarder / gasless destination:
 *   Circle's Orbit relayer handles attestation and minting on the destination
 *   chain automatically. Users do NOT need gas tokens on the destination chain.
 *   We use "forwarder-only" mode: the `to` object has no adapter — just
 *   { chain, recipientAddress }. Circle's infrastructure mints USDC directly
 *   to the recipient without requiring them to sign or pay on the destination.
 *
 * Supported routes (Arc Testnet → destination):
 *   - Arc Testnet  → Ethereum Sepolia
 *   - Arc Testnet  → Base Sepolia
 *   - Arc Testnet  → Arbitrum Sepolia
 *   - Ethereum Sepolia → Arc Testnet  (reverse)
 *   - Base Sepolia     → Arc Testnet  (reverse)
 *
 * Result:
 *   result.state    — 'complete' | 'error' | 'pending'
 *   result.steps    — step-by-step trace of the bridge execution
 *   result.txHash   — source chain tx hash
 */

import { useState, useCallback } from 'react';
import { useRouter }             from 'next/navigation';
import {
  ArrowLeft, ArrowRight, Loader2, CheckCircle2,
  X, ExternalLink, AlertTriangle, GitMerge, ChevronDown,
} from 'lucide-react';
import { AppLayout }           from '@/components/layout/AppLayout';
import { NetworkGuard }        from '@/components/shared/NetworkGuard';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { useCircleAdapter }    from '@/lib/circle/useCircleAdapter';
import { getAppKit }           from '@/lib/circle/appKit';
import { txLink }              from '@/lib/contracts/config';

// ── Supported routes ─────────────────────────────────────────────────────────

type AppKitChain =
  | 'Arc_Testnet'
  | 'Ethereum_Sepolia'
  | 'Base_Sepolia'
  | 'Arbitrum_Sepolia';

interface BridgeRoute {
  fromChain: AppKitChain;
  toChain:   AppKitChain;
  fromLabel: string;
  toLabel:   string;
  eta:       string;
}

const ROUTES: BridgeRoute[] = [
  { fromChain: 'Arc_Testnet',      toChain: 'Ethereum_Sepolia', fromLabel: 'Arc Testnet',       toLabel: 'Ethereum Sepolia', eta: '~2 min' },
  { fromChain: 'Arc_Testnet',      toChain: 'Base_Sepolia',     fromLabel: 'Arc Testnet',       toLabel: 'Base Sepolia',     eta: '~2 min' },
  { fromChain: 'Arc_Testnet',      toChain: 'Arbitrum_Sepolia', fromLabel: 'Arc Testnet',       toLabel: 'Arbitrum Sepolia', eta: '~3 min' },
  { fromChain: 'Ethereum_Sepolia', toChain: 'Arc_Testnet',      fromLabel: 'Ethereum Sepolia',  toLabel: 'Arc Testnet',      eta: '~2 min' },
  { fromChain: 'Base_Sepolia',     toChain: 'Arc_Testnet',      fromLabel: 'Base Sepolia',      toLabel: 'Arc Testnet',      eta: '~2 min' },
];

// ── Bridge step display ──────────────────────────────────────────────────────

interface BridgeStep {
  key:    string;
  label:  string;
  state:  'pending' | 'active' | 'done' | 'error';
}

function BridgeStepList({ steps }: { steps: BridgeStep[] }) {
  return (
    <div style={{ marginTop: 16 }}>
      {steps.map(step => (
        <div key={step.key} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div style={{
            width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
            background: step.state === 'done' ? '#14B8A6'
              : step.state === 'active' ? '#4F46E5'
              : step.state === 'error' ? '#DC2626'
              : '#E2E8F0',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {step.state === 'done'
              ? <CheckCircle2 size={13} color="#fff" />
              : step.state === 'active'
                ? <Loader2 size={13} color="#fff" style={{ animation: 'spin 0.7s linear infinite' }} />
              : step.state === 'error'
                ? <X size={12} color="#fff" />
              : null
            }
          </div>
          <span style={{
            fontSize: 13, fontWeight: step.state === 'active' ? 700 : 500,
            color: step.state === 'done' ? '#14B8A6'
              : step.state === 'active' ? '#4F46E5'
              : step.state === 'error' ? '#DC2626'
              : '#94A3B8',
          }}>
            {step.label}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function BridgePage() {
  const router = useRouter();
  const { address, isConnected } = useEffectiveAddress();
  const { adapter, isAdapterReady, loading: adapterLoading, error: adapterError } = useCircleAdapter();

  const [selectedRoute, setSelectedRoute] = useState<BridgeRoute>(ROUTES[0]);
  const [amount,        setAmount]        = useState('');
  const [bridging,      setBridging]      = useState(false);
  const [bridgeSteps,   setBridgeSteps]   = useState<BridgeStep[]>([]);
  const [error,         setError]         = useState('');
  const [successTx,     setSuccessTx]     = useState<string | null>(null);
  const [routeOpen,     setRouteOpen]     = useState(false);

  const INITIAL_STEPS: BridgeStep[] = [
    { key: 'approve',     label: 'Approve USDC spending',                 state: 'pending' },
    { key: 'burn',        label: 'Burn USDC on source chain (CCTP v2)',   state: 'pending' },
    { key: 'attest',      label: 'Circle Orbit relayer attesting…',       state: 'pending' },
    { key: 'mint',        label: 'Mint USDC on destination (gasless)',    state: 'pending' },
  ];

  function setStep(key: string, state: BridgeStep['state']) {
    setBridgeSteps(prev =>
      prev.map(s => s.key === key ? { ...s, state } : s)
    );
  }

  const handleBridge = useCallback(async () => {
    if (!amount || parseFloat(amount) <= 0) { setError('Enter an amount.'); return; }
    if (!adapter || !isAdapterReady) { setError('Connect an external wallet to bridge.'); return; }
    if (!address) return;

    setBridging(true);
    setError('');
    setBridgeSteps(INITIAL_STEPS);

    try {
      const kit = await getAppKit();

      setStep('approve', 'active');

      /**
       * Forwarder-only bridge (gasless on destination):
       *   - `from` has the adapter (user signs on source chain)
       *   - `to` has only chain + recipientAddress — NO adapter
       *   - Circle's Orbit relayer handles attestation + minting
       *   - User pays gas ONLY on the source chain (Arc Testnet uses USDC as gas)
       *   - Destination chain requires zero gas from the user
       */
      const result = await kit.bridge({
        from: {
          adapter,
          chain: selectedRoute.fromChain,
        },
        to: {
          chain:            selectedRoute.toChain,
          recipientAddress: address,    // USDC minted directly to user's address
        } as Parameters<typeof kit.bridge>[0]['to'],
        amount,
      });

      // Map SDK result steps to our display steps
      const sdkSteps = (result as { steps?: Array<{ name?: string; state?: string }> }).steps ?? [];
      for (const sdkStep of sdkSteps) {
        const name = (sdkStep.name ?? '').toLowerCase();
        if (name.includes('approv')) {
          setStep('approve', sdkStep.state === 'complete' ? 'done' : sdkStep.state === 'error' ? 'error' : 'active');
        } else if (name.includes('burn') || name.includes('deposit')) {
          setStep('burn', sdkStep.state === 'complete' ? 'done' : sdkStep.state === 'error' ? 'error' : 'active');
        } else if (name.includes('attest') || name.includes('orbit')) {
          setStep('attest', sdkStep.state === 'complete' ? 'done' : sdkStep.state === 'error' ? 'error' : 'active');
        } else if (name.includes('mint') || name.includes('receive')) {
          setStep('mint', sdkStep.state === 'complete' ? 'done' : sdkStep.state === 'error' ? 'error' : 'active');
        }
      }

      // Mark all done on success
      const finalState = (result as { state?: string }).state;
      if (finalState === 'complete') {
        setBridgeSteps(INITIAL_STEPS.map(s => ({ ...s, state: 'done' as const })));
      }

      const txHash = (result as { txHash?: string; transactionHash?: string })
        .txHash ?? (result as { transactionHash?: string }).transactionHash ?? '';
      setSuccessTx(txHash);

    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Bridge failed';
      if (/reject|cancel|denied/i.test(msg)) {
        setError('Transaction cancelled.');
        setBridgeSteps([]);
      } else {
        setError(msg);
        setBridgeSteps(prev =>
          prev.map(s => s.state === 'active' ? { ...s, state: 'error' } : s)
        );
      }
    } finally {
      setBridging(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, adapter, isAdapterReady, address, selectedRoute]);

  const isCircleSocialLogin = isConnected && !isAdapterReady && !adapterLoading;
  const canBridge = amount && parseFloat(amount) > 0 && isAdapterReady && !bridging;

  return (
    <NetworkGuard>
      <AppLayout title="Bridge">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <button onClick={() => router.back()}
            style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#4F46E5', fontFamily: 'inherit', padding: 0 }}>
            <ArrowLeft size={16} /> Back
          </button>

          {/* Header card */}
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 20, padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
              <div style={{ width: 48, height: 48, borderRadius: 14, background: '#EEF2FF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <GitMerge size={22} color="#4F46E5" />
              </div>
              <div>
                <h2 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', margin: 0 }}>Bridge USDC</h2>
                <p style={{ fontSize: 13, color: '#64748B', margin: 0 }}>
                  Powered by Circle CCTP v2 + Orbit forwarder
                </p>
              </div>
            </div>

            {/* Gasless notice */}
            <div style={{ display: 'flex', gap: 10, padding: '12px 14px', background: '#ECFDF5', border: '1px solid #6EE7B7', borderRadius: 12, marginBottom: 20 }}>
              <CheckCircle2 size={16} color="#059669" style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 13, color: '#065F46', lineHeight: 1.6 }}>
                <strong>No destination gas required.</strong> Circle&apos;s Orbit relayer handles attestation and minting on the destination chain. You only pay gas on the source chain.
              </div>
            </div>

            {/* Circle social login notice */}
            {isCircleSocialLogin && (
              <div style={{ display: 'flex', gap: 10, padding: '12px 14px', background: '#FFFBEB', border: '1px solid #FED7AA', borderRadius: 12, marginBottom: 20 }}>
                <AlertTriangle size={16} color="#D97706" style={{ flexShrink: 0 }} />
                <div style={{ fontSize: 13, color: '#92400E', lineHeight: 1.6 }}>
                  <strong>External wallet required.</strong> Circle App Kit Bridge requires a browser wallet (MetaMask, Rabby, etc.). Connect an external wallet to bridge.
                </div>
              </div>
            )}

            {adapterError && (
              <div style={{ fontSize: 13, color: '#DC2626', marginBottom: 14 }}>{adapterError}</div>
            )}

            {/* Route selector */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 8 }}>
                Route
              </label>
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => setRouteOpen(p => !p)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 14px', borderRadius: 12, border: '1.5px solid #E2E8F0',
                    background: '#fff', cursor: 'pointer', fontFamily: 'inherit',
                    fontSize: 14, fontWeight: 600, color: '#0F172A',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>{selectedRoute.fromLabel}</span>
                    <ArrowRight size={14} color="#94A3B8" />
                    <span>{selectedRoute.toLabel}</span>
                    <span style={{ fontSize: 12, color: '#14B8A6', fontWeight: 700 }}>{selectedRoute.eta}</span>
                  </span>
                  <ChevronDown size={14} color="#94A3B8" />
                </button>

                {routeOpen && (
                  <>
                    <div onClick={() => setRouteOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 10 }} />
                    <div style={{
                      position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 6, zIndex: 20,
                      background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12,
                      boxShadow: '0 8px 24px rgba(0,0,0,0.10)', overflow: 'hidden',
                    }}>
                      {ROUTES.map((route, i) => (
                        <button key={i}
                          onClick={() => { setSelectedRoute(route); setRouteOpen(false); }}
                          style={{
                            width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                            padding: '12px 16px', background: selectedRoute === route ? '#EEF2FF' : 'none',
                            border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                            fontSize: 14, fontWeight: 600, color: '#0F172A', textAlign: 'left',
                          }}
                          onMouseEnter={e => { if (selectedRoute !== route) (e.currentTarget as HTMLButtonElement).style.background = '#F8F9FA'; }}
                          onMouseLeave={e => { if (selectedRoute !== route) (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
                        >
                          {route.fromLabel}
                          <ArrowRight size={13} color="#94A3B8" />
                          {route.toLabel}
                          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#14B8A6', fontWeight: 700 }}>{route.eta}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Amount */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 8 }}>
                Amount (USDC)
              </label>
              <input
                type="number" value={amount} min="0" step="any"
                onChange={e => { setAmount(e.target.value); setError(''); }}
                placeholder="0.00"
                style={{
                  width: '100%', padding: '12px 14px', border: '1.5px solid #E2E8F0',
                  borderRadius: 10, fontFamily: 'inherit', fontSize: 16, fontWeight: 700,
                  color: '#0F172A', background: '#fff', outline: 'none', boxSizing: 'border-box',
                }}
                onFocus={e => { e.target.style.borderColor = '#4F46E5'; }}
                onBlur={e => { e.target.style.borderColor = '#E2E8F0'; }}
              />
              <p style={{ fontSize: 12, color: '#94A3B8', marginTop: 6 }}>
                Recipient: {address ? `${address.slice(0, 8)}…${address.slice(-6)}` : 'Connect wallet'}
              </p>
            </div>

            {/* Step progress during bridge */}
            {bridging && bridgeSteps.length > 0 && (
              <BridgeStepList steps={bridgeSteps} />
            )}

            {error && (
              <div style={{ marginBottom: 14, padding: '10px 14px', background: '#FEF2F2', borderRadius: 10, fontSize: 13, color: '#DC2626' }}>
                {error}
              </div>
            )}

            <button
              onClick={handleBridge}
              disabled={!canBridge}
              style={{
                width: '100%', padding: '14px 0', borderRadius: 12,
                background: !canBridge ? '#E2E8F0' : '#4F46E5',
                border: 'none', color: !canBridge ? '#94A3B8' : '#fff',
                fontSize: 15, fontWeight: 700, cursor: !canBridge ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                transition: 'background 0.15s',
              }}
            >
              {bridging
                ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Bridging…</>
                : <>Bridge USDC <ArrowRight size={16} /></>
              }
            </button>
          </div>
        </div>

        {/* Success modal */}
        {successTx && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <div style={{ background: '#fff', borderRadius: 20, padding: 32, maxWidth: 380, width: '100%', textAlign: 'center', position: 'relative' }}>
              <button onClick={() => { setSuccessTx(null); setAmount(''); setBridgeSteps([]); }}
                style={{ position: 'absolute', top: 16, right: 16, background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8' }}>
                <X size={20} />
              </button>
              <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#ECFDF5', border: '2px solid #6EE7B7', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <CheckCircle2 size={32} color="#059669" />
              </div>
              <h3 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', marginBottom: 8 }}>Bridge Initiated</h3>
              <p style={{ fontSize: 14, color: '#64748B', marginBottom: 16, lineHeight: 1.6 }}>
                USDC is being transferred from {selectedRoute.fromLabel} to {selectedRoute.toLabel}.
                Circle&apos;s Orbit relayer will mint to your address on the destination chain.
              </p>
              {successTx && (
                <>
                  <p style={{ fontSize: 12, color: '#94A3B8', marginBottom: 4 }}>Source tx</p>
                  <a href={txLink(successTx)} target="_blank" rel="noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#4F46E5', fontFamily: "'JetBrains Mono', monospace", textDecoration: 'none' }}>
                    {successTx.slice(0, 10)}…{successTx.slice(-6)} <ExternalLink size={13} />
                  </a>
                </>
              )}
            </div>
          </div>
        )}

        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </AppLayout>
    </NetworkGuard>
  );
}
