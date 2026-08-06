'use client';
/**
 * @file app/ai-agent/agent-wallet/page.tsx
 * Agent wallet view — shows agent balance (no action cards), deposit link,
 * and token balances for USDC, EURC, cirBTC. (ImportantUpdate #13i)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { usePublicClient, useBalance } from 'wagmi';
import { ArrowDownToLine, Eye, EyeOff, Copy, Loader2, CheckCircle2 } from 'lucide-react';
import { AgentLayout } from '@/components/agent/AgentLayout';
import { useAgentStatus } from '@/lib/useAgentStatus';
import { ERC20_ABI }     from '@/lib/contracts/abis';
import { arcTestnet, CONTRACTS } from '@/lib/contracts/config';
import { copyToClipboard } from '@/lib/clipboard';
import { useBalanceVisibility } from '@/lib/useBalanceVisibility';
import { TOKEN_ICON_PATHS, tokenIconRenderSize } from '@/lib/token-registry';

const TOKEN_ICON_SIZE = 38;

const TOKENS = [
  { symbol: 'USDC',   name: 'USD Coin',      bg: '#EFF6FF', decimals: 6, displayDecimals: 2 },
  { symbol: 'EURC',   name: 'Euro Coin',      bg: '#EEF2FF', decimals: 6, displayDecimals: 2 },
  // cirBTC trades at BTC-scale value — real balances are commonly small
  // fractions that a 2-decimal display would round away to "0.00" entirely.
  { symbol: 'cirBTC', name: 'Circle Bitcoin', bg: '#FFF7ED', decimals: 8, displayDecimals: 6 },
];

function AgentTokenIcon({ symbol, bg }: { symbol: string; bg: string }) {
  const iconPath = TOKEN_ICON_PATHS[symbol];
  if (iconPath) {
    const renderSize = tokenIconRenderSize(symbol, TOKEN_ICON_SIZE);
    return (
      <div style={{ width: TOKEN_ICON_SIZE, height: TOKEN_ICON_SIZE, borderRadius: '50%', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={iconPath} alt={symbol} width={renderSize} height={renderSize}
          style={{ display: 'block', objectFit: 'cover' }} />
      </div>
    );
  }
  return (
    <div style={{ width: TOKEN_ICON_SIZE, height: TOKEN_ICON_SIZE, borderRadius: '50%', background: bg,
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }} />
  );
}

function tokenAddress(symbol: string): `0x${string}` | undefined {
  if (symbol === 'USDC') return CONTRACTS.USDC as `0x${string}`;
  if (symbol === 'EURC') return process.env.NEXT_PUBLIC_EURC_ADDRESS as `0x${string}` | undefined;
  return process.env.NEXT_PUBLIC_CIRBTC_ADDRESS as `0x${string}` | undefined;
}

export default function AgentWalletPage() {
  const { status, agentInfo }  = useAgentStatus();
  const agentAddr = agentInfo?.agentWallet as `0x${string}` | undefined;
  const pc = usePublicClient({ chainId: arcTestnet.id });

  const [showBal, setShowBal] = useBalanceVisibility();
  const [copied,  setCopied]  = useState(false);
  const [tokenBals, setTokenBals] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const tokenBalsRef = useRef(tokenBals);
  useEffect(() => { tokenBalsRef.current = tokenBals; }, [tokenBals]);

  const { data: nativeBal } = useBalance({ address: agentAddr, query: { enabled: !!agentAddr } });

  // Retries a failed balanceOf() read before giving up, and on total
  // failure keeps the last known-good value instead of overwriting it with
  // a fake "0.00" — same fix applied to wallet/page.tsx's fetchErc20 for
  // the same reason: Arc's public testnet RPC intermittently rate-limits,
  // and collapsing that into a fake zero was indistinguishable from a
  // genuinely empty wallet.
  const fetchTokens = useCallback(async () => {
    if (!agentAddr || !pc) return;
    setLoading(true);
    const previous = tokenBalsRef.current;
    const out: Record<string, string> = {};
    for (const t of TOKENS) {
      if (t.symbol === 'USDC') {
        out.USDC = nativeBal ? parseFloat(nativeBal.formatted).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
        continue;
      }
      const addr = tokenAddress(t.symbol);
      if (!addr) { out[t.symbol] = `0.${'0'.repeat(t.displayDecimals)}`; continue; }
      let resolved: string | null = null;
      for (let attempt = 1; attempt <= 3 && resolved === null; attempt++) {
        try {
          const raw = await pc.readContract({ address: addr, abi: ERC20_ABI, functionName: 'balanceOf', args: [agentAddr] }) as bigint;
          const div = BigInt(10 ** t.decimals);
          const dp  = t.displayDecimals;
          resolved = `${(raw / div).toString()}.${(raw % div).toString().padStart(t.decimals, '0').slice(0, dp).padEnd(dp, '0')}`;
        } catch {
          if (attempt < 3) await new Promise(r => setTimeout(r, 800));
        }
      }
      out[t.symbol] = resolved ?? previous[t.symbol] ?? `0.${'0'.repeat(t.displayDecimals)}`;
    }
    setTokenBals(prev => ({ ...prev, ...out })); setLoading(false);
  }, [agentAddr, pc, nativeBal]);

  useEffect(() => { if (agentAddr) fetchTokens(); }, [agentAddr, fetchTokens]);

  // Live USD prices via LI.FI — same source/endpoint as wallet/page.tsx, so
  // the dollar value shown here matches the user wallet exactly.
  const [tokenPrices, setTokenPrices] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      TOKENS.map(async t => {
        const addr = tokenAddress(t.symbol);
        if (!addr) return [t.symbol, null] as const;
        try {
          const res = await fetch(`/api/lifi/price?chainId=${arcTestnet.id}&token=${addr}`);
          const data = await res.json() as { price: { priceUSD: string } | null };
          return [t.symbol, data.price ? Number(data.price.priceUSD) : null] as const;
        } catch {
          return [t.symbol, null] as const;
        }
      }),
    ).then(results => {
      if (cancelled) return;
      const map: Record<string, number> = {};
      for (const [symbol, price] of results) if (price !== null) map[symbol] = price;
      setTokenPrices(map);
    });
    return () => { cancelled = true; };
  }, []);

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
            {TOKENS.map(t => {
              const balanceStr = tokenBals[t.symbol] ?? `0.${'0'.repeat(t.displayDecimals)}`;
              const balanceNum = Number(balanceStr.replace(/,/g, '')) || 0;
              const price = tokenPrices[t.symbol] ?? (t.symbol === 'USDC' ? 1 : undefined);
              const usdValue = price !== undefined
                ? (balanceNum * price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : null;
              return (
                <div key={t.symbol} style={{ display: 'flex', alignItems: 'center', padding: '14px 0', gap: 14, borderBottom: '1px solid #F1F5F9' }}>
                  <AgentTokenIcon symbol={t.symbol} bg={t.bg} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{t.symbol}</div>
                    <div style={{ fontSize: 12, color: '#94A3B8' }}>{t.name}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', fontFamily: "'JetBrains Mono', monospace" }}>
                      {loading ? <Loader2 size={14} color="#94A3B8" style={{ animation: 'spin 0.7s linear infinite' }} /> : balanceStr}
                    </div>
                    {!loading && usdValue && (
                      <div style={{ fontSize: 12, color: '#94A3B8' }}>≈${usdValue}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </AgentLayout>
  );
}
