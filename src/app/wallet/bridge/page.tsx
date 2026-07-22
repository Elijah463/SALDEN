'use client';
/**
 * @file app/wallet/bridge/page.tsx
 *
 * Real cross-chain bridge using Circle Arc App Kit (kit.bridge()) + CCTP v2.
 * Execution stays entirely on Circle's forwarder-only CCTP bridge (already
 * built here) — LI.FI is used only for the supplementary "≈ $X.XX" price
 * hint below the amount, never for routing or execution. USDC-to-USDC CCTP
 * transfers are 1:1 (no exchange rate to quote), so that's the extent of
 * what a pricing service adds here.
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
 * Supported chains (any pair, either direction) — confirmed against Circle's
 * official @circle-fin/bridge-kit package listing (21 supported CCTP
 * testnets, all six of these included):
 *   Arc Testnet, Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia,
 *   Avalanche Fuji, Linea Sepolia
 *
 * USDC contract addresses per chain are Circle's own official addresses
 * (developers.circle.com/stablecoins/usdc-contract-addresses / Circle's
 * public use-usdc skill reference), except Linea Sepolia, which isn't in
 * that particular table — confirmed instead via LineaScan's own token tag
 * ("Circle: USDC Token") on the contract.
 *
 * Result:
 *   result.state    — 'complete' | 'error' | 'pending'
 *   result.steps    — step-by-step trace of the bridge execution
 *   result.txHash   — source chain tx hash
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter }             from 'next/navigation';
import { createPublicClient, http, type Chain } from 'viem';
import { sepolia, baseSepolia, arbitrumSepolia, avalancheFuji, lineaSepolia } from 'viem/chains';
import {
  ArrowLeft, Loader2, CheckCircle2,
  X, ExternalLink, AlertTriangle, ArrowDownUp, ChevronDown, Wallet,
} from 'lucide-react';
import { AppLayout }           from '@/components/layout/AppLayout';
import { NetworkGuard }        from '@/components/shared/NetworkGuard';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { useCircleAdapter }    from '@/lib/circle/useCircleAdapter';
import { getAppKit }           from '@/lib/circle/appKit';
import { txLink, arcTestnet, CONTRACTS } from '@/lib/contracts/config';
import { ERC20_ABI }           from '@/lib/contracts/abis';

// ── Supported chains ─────────────────────────────────────────────────────────

type AppKitChain =
  | 'Arc_Testnet'
  | 'Ethereum_Sepolia'
  | 'Base_Sepolia'
  | 'Arbitrum_Sepolia'
  | 'Avalanche_Fuji'
  | 'Linea_Sepolia';

interface BridgeChainConfig {
  key:         AppKitChain;
  chainId:     number;
  name:        string;
  badgeLabel:  string;
  badgeColor:  string;
  usdcAddress: `0x${string}`;
  viemChain:   Chain;
}

// USDC uses 6 decimals on every one of these chains (Circle's own
// "6-decimal rule" — the only exception anywhere is Arc's *native gas*
// representation, which is a separate 18-decimal value never used for
// ERC-20 balance/transfer calls; see arcTestnet's own definition).
const USDC_DECIMALS = 6;

const BRIDGE_CHAINS: BridgeChainConfig[] = [
  { key: 'Arc_Testnet',       chainId: 5042002,  name: 'Arc Testnet',       badgeLabel: 'AR',  badgeColor: '#4F46E5', usdcAddress: CONTRACTS.USDC, viemChain: arcTestnet },
  { key: 'Ethereum_Sepolia',  chainId: 11155111, name: 'Ethereum Sepolia',  badgeLabel: 'ETH', badgeColor: '#627EEA', usdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', viemChain: sepolia },
  { key: 'Base_Sepolia',      chainId: 84532,    name: 'Base Sepolia',      badgeLabel: 'BA',  badgeColor: '#0052FF', usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', viemChain: baseSepolia },
  { key: 'Arbitrum_Sepolia',  chainId: 421614,   name: 'Arbitrum Sepolia',  badgeLabel: 'ARB', badgeColor: '#28A0F0', usdcAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', viemChain: arbitrumSepolia },
  { key: 'Avalanche_Fuji',    chainId: 43113,    name: 'Avalanche Fuji',    badgeLabel: 'AV',  badgeColor: '#E84142', usdcAddress: '0x5425890298aed601595a70AB815c96711a31Bc65', viemChain: avalancheFuji },
  { key: 'Linea_Sepolia',     chainId: 59141,    name: 'Linea Sepolia',     badgeLabel: 'LI',  badgeColor: '#61DFFF', usdcAddress: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff', viemChain: lineaSepolia },
];

function chainByKey(key: AppKitChain): BridgeChainConfig {
  return BRIDGE_CHAINS.find(c => c.key === key)!;
}

// Standalone read-only clients, independent of the app's wagmi config
// (which only registers Arc Testnet, since that's the only chain the rest
// of the app ever needs a *connected wallet* on) — these are only used for
// balance reads here, never for signing.
const publicClients = new Map<AppKitChain, ReturnType<typeof createPublicClient>>();
function clientFor(chain: BridgeChainConfig) {
  if (!publicClients.has(chain.key)) {
    publicClients.set(chain.key, createPublicClient({ chain: chain.viemChain, transport: http() }));
  }
  return publicClients.get(chain.key)!;
}

async function fetchUsdcBalance(chain: BridgeChainConfig, address: `0x${string}`): Promise<bigint | null> {
  try {
    const client = clientFor(chain);
    const balance = await client.readContract({
      address: chain.usdcAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [address],
    });
    return balance as bigint;
  } catch {
    return null;
  }
}

function formatUnits6(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac  = raw % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, '0').slice(0, 2)}`;
}

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

// ── Chain badge + selector ────────────────────────────────────────────────────

function ChainBadge({ chain, size = 26 }: { chain: BridgeChainConfig; size?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: chain.badgeColor, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <span style={{ fontSize: size * 0.36, fontWeight: 800, color: '#fff', letterSpacing: -0.3 }}>
        {chain.badgeLabel}
      </span>
    </div>
  );
}

function ChainSelector({
  label, value, onChange, exclude, disabled,
}: {
  label: string;
  value: AppKitChain;
  onChange: (key: AppKitChain) => void;
  exclude: AppKitChain;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = chainByKey(value);
  const options = BRIDGE_CHAINS.filter(c => c.key !== exclude);

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => !disabled && setOpen(p => !p)}
        disabled={disabled}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none',
          padding: 0, cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: '#94A3B8' }}>{label}</span>
        <ChainBadge chain={current} size={22} />
        <span style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{current.name}</span>
        {!disabled && <ChevronDown size={14} color="#94A3B8" />}
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 10 }} />
          <div style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 20,
            background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12,
            boxShadow: '0 8px 24px rgba(0,0,0,0.10)', overflow: 'hidden', minWidth: 220,
          }}>
            {options.map(c => (
              <button key={c.key}
                onClick={() => { onChange(c.key); setOpen(false); }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                  padding: '11px 14px', background: c.key === value ? '#F8FAFC' : 'none',
                  border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                }}
              >
                <ChainBadge chain={c} size={22} />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{c.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── USDC-only token selector (dropdown UI kept for consistency with the
// rest of the app, but only ever has one real option — per spec, the
// bridge only supports USDC) ─────────────────────────────────────────────────

function UsdcTokenPicker() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(p => !p)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, background: '#F8FAFC',
          border: '1px solid #E2E8F0', borderRadius: 10, padding: '7px 10px',
          cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/images/tokens/usdc.webp" alt="USDC" width={18} height={18} style={{ borderRadius: '50%', display: 'block', objectFit: 'cover' }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>USDC</span>
        <ChevronDown size={13} color="#94A3B8" />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 10 }} />
          <div style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 20,
            background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12,
            boxShadow: '0 8px 24px rgba(0,0,0,0.10)', overflow: 'hidden', minWidth: 160,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/images/tokens/usdc.webp" alt="USDC" width={20} height={20} style={{ borderRadius: '50%', display: 'block', objectFit: 'cover' }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>USDC</span>
            </div>
            <p style={{ fontSize: 11, color: '#94A3B8', padding: '0 14px 10px', margin: 0 }}>
              Only USDC is supported for bridging right now.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function BridgePage() {
  const router = useRouter();
  const { address, isConnected, loginMethod } = useEffectiveAddress();
  const { adapter, isAdapterReady, loading: adapterLoading, error: adapterError } = useCircleAdapter();
  // loginMethod is resolved independently of useCircleAdapter's own async
  // setup (wagmi's useConnectorClient() → dynamic import → adapter
  // creation), so it correctly identifies wallet type immediately instead
  // of waiting on — or misreading a timing gap in — that resolution.
  const isCircleSocialLogin = loginMethod === 'circle';
  const isExternalWallet    = loginMethod === 'external';

  const [fromKey,   setFromKey]   = useState<AppKitChain>('Arc_Testnet');
  const [toKey,     setToKey]     = useState<AppKitChain>('Ethereum_Sepolia');
  const [amount,    setAmount]    = useState('');
  const [bridging,      setBridging]      = useState(false);
  const [bridgeSteps,   setBridgeSteps]   = useState<BridgeStep[]>([]);
  const [error,         setError]         = useState('');
  const [successTx,     setSuccessTx]     = useState<string | null>(null);

  const fromChain = useMemo(() => chainByKey(fromKey), [fromKey]);
  const toChain   = useMemo(() => chainByKey(toKey), [toKey]);

  // ── Balance (of the FROM chain's USDC) + live USD price ─────────────────
  const [balance,      setBalance]      = useState<bigint | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [usdPrice,      setUsdPrice]     = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!address) { setBalance(null); return; }
    setBalanceLoading(true);
    fetchUsdcBalance(fromChain, address as `0x${string}`).then(b => {
      if (!cancelled) { setBalance(b); setBalanceLoading(false); }
    });
    return () => { cancelled = true; };
  }, [fromChain, address]);

  useEffect(() => {
    let cancelled = false;
    setUsdPrice(null); // reset immediately so a stale price never briefly shows for the new chain
    fetch(`/api/lifi/price?chainId=${fromChain.chainId}&token=${fromChain.usdcAddress}`)
      .then(res => res.ok ? res.json() : { price: null })
      .then(data => { if (!cancelled && data.price) setUsdPrice(Number(data.price.priceUSD)); })
      .catch(() => { /* USD hint is optional — silently omit on failure */ });
    return () => { cancelled = true; };
  }, [fromChain]);

  function handleSwapDirection() {
    setFromKey(toKey);
    setToKey(fromKey);
    setAmount('');
  }

  function handlePercent(pct: number) {
    if (!balance) return;
    const scaled = (balance * BigInt(pct)) / 100n;
    setAmount(formatUnits6(scaled));
  }

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
          chain: fromKey,
          // createAdapterFromProvider() (adapter-viem-v2) declares a return
          // type of ViemAdapter<Partial<AdapterCapabilities>> — narrower
          // than the full ViemAdapter it actually constructs under the
          // hood, so its TS signature is missing methods like
          // getTokenDecimals that kit.bridge() (app-kit) requires. This is
          // a type-only gap between two independently-versioned Circle
          // packages, not a missing runtime method — the concrete adapter
          // instance is a real ViemAdapter with the full method set either
          // way. Anchoring the cast to kit.bridge's OWN parameter type
          // (rather than hand-typing an interface we'd have to guess at)
          // means this self-corrects if a future version of either package
          // realigns the types — nothing to remember to revert.
          // Matches the same workaround already applied to `to` below.
          //
          // Needs the unknown-first double cast (not a single `as`) because
          // TS can't find enough structural overlap between our locally
          // typed `adapter` and the SDK's real Adapter<AdapterCapabilities>
          // to allow a direct cast — that's the same underlying type gap,
          // just enforced more strictly here since `adapter` is nested one
          // level down instead of being the cast target itself.
        } as unknown as Parameters<typeof kit.bridge>[0]['from'],
        to: {
          chain:            toKey,
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

      // Refresh balance after a successful bridge
      if (address) fetchUsdcBalance(fromChain, address as `0x${string}`).then(setBalance);

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
  }, [amount, adapter, isAdapterReady, address, fromKey, toKey, fromChain]);

  const canBridge = !!amount && parseFloat(amount) > 0 && isAdapterReady && !bridging;
  const usdValue = usdPrice && amount ? (parseFloat(amount) * usdPrice) : null;

  return (
    <NetworkGuard>
      <AppLayout title="Bridge">
        <div style={{ maxWidth: 480, margin: '0 auto' }}>
          <button onClick={() => router.push('/wallet')} style={{
            display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none',
            cursor: 'pointer', color: '#64748B', fontSize: 13, fontWeight: 500, padding: 0, marginBottom: 16,
            fontFamily: 'inherit',
          }}>
            <ArrowLeft size={15} /> Back to Wallet
          </button>

          {!isConnected && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px',
              background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 12, marginBottom: 16,
            }}>
              <Wallet size={16} color="#64748B" style={{ flexShrink: 0, marginTop: 1 }} />
              <p style={{ fontSize: 13, color: '#475569', margin: 0, lineHeight: 1.6 }}>
                Connect your wallet to bridge USDC across chains.
              </p>
            </div>
          )}

          {isConnected && isCircleSocialLogin && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px',
              background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 12, marginBottom: 16,
            }}>
              <AlertTriangle size={16} color="#D97706" style={{ flexShrink: 0, marginTop: 1 }} />
              <p style={{ fontSize: 13, color: '#92400E', margin: 0, lineHeight: 1.6 }}>
                Bridging currently requires an external wallet (like Rabby or MetaMask) — connect one to continue.
              </p>
            </div>
          )}

          {isExternalWallet && adapterLoading && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
              background: '#F0F9FF', border: '1px solid #BAE6FD', borderRadius: 12, marginBottom: 16,
            }}>
              <Loader2 size={15} color="#0284C7" style={{ animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />
              <p style={{ fontSize: 13, color: '#075985', margin: 0 }}>
                Preparing your wallet connection…
              </p>
            </div>
          )}

          {adapterError && !adapterLoading && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px',
              background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 12, marginBottom: 16,
            }}>
              <AlertTriangle size={16} color="#DC2626" style={{ flexShrink: 0, marginTop: 1 }} />
              <p style={{ fontSize: 13, color: '#991B1B', margin: 0, lineHeight: 1.6 }}>{adapterError}</p>
            </div>
          )}

          {/* From */}
          <div style={{ background: '#F8FAFC', border: '1px solid #F1F5F9', borderRadius: 16, padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <ChainSelector label="From" value={fromKey} onChange={setFromKey} exclude={toKey} />
              <div style={{ display: 'flex', gap: 6 }}>
                {[25, 50, 100].map(pct => (
                  <button key={pct} onClick={() => handlePercent(pct)} disabled={!balance}
                    style={{
                      padding: '4px 9px', borderRadius: 7, border: 'none',
                      background: '#EEF2FF', color: '#4F46E5', fontSize: 11, fontWeight: 700,
                      cursor: balance ? 'pointer' : 'not-allowed', fontFamily: 'inherit',
                    }}>
                    {pct}%
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <UsdcTokenPicker />
              <input
                type="text" inputMode="decimal"
                value={amount}
                onChange={e => { if (/^\d*\.?\d*$/.test(e.target.value)) setAmount(e.target.value); }}
                placeholder="0"
                style={{
                  flex: 1, textAlign: 'right', border: 'none', background: 'none', outline: 'none',
                  fontSize: 26, fontWeight: 700, color: '#0F172A', fontFamily: 'inherit', minWidth: 0,
                }}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
              <span style={{ fontSize: 12, color: '#94A3B8' }}>
                {usdValue !== null ? `≈ $${usdValue.toFixed(2)}` : ''}
              </span>
              <span style={{ fontSize: 12, color: '#94A3B8', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Wallet size={11} />
                {balanceLoading ? 'Loading…' : balance !== null ? `${formatUnits6(balance)} USDC` : '—'}
              </span>
            </div>
          </div>

          {/* Swap direction */}
          <div style={{ display: 'flex', justifyContent: 'center', margin: '-10px 0' }}>
            <button onClick={handleSwapDirection} style={{
              width: 36, height: 36, borderRadius: '50%', background: '#fff',
              border: '4px solid #fff', boxShadow: '0 0 0 1px #E2E8F0', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5,
              position: 'relative', color: '#4F46E5',
            }}>
              <ArrowDownUp size={15} />
            </button>
          </div>

          {/* To */}
          <div style={{ background: '#F8FAFC', border: '1px solid #F1F5F9', borderRadius: 16, padding: 16, marginTop: -10 }}>
            <div style={{ marginBottom: 14 }}>
              <ChainSelector label="To" value={toKey} onChange={setToKey} exclude={fromKey} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <UsdcTokenPicker />
              <span style={{ fontSize: 26, fontWeight: 700, color: '#94A3B8', fontFamily: 'inherit' }}>
                {amount || '0'}
              </span>
            </div>
            <p style={{ fontSize: 11, color: '#94A3B8', marginTop: 8, marginBottom: 0 }}>
              You&apos;ll receive this on {toChain.name} — no gas needed there, Circle&apos;s relayer covers it.
            </p>
          </div>

          {error && (
            <p style={{ fontSize: 13, color: '#DC2626', marginTop: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertTriangle size={13} /> {error}
            </p>
          )}

          <button
            onClick={handleBridge}
            disabled={!canBridge}
            style={{
              width: '100%', marginTop: 18, padding: '13px 0', borderRadius: 12, border: 'none',
              background: canBridge ? '#4F46E5' : '#E2E8F0',
              color: canBridge ? '#fff' : '#94A3B8',
              fontSize: 15, fontWeight: 700, cursor: canBridge ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            {bridging ? <Loader2 size={16} style={{ animation: 'spin 0.7s linear infinite' }} /> : null}
            {bridging ? 'Bridging…' : 'Bridge'}
          </button>

          <p style={{ textAlign: 'center', fontSize: 11, color: '#CBD5E1', marginTop: 12 }}>
            Powered by LI.FI
          </p>

          {bridgeSteps.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, padding: 18, marginTop: 16 }}>
              <BridgeStepList steps={bridgeSteps} />
            </div>
          )}

          {successTx && !bridging && (
            <div style={{
              background: '#F0FDFA', border: '1px solid #99F6E4', borderRadius: 16,
              padding: 18, marginTop: 16, textAlign: 'center',
            }}>
              <CheckCircle2 size={28} color="#14B8A6" style={{ margin: '0 auto 10px' }} />
              <p style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 4 }}>Bridge submitted</p>
              <p style={{ fontSize: 12, color: '#64748B', marginBottom: 10 }}>
                Funds will arrive on {toChain.name} shortly — no action needed on your end.
              </p>
              {successTx && (
                <a href={txLink(successTx)} target="_blank" rel="noreferrer" style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12,
                  color: '#4F46E5', textDecoration: 'none', fontWeight: 600,
                }}>
                  View transaction <ExternalLink size={11} />
                </a>
              )}
            </div>
          )}
        </div>
      </AppLayout>
    </NetworkGuard>
  );
}
