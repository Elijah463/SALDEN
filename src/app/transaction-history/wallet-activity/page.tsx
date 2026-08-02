'use client';
/**
 * @file app/transaction-history/wallet-activity/page.tsx
 *
 * Shows Swap / Bridge / incoming-Deposit activity — deliberately separate
 * from the main Transaction History (payroll runs/transfers), and
 * deliberately LOCAL-ONLY (never synced to IPFS/KV), per explicit product
 * decision: it's fine if this doesn't follow the user to a different
 * device/browser.
 */

import { useState, useEffect, useCallback } from 'react';
import { usePublicClient } from 'wagmi';
import { ArrowLeft, Repeat, Waypoints, ArrowDownToLine, ExternalLink, Loader2 } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { txLink } from '@/lib/contracts/config';
import { getWalletActivity, type WalletActivityRecord } from '@/lib/db/indexeddb';
import { detectIncomingDeposits } from '@/lib/walletActivity/detectDeposits';
import { TOKEN_ICON_PATHS, tokenIconRenderSize } from '@/lib/token-registry';

const CHAIN_LOGOS: Record<string, string> = {
  'Arc Testnet':      '/images/networks/arc.png',
  'Ethereum Sepolia':  '/images/networks/ethereum-sepolia.png',
  'Base Sepolia':      '/images/networks/base.png',
  'Arbitrum Sepolia':  '/images/networks/arbitrum.png',
  'Avalanche Fuji':    '/images/networks/avalanche.jpeg',
  'Linea Sepolia':     '/images/networks/linea.jpeg',
};

// Shorter display form for chain names, matching the requested tile
// wording ("from Ethereum to Arc" rather than the full config names).
function shortChainName(name?: string): string {
  if (!name) return '';
  return name.replace(' Testnet', '').replace(' Sepolia', '');
}

function TokenLogo({ symbol, size = 16 }: { symbol: string; size?: number }) {
  const path = TOKEN_ICON_PATHS[symbol];
  if (!path) return null;
  const renderSize = tokenIconRenderSize(symbol, size);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={path} alt={symbol} width={renderSize} height={renderSize}
      style={{ borderRadius: '50%', objectFit: 'cover', display: 'inline-block', verticalAlign: 'middle', margin: '0 2px' }} />
  );
}

function ChainLogo({ name, size = 16 }: { name?: string; size?: number }) {
  const path = name ? CHAIN_LOGOS[name] : undefined;
  if (!path) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={path} alt={name} width={size} height={size}
      style={{ borderRadius: '50%', objectFit: 'cover', display: 'inline-block', verticalAlign: 'middle', margin: '0 2px' }} />
  );
}

function truncAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const TYPE_META = {
  swap:    { label: 'Swap',    icon: Repeat },
  bridge:  { label: 'Bridge',  icon: Waypoints },
  deposit: { label: 'Deposit', icon: ArrowDownToLine },
} as const;

function ActivityTile({ record }: { record: WalletActivityRecord }) {
  const meta = TYPE_META[record.type];
  const Icon = meta.icon;

  return (
    <div style={{
      background: '#fff', border: '1px solid #E2E8F0', borderRadius: 14,
      padding: '16px 18px', display: 'flex', gap: 14,
    }}>
      {/* Icon — the only element in this tile that's brand indigo; every
          other element (text, chevrons) is black/grey by hierarchy, per
          explicit instruction. */}
      <div style={{
        width: 38, height: 38, borderRadius: 10, background: '#EEF2FF',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <Icon size={18} color="#4F46E5" />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 4 }}>
          {meta.label}
        </div>

        <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.6 }}>
          {record.type === 'swap' && (
            <>
              Swapped {record.fromAmount} <TokenLogo symbol={record.fromToken ?? ''} />{record.fromToken}
              {' '}to {record.toAmount} <TokenLogo symbol={record.toToken ?? ''} />{record.toToken}
            </>
          )}
          {record.type === 'deposit' && (
            <>
              Received {record.amount} <TokenLogo symbol={record.token ?? ''} />{record.token}
              {' '}from <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#475569' }}>{truncAddr(record.fromAddress ?? '')}</span>
            </>
          )}
          {record.type === 'bridge' && (
            <>
              Bridged {record.amount} <TokenLogo symbol={record.token ?? ''} />{record.token}
              {' '}from <ChainLogo name={record.fromChain} /> {shortChainName(record.fromChain)}
              {' '}to <ChainLogo name={record.toChain} /> {shortChainName(record.toChain)}
            </>
          )}
        </div>

        <a href={txLink(record.hash)} target="_blank" rel="noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 8, fontSize: 12, color: '#64748B', textDecoration: 'none' }}>
          View on Arcscan <ExternalLink size={11} color="#94A3B8" />
        </a>
      </div>
    </div>
  );
}

export default function WalletActivityPage() {
  const { address } = useEffectiveAddress();
  const publicClient = usePublicClient();
  const [activity, setActivity] = useState<WalletActivityRecord[]>([]);
  const [loading,  setLoading]  = useState(true);

  const load = useCallback(async () => {
    if (!address) { setLoading(false); return; }
    setLoading(true);
    // Check for new incoming deposits first (best-effort — a failure here
    // shouldn't block showing whatever's already recorded locally).
    if (publicClient) {
      await detectIncomingDeposits(address as `0x${string}`, publicClient).catch(() => {});
    }
    const records = await getWalletActivity(address);
    setActivity(records);
    setLoading(false);
  }, [address, publicClient]);

  useEffect(() => { void load(); }, [load]);

  return (
    <AppLayout title="Wallet Activity">
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <a href="/transaction-history" style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, color: '#64748B',
          fontSize: 13, fontWeight: 500, textDecoration: 'none', marginBottom: 16,
        }}>
          <ArrowLeft size={15} /> Back to Transaction History
        </a>

        <h2 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', marginBottom: 4 }}>Wallet Activity</h2>
        <p style={{ fontSize: 13, color: '#94A3B8', marginBottom: 20 }}>
          Swaps, bridges, and deposits from other wallets. Stored on this device only.
        </p>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}>
            <Loader2 size={22} color="#94A3B8" style={{ animation: 'spin 0.8s linear infinite' }} />
          </div>
        ) : activity.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: '#94A3B8', fontSize: 13 }}>
            No wallet activity yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {activity.map(record => <ActivityTile key={record.id} record={record} />)}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
