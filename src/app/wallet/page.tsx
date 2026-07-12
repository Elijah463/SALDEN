'use client';
/**
 * @file app/wallet/page.tsx
 * Wallet hub: hero balance, action cards, USDC/EURC/cirBTC token rows.
 *
 * Decimal note:
 *   Native balance (useBalance)     → 18 decimals → .formatted gives human value
 *   ERC-20 balanceOf (EURC, cirBTC) → 6/8 decimals → divide by 10^decimals
 *
 * Re-fetch strategy:
 *   nativeBalance (USDC) is read from useBalance hook — updates automatically.
 *   ERC-20 balances fetched once on mount / address change.
 *   nativeBalance is NOT in fetchTokenBalances useCallback deps to avoid
 *   continuous re-fetches on every block.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter }        from 'next/navigation';
import { useBalance, usePublicClient } from 'wagmi';
import {
  Eye, EyeOff, Copy, ArrowDownToLine,
  Send, ArrowLeftRight, GitMerge, Loader2,
} from 'lucide-react';
import { AppLayout }        from '@/components/layout/AppLayout';
import { NetworkGuard }     from '@/components/shared/NetworkGuard';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { ERC20_ABI }        from '@/lib/contracts/abis';
import { arcTestnet }       from '@/lib/contracts/config';
import { copyToClipboard }  from '@/lib/clipboard';

// Next.js statically replaces `process.env.NEXT_PUBLIC_X` at build time only
// when it sees that exact literal expression in source — `process.env[someVar]`
// (dynamic/bracket access) can never be inlined this way, since the bundler
// doesn't know what `someVar` will be until runtime, and `process.env` isn't
// actually available in the browser bundle at runtime beyond what got
// inlined. Referencing both literals directly here (even though they're
// being placed into a lookup object) is what makes the build-time
// replacement work; the object itself is just a plain runtime lookup.
const ENV_TOKEN_ADDRESSES: Record<string, string | undefined> = {
  NEXT_PUBLIC_EURC_ADDRESS:   process.env.NEXT_PUBLIC_EURC_ADDRESS,
  NEXT_PUBLIC_CIRBTC_ADDRESS: process.env.NEXT_PUBLIC_CIRBTC_ADDRESS,
};

// ── Supported tokens ─────────────────────────────────────────────────────────

const TOKENS = [
  {
    symbol: 'USDC', name: 'USD Coin', color: '#2775CA', bgColor: '#EFF6FF',
    fromNative: true, decimals: 6,
    icon: (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/images/tokens/usdc.webp" alt="USDC" width={26} height={26} style={{ borderRadius: '50%', objectFit: 'cover' }} />
    ),
  },
  {
    symbol: 'EURC', name: 'Euro Coin', color: '#1B3A6B', bgColor: '#EEF2FF',
    fromNative: false, decimals: 6,
    envKey: 'NEXT_PUBLIC_EURC_ADDRESS',
    icon: (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/images/tokens/eurc.svg" alt="EURC" width={26} height={26} style={{ borderRadius: '50%', objectFit: 'cover' }} />
    ),
  },
  {
    symbol: 'cirBTC', name: 'Circle Bitcoin', color: '#F7931A', bgColor: '#FFF7ED',
    fromNative: false, decimals: 8,
    envKey: 'NEXT_PUBLIC_CIRBTC_ADDRESS',
    icon: (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/images/tokens/cirbtc.png" alt="cirBTC" width={26} height={26} style={{ borderRadius: '50%', objectFit: 'cover' }} />
    ),
  },
];

// ── Action card ───────────────────────────────────────────────────────────────

function ActionCard({ icon, label, href }: { icon: React.ReactNode; label: string; href: string }) {
  const router = useRouter();
  return (
    <button
      onClick={() => router.push(href)}
      style={{
        flex: 1, minWidth: 70, display: 'flex', flexDirection: 'column',
        alignItems: 'center', gap: 10, padding: '16px 8px', borderRadius: 16,
        background: '#F8F9FA', border: '1.5px solid #F1F5F9',
        cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLButtonElement).style.background = '#EEF2FF';
        (e.currentTarget as HTMLButtonElement).style.borderColor = '#C7D2FE';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.background = '#F8F9FA';
        (e.currentTarget as HTMLButtonElement).style.borderColor = '#F1F5F9';
      }}
    >
      <div style={{ width: 48, height: 48, borderRadius: 14, background: '#EEF2FF',
        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </div>
      <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{label}</span>
    </button>
  );
}

// ── Token row ─────────────────────────────────────────────────────────────────

function TokenRow({ symbol, name, icon, balance, color, bgColor, loading }: {
  symbol: string; name: string; icon: React.ReactNode;
  balance: string; color: string; bgColor: string; loading?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '14px 0',
      gap: 14, borderBottom: '1px solid #F1F5F9' }}>
      <div style={{ width: 40, height: 40, borderRadius: '50%',
        background: bgColor, border: `1.5px solid ${color}20`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {icon}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{symbol}</div>
        <div style={{ fontSize: 12, color: '#94A3B8' }}>{name}</div>
      </div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 15, fontWeight: 700, color: '#0F172A' }}>
        {loading
          ? <Loader2 size={14} color="#94A3B8" style={{ animation: 'spin 0.7s linear infinite' }} />
          : balance
        }
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function WalletPage() {
  const { address, isConnected: isAuth } = useEffectiveAddress();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  const [showBalance,   setShowBalance]   = useState(true);
  const [copied,        setCopied]        = useState(false);
  const [erc20Balances, setErc20Balances] = useState<Record<string, string>>({});
  const [loadingErc20,  setLoadingErc20]  = useState(false);

  // Native balance — 18 decimals on Arc; .formatted gives human-readable value
  const { data: nativeBalance } = useBalance({
    address: address as `0x${string}` | undefined,
    query: { enabled: !!address },
  });

  // Human-readable USDC balance from native balance
  const usdcDisplay = nativeBalance
    ? Number(nativeBalance.formatted).toLocaleString('en-US', {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      })
    : '0.00';

  // ERC-20 balances — nativeBalance intentionally excluded from deps
  // to avoid re-fetching on every block; USDC is shown from nativeBalance directly
  const fetchErc20 = useCallback(async () => {
    if (!address || !publicClient) return;
    setLoadingErc20(true);
    const out: Record<string, string> = {};
    for (const t of TOKENS) {
      if (t.fromNative) continue;
      const addr = t.envKey
        ? (ENV_TOKEN_ADDRESSES[t.envKey] as `0x${string}` | undefined)
        : undefined;
      if (!addr) { out[t.symbol] = '0.00'; continue; }
      try {
        const raw = await publicClient.readContract({
          address: addr, abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address as `0x${string}`],
        }) as bigint;
        const div   = BigInt(10 ** t.decimals);
        const whole = raw / div;
        const frac  = (raw % div).toString().padStart(t.decimals, '0').slice(0, 2);
        out[t.symbol] = `${Number(whole).toLocaleString()}.${frac}`;
      } catch { out[t.symbol] = '0.00'; }
    }
    setErc20Balances(out);
    setLoadingErc20(false);
  }, [address, publicClient]);

  useEffect(() => { if (address) fetchErc20(); }, [address, fetchErc20]);

  async function handleCopy() {
    if (!address) return;
    const ok = await copyToClipboard(address);
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
  }

  return (
    <NetworkGuard>
      <AppLayout title="Wallet">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Hero balance card */}
          <div style={{ background: '#4F46E5', borderRadius: 20, padding: '24px 28px',
            position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: -40, right: -40, width: 160, height: 160,
              borderRadius: '50%', background: 'rgba(255,255,255,0.05)' }} />

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
              <button onClick={() => setShowBalance(v => !v)}
                style={{ background: 'none', border: 'none', cursor: 'pointer',
                  color: 'rgba(255,255,255,0.75)', display: 'flex', padding: 0 }}>
                {showBalance ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>
                Wallet Balance
              </span>
            </div>

            <div style={{ fontSize: 38, fontWeight: 800, color: '#fff',
              letterSpacing: '-0.02em', marginBottom: 14 }}>
              {isAuth ? (showBalance ? `$${usdcDisplay}` : '$••••••') : '$0.00'}
              <span style={{ fontSize: 16, fontWeight: 600,
                color: 'rgba(255,255,255,0.55)', marginLeft: 8 }}>USDC</span>
            </div>

            {isAuth && address ? (
              <button onClick={handleCopy} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: 'rgba(255,255,255,0.12)', border: 'none', borderRadius: 8,
                padding: '6px 12px', cursor: 'pointer',
                fontFamily: "'JetBrains Mono', monospace", fontSize: 13,
                color: 'rgba(255,255,255,0.85)',
              }}>
                {address.slice(0, 8)}…{address.slice(-6)}
                <Copy size={13} color={copied ? '#14B8A6' : 'rgba(255,255,255,0.6)'} />
                {copied && <span style={{ fontSize: 11, color: '#14B8A6' }}>Copied!</span>}
              </button>
            ) : (
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', margin: 0 }}>
                Connect your wallet to view balance
              </p>
            )}
          </div>

          {/* Action cards */}
          <div style={{ display: 'flex', gap: 10 }}>
            <ActionCard icon={<ArrowDownToLine size={22} color="#4F46E5" />} label="Deposit" href="/wallet/deposit" />
            <ActionCard icon={<Send             size={22} color="#4F46E5" />} label="Send"    href="/wallet/send"    />
            <ActionCard icon={<ArrowLeftRight   size={22} color="#4F46E5" />} label="Swap"    href="/wallet/swap"    />
            <ActionCard icon={<GitMerge         size={22} color="#4F46E5" />} label="Bridge"  href="/wallet/bridge"  />
          </div>

          {/* Token balances */}
          <div style={{ background: '#fff', border: '1px solid #E2E8F0',
            borderRadius: 16, padding: '20px 20px 8px' }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', marginBottom: 4 }}>Tokens</h3>
            {TOKENS.map(token => (
              <TokenRow
                key={token.symbol}
                symbol={token.symbol}
                name={token.name}
                icon={token.icon}
                color={token.color}
                bgColor={token.bgColor}
                loading={token.fromNative ? false : (loadingErc20 && !erc20Balances[token.symbol])}
                balance={token.fromNative ? usdcDisplay : (erc20Balances[token.symbol] ?? '0.00')}
              />
            ))}
          </div>

        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </AppLayout>
    </NetworkGuard>
  );
}
