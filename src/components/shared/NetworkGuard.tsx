'use client';
/**
 * @file components/shared/NetworkGuard.tsx
 * Forces external wallet users onto Arc Testnet.
 * Circle social login users are already on the correct chain by design.
 */

import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import { arcTestnet } from '@/lib/contracts/config';
import { AlertTriangle, ArrowRight, Loader2 } from 'lucide-react';

interface NetworkGuardProps { children: React.ReactNode; }

export function NetworkGuard({ children }: NetworkGuardProps) {
  const { isConnected }            = useAccount();
  const chainId                    = useChainId();
  // Bug fix: removed redundant `switching` local state — isPending from useSwitchChain
  // is the single source of truth; having both caused stale/conflicting states.
  const { switchChain, isPending } = useSwitchChain();

  // Only enforce for externally connected wallets
  if (!isConnected) return <>{children}</>;
  if (chainId === arcTestnet.id) return <>{children}</>;

  return (
    <div style={{ minHeight: '100vh', background: '#F8F9FA', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{
        background: '#fff', border: '1px solid #FED7AA',
        borderRadius: 20, padding: '40px 36px',
        maxWidth: 440, width: '100%', textAlign: 'center',
        boxShadow: '0 8px 32px rgba(0,0,0,0.06)',
      }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#FFF7ED', border: '2px solid #FED7AA', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
          <AlertTriangle size={28} color="#D97706" />
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', marginBottom: 10 }}>Wrong Network</h2>
        <p style={{ fontSize: 14, color: '#64748B', lineHeight: 1.65, marginBottom: 28 }}>
          Salden runs on <strong style={{ color: '#0F172A' }}>Arc Testnet</strong>.
          Your wallet is connected to a different network. Switch to continue.
        </p>
        <button
          onClick={() => switchChain({ chainId: arcTestnet.id })}
          disabled={isPending}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 10,
            padding: '13px 28px', borderRadius: 12,
            background: '#14B8A6', border: 'none',
            color: '#fff', fontSize: 15, fontWeight: 700,
            cursor: isPending ? 'not-allowed' : 'pointer',
            opacity: isPending ? 0.7 : 1, fontFamily: 'inherit',
          }}
        >
          {isPending
            ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Switching…</>
            : <>Switch to Arc Testnet <ArrowRight size={16} /></>
          }
        </button>
        <p style={{ marginTop: 16, fontSize: 12, color: '#94A3B8' }}>Arc Testnet — Chain ID: {arcTestnet.id}</p>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
