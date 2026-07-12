'use client';
/**
 * @file app/ai-agent/agent-wallet/page.tsx
 * Agent wallet view — shows agent balance (no action cards), deposit link,
 * and token balances for USDC, EURC, cirBTC. (ImportantUpdate #13i)
 */

import { useState, useEffect, useCallback } from 'react';
import { usePublicClient, useBalance } from 'wagmi';
import { ArrowDownToLine, Eye, EyeOff, Copy, Loader2, CheckCircle2 } from 'lucide-react';
import { AgentLayout } from '@/components/agent/AgentLayout';
import { useAgentStatus } from '@/lib/useAgentStatus';
import { ERC20_ABI }     from '@/lib/contracts/abis';
import { arcTestnet }    from '@/lib/contracts/config';
import { copyToClipboard } from '@/lib/clipboard';

const TOKENS = [
  { symbol: 'USDC',   name: 'USD Coin',      color: '#2775CA', bg: '#EFF6FF', decimals: 6,
    icon: <svg width="20" height="20" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#2775CA"/><text x="16" y="21" textAnchor="middle" fill="white" fontSize="13" fontWeight="bold" fontFamily="Arial">$</text></svg> },
  { symbol: 'EURC',   name: 'Euro Coin',      color: '#1B3A6B', bg: '#EEF2FF', decimals: 6,
    icon: <svg width="20" height="20" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#1B3A6B"/><text x="16" y="21" textAnchor="middle" fill="white" fontSize="13" fontWeight="bold" fontFamily="Arial">€</text></svg> },
  { symbol: 'cirBTC', name: 'Circle Bitcoin', color: '#F7931A', bg: '#FFF7ED', decimals: 8,
    icon: <svg width="20" height="20" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#F7931A"/><text x="16" y="21" textAnchor="middle" fill="white" fontSize="11" fontWeight="bold" fontFamily="Arial">₿</text></svg> },
];

export default function AgentWalletPage() {
  const { status, agentInfo }  = useAgentStatus();
  const agentAddr = agentInfo?.agentWallet as `0x${string}` | undefined;
  const pc = usePublicClient({ chainId: arcTestnet.id });

  const [showBal, setShowBal] = useState(true);
  const [copied,  setCopied]  = useState(false);
  const [tokenBals, setTokenBals] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const { data: nativeBal } = useBalance({ address: agentAddr, query: { enabled: !!agentAddr } });

  const fetchTokens = useCallback(async () => {
    if (!agentAddr || !pc) return;
    setLoading(true);
    const out: Record<string, string> = {};
    for (const t of TOKENS) {
      if (t.symbol === 'USDC') {
        out.USDC = nativeBal ? parseFloat(nativeBal.formatted).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
        continue;
      }
      const addr = t.symbol === 'EURC'
        ? (process.env.NEXT_PUBLIC_EURC_ADDRESS as `0x${string}` | undefined)
        : (process.env.NEXT_PUBLIC_CIRBTC_ADDRESS as `0x${string}` | undefined);
      if (!addr) { out[t.symbol] = '0.00'; continue; }
      try {
        const raw = await pc.readContract({ address: addr, abi: ERC20_ABI, functionName: 'balanceOf', args: [agentAddr] }) as bigint;
        const div = BigInt(10 ** t.decimals);
        out[t.symbol] = `${(raw / div).toString()}.${(raw % div).toString().padStart(t.decimals, '0').slice(0, 2)}`;
      } catch { out[t.symbol] = '0.00'; }
    }
    setTokenBals(out); setLoading(false);
  }, [agentAddr, pc, nativeBal]);

  useEffect(() => { if (agentAddr) fetchTokens(); }, [agentAddr, fetchTokens]);

  async function copy() {
    if (!agentAddr) return;
    const ok = await copyToClipboard(agentAddr);
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
  }

  const balStr = nativeBal
    ? parseFloat(nativeBal.formatted).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '0.00';

  return (
    <AgentLayout title="Agent Wallet">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Hero card */}
        <div style={{ background: '#4F46E5', borderRadius: 20, padding: '24px 28px', position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', top: -40, right: -40, width: 160, height: 160, borderRadius: '50%', background: 'rgba(255,255,255,0.05)' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, position: 'relative' }}>
            <button onClick={() => setShowBal(v => !v)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.75)', display: 'flex' }}>
              {showBal ? <Eye size={15} /> : <EyeOff size={15} />}
            </button>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>Agent Balance</span>
          </div>
          <div style={{ fontSize: 36, fontWeight: 800, color: '#fff', letterSpacing: '-0.02em', marginBottom: 12, position: 'relative' }}>
            {showBal ? `$${balStr}` : '$••••••'}
            <span style={{ fontSize: 15, fontWeight: 600, color: 'rgba(255,255,255,0.55)', marginLeft: 8 }}>USDC</span>
          </div>
          {agentAddr && (
            <button onClick={copy} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.12)', border: 'none', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: 'rgba(255,255,255,0.85)' }}>
              {agentAddr.slice(0, 10)}…{agentAddr.slice(-6)}
              {copied ? <CheckCircle2 size={13} color="#14B8A6" /> : <Copy size={13} color="rgba(255,255,255,0.5)" />}
            </button>
          )}
          {/* Deposit shortcut */}
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
            <button
              onClick={copy}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 10, padding: '7px 14px', cursor: 'pointer', color: '#fff', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
              <ArrowDownToLine size={14} /> Deposit — copy address above
            </button>
          </div>
        </div>

        {/* Token balances */}
        {!agentAddr ? (
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, padding: 24, textAlign: 'center' }}>
            <p style={{ color: '#94A3B8', fontSize: 14 }}>
              {status === 'none' ? 'Activate the AI Agent first to see its wallet.' : 'Loading agent wallet…'}
            </p>
          </div>
        ) : (
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, padding: '20px 20px 8px' }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', marginBottom: 4 }}>Tokens</h3>
            {TOKENS.map(t => (
              <div key={t.symbol} style={{ display: 'flex', alignItems: 'center', padding: '14px 0', gap: 14, borderBottom: '1px solid #F1F5F9' }}>
                <div style={{ width: 38, height: 38, borderRadius: '50%', background: t.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {t.icon}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{t.symbol}</div>
                  <div style={{ fontSize: 12, color: '#94A3B8' }}>{t.name}</div>
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', fontFamily: "'JetBrains Mono', monospace" }}>
                  {loading ? <Loader2 size={14} color="#94A3B8" style={{ animation: 'spin 0.7s linear infinite' }} /> : (tokenBals[t.symbol] ?? '0.00')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </AgentLayout>
  );
}
