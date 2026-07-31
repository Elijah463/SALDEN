'use client';
/**
 * @file app/transaction-history/page.tsx
 * - Chart starts from the very first transaction month (not a fixed 6-month window)
 * - Y-axis uses dynamic custom ticks: 0→100→500→1k→5k→10k→20k→50k→100k…
 * - Receipt cards with ref (alphanumeric), type, status badge, receipt status
 * - useEffectiveAddress for Circle social login compatibility
 */

import { useState, useEffect, useCallback } from 'react';
import { usePublicClient } from 'wagmi';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  ExternalLink, RefreshCw,
  TrendingUp, DollarSign, Loader2,
  CheckCircle2, AlertCircle, Clock, Copy, XCircle, Search, Wallet, Lock,
} from 'lucide-react';
import { AppLayout }           from '@/components/layout/AppLayout';
import { Button }              from '@/components/shared/Button';
import { useApp }              from '@/context/AppContext';
import { getTxsByWallet, type TxRecord } from '@/lib/db/indexeddb';
import { TransactionIllustration } from '@/components/shared/Illustrations';
import { txLink }              from '@/lib/contracts/config';
import { truncAddr }           from '@/lib/validation';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { usePayrollSync } from '@/lib/usePayrollSync';
import { copyToClipboard } from '@/lib/clipboard';
import { format, startOfMonth } from 'date-fns';

// ── Dynamic Y-axis ticks ───────────────────────────────────────────────────────

function getDynamicTicks(maxVal: number): number[] {
  if (maxVal === 0) return [0];
  if (maxVal <= 100)    return [0, 25, 50, 75, 100];
  if (maxVal <= 500)    return [0, 100, 250, 500];
  if (maxVal <= 1000)   return [0, 100, 500, 1000];
  if (maxVal <= 5000)   return [0, 1000, 2500, 5000];
  if (maxVal <= 10000)  return [0, 1000, 5000, 10000];
  if (maxVal <= 20000)  return [0, 5000, 10000, 20000];
  if (maxVal <= 50000)  return [0, 10000, 25000, 50000];
  if (maxVal <= 100000) return [0, 20000, 50000, 100000];
  if (maxVal <= 500000) return [0, 100000, 250000, 500000];
  if (maxVal <= 1e6)    return [0, 250000, 500000, 1000000];
  const order = Math.pow(10, Math.floor(Math.log10(maxVal)));
  return [0, order / 2, order, order * 2].filter(v => v <= maxVal * 1.2);
}

function fmtTick(v: number): string {
  if (v === 0) return '0';
  if (v >= 1e6)  return `${(v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
  return String(v);
}

// ── Method label ───────────────────────────────────────────────────────────────

function methodLabel(type: TxRecord['type']): string {
  switch (type) {
    case 'batchPay': return 'BatchPay';
    case 'other':    return 'Transfer';
    case 'deploy':   return 'Contract Deployment';
    case 'addAgent': return 'Add Agent';
    case 'approve':  return 'Approval';
    default:         return type;
  }
}

// ── Status & Receipt helpers ───────────────────────────────────────────────────

function ReceiptStatus({ status, onRetry, retrying, notSupported }: {
  status?: TxRecord['receiptEmailStatus'];
  onRetry?: () => void;
  retrying?: boolean;
  notSupported?: boolean;
}) {
  if (notSupported) {
    return <span style={{ fontSize: 13, color: '#94A3B8' }}>Not supported</span>;
  }
  if (!status) return null;

  if (status === 'failed') {
    return (
      <button
        onClick={onRetry} disabled={retrying}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600,
          color: '#DC2626', background: 'none', border: 'none', padding: 0,
          cursor: retrying ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
        }}
      >
        {retrying
          ? <><Loader2 size={12} style={{ animation: 'spin 0.7s linear infinite' }} /> Retrying…</>
          : <><AlertCircle size={12} /> Failed — <RefreshCw size={11} /> Retry</>}
      </button>
    );
  }

  const map = {
    sent:    { icon: <CheckCircle2 size={12} />, color: '#059669', label: 'Sent'    },
    pending: { icon: <Clock        size={12} />, color: '#D97706', label: 'Sending…' },
  } as const;
  const s = map[status as keyof typeof map];
  if (!s) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: s.color, fontWeight: 600 }}>
      {s.icon}{s.label}
    </span>
  );
}

function StatCard({ label, value, icon, color = '#4F46E5', href }: { label: string; value: string; icon: React.ReactNode; color?: string; href?: string }) {
  const content = (
    <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 14, padding: '18px 20px', cursor: href ? 'pointer' : 'default' }}>
      <div style={{ width: 36, height: 36, borderRadius: 9, background: color + '18', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
        {icon}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: '#0F172A' }}>{value}</div>
      <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>{label}</div>
    </div>
  );
  return href ? <a href={href} style={{ textDecoration: 'none' }}>{content}</a> : content;
}

// ── Receipt card ───────────────────────────────────────────────────────────────

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 9 }}>
      <span style={{ fontSize: 12, color: '#94A3B8', fontWeight: 600 }}>{label}</span>
      {children}
    </div>
  );
}

function ReceiptCard({ tx, onResend, resending, hasEmail }: {
  tx: TxRecord;
  onResend:   (tx: TxRecord) => void;
  resending: string | null;
  hasEmail:  boolean;
}) {
  const [copied, setCopied] = useState(false);
  const ref = tx.ref ?? ('SLD-' + tx.hash.slice(2, 8).toUpperCase());
  const status = tx.status ?? 'success';
  const isSingleSend = tx.type === 'other';

  return (
    <div style={{
      background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, overflow: 'hidden',
      boxShadow: '0 -1px 2px rgba(15,23,42,0.03), 0 2px 6px rgba(15,23,42,0.05)',
    }}>
      <div style={{ padding: '18px 20px' }}>

        {/* Reference + date — unchanged */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <span style={{ fontSize: 12, fontWeight: 800, color: '#4F46E5', letterSpacing: '0.06em', fontFamily: "'JetBrains Mono', monospace" }}>
            {ref}
          </span>
          <span style={{ fontSize: 12, color: '#94A3B8' }}>
            {format(new Date(tx.timestamp), 'dd MMM yyyy · HH:mm')}
          </span>
        </div>

        {/* Status — checkmark in front, plain green/red text, no pill/glow */}
        <DetailRow label="Status">
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 700,
            color: status === 'success' ? '#059669' : '#DC2626',
          }}>
            {status === 'success' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            {status === 'success' ? 'Successful' : 'Failed'}
          </span>
        </DetailRow>

        {/* Amount */}
        <DetailRow label="Amount">
          <span style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>
            {tx.amount} {tx.token}
          </span>
        </DetailRow>

        {/* Recipients — single sends show who was paid, not just "1" */}
        <DetailRow label="Recipients">
          <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A', fontFamily: isSingleSend && tx.recipientAddress ? "'JetBrains Mono', monospace" : undefined }}>
            {isSingleSend && tx.recipientAddress ? truncAddr(tx.recipientAddress, 6, 4) : tx.recipientCount}
          </span>
        </DetailRow>

        {/* Method — no glow */}
        <DetailRow label="Method">
          <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>
            {methodLabel(tx.type)}
          </span>
        </DetailRow>

        {/* Memo — only shown when there's actually a remark to show */}
        {tx.remark && (
          <DetailRow label="Memo">
            <span style={{ fontSize: 13, color: '#0F172A' }}>{tx.remark}</span>
          </DetailRow>
        )}

        {/* Payroll Receipt — "Not supported" for anything that isn't a batch
            payroll run (receipts only apply there), no glow otherwise */}
        <DetailRow label="Payroll Receipt">
          <ReceiptStatus
            status={tx.receiptEmailStatus}
            onRetry={hasEmail ? () => onResend(tx) : undefined}
            retrying={resending === tx.id}
            notSupported={!tx.receiptEmailStatus && tx.type !== 'batchPay'}
          />
        </DetailRow>

        {/* Tx hash — link icon now ash/grey instead of brand indigo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: '#F8F9FA', borderRadius: 9, marginTop: 10 }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#475569', flex: 1 }}>
            {tx.hash.slice(0, 10)}…{tx.hash.slice(-8)}
          </span>
          <button onClick={async () => { const ok = await copyToClipboard(tx.hash); if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1800); } }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied ? '#14B8A6' : '#94A3B8', padding: 0 }}>
            <Copy size={13} />
          </button>
          <a href={txLink(tx.hash)} target="_blank" rel="noreferrer" style={{ color: '#94A3B8', display: 'flex' }}>
            <ExternalLink size={13} />
          </a>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TransactionHistoryPage() {
  const { address } = useEffectiveAddress();
  const publicClient = usePublicClient();
  const { state, saveTxRecord, hydrateFromCache } = useApp();
  const { payrollSetup, registryClone } = state;
  usePayrollSync({ registryClone, address, publicClient });

  // BUG FIX: hasEmail (below, gates the "Resend" button on each receipt)
  // used to depend entirely on usePayrollSync's full flow finishing —
  // which needs registryClone AND publicClient ready before it even starts
  // its own "instant local cache" step. On a first visit straight to this
  // page (not through Settings or Dashboard first), that could leave
  // hasEmail false — and the Resend button disabled — for a real email
  // that was already sitting in the local cache the whole time. This
  // reads that same cache directly, as soon as the wallet address is
  // known, with no other dependency.
  useEffect(() => {
    if (address) void hydrateFromCache(address);
  }, [address, hydrateFromCache]);

  const [txs,      setTxs]      = useState<TxRecord[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [resending, setResending] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const loadTxs = useCallback(async () => {
    if (!address) { setLoading(false); return; }
    setLoading(true);
    try {
      const records = await getTxsByWallet(address);
      setTxs([...records].sort((a, b) => b.timestamp - a.timestamp));
    } catch { /* IndexedDB unavailable */ }
    finally { setLoading(false); }
  }, [address]);

  useEffect(() => { loadTxs(); }, [loadTxs]);

  // Search by reference code or memo/remark tag
  const filteredTxs = (() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return txs;
    return txs.filter(tx => {
      const ref = (tx.ref ?? ('SLD-' + tx.hash.slice(2, 8).toUpperCase())).toLowerCase();
      const remark = (tx.remark ?? '').toLowerCase();
      return ref.includes(q) || remark.includes(q);
    });
  })();

  // ── Chart: spans actual transaction activity only (first → latest tx) ─────
  const { chartData, maxVolume } = (() => {
    if (!txs.length) return { chartData: [], maxVolume: 0 };

    const buckets: Record<string, number> = {};
    txs.forEach(tx => {
      const key = format(new Date(tx.timestamp), 'MMM yy');
      buckets[key] = (buckets[key] ?? 0) + parseFloat(tx.amount.replace(/,/g, '') || '0');
    });

    // Build a continuous month range spanning actual activity only — from
    // the first transaction's month to the LATEST transaction's month.
    // BUG FIX: this used to extend all the way to today's date regardless
    // of when the last transaction happened, so as real time passed with
    // no new activity, an ever-growing flat run of empty trailing months
    // got appended, squeezing all the real data toward one end of the
    // chart. Bounding to the latest transaction keeps the chart showing
    // only genuine progress.
    const oldest  = Math.min(...txs.map(t => t.timestamp));
    const latest  = Math.max(...txs.map(t => t.timestamp));
    const start   = startOfMonth(new Date(oldest));
    const end     = startOfMonth(new Date(latest));
    const months: string[] = [];
    const cursor  = new Date(start);
    while (cursor <= end) {
      months.push(format(cursor, 'MMM yy'));
      cursor.setMonth(cursor.getMonth() + 1);
    }

    const data = months.map(m => ({ month: m, volume: buckets[m] ?? 0 }));
    const max  = Math.max(...data.map(d => d.volume), 0);
    return { chartData: data, maxVolume: max };
  })();

  const dynamicTicks = getDynamicTicks(maxVolume);

  const totalVolume     = txs.reduce((s, t) => s + parseFloat(t.amount.replace(/,/g, '') || '0'), 0);

  async function handleResendReceipt(tx: TxRecord) {
    const receiptEmail = payrollSetup?.email ?? null;
    if (!receiptEmail) {
      // No company email on file — nothing we can resend to
      return;
    }

    setResending(tx.id);
    try {
      const res = await fetch('/api/payroll-receipt/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txHash:         tx.hash,
          walletAddress:  address,
          recipientEmail: receiptEmail,
          recipientCount: tx.recipientCount,
          amount:         tx.amount,
          token:          tx.token,
          remark:         tx.remark,
          ref:            tx.ref,
          timestamp:      tx.timestamp,
          executedBy:     tx.executedBy ?? 'manual',
        }),
      });
      const newStatus = res.ok ? 'sent' : 'failed';
      await saveTxRecord({ ...tx, receiptEmailStatus: newStatus }, address!);
      setTxs(prev => prev.map(t => t.id === tx.id ? { ...t, receiptEmailStatus: newStatus } : t));
    } catch {
      await saveTxRecord({ ...tx, receiptEmailStatus: 'failed' }, address!).catch(() => {});
      setTxs(prev => prev.map(t => t.id === tx.id ? { ...t, receiptEmailStatus: 'failed' } : t));
    }
    finally { setResending(null); }
  }

  return (
    <AppLayout title="Transaction History">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: '#0F172A', marginBottom: 4 }}>Transaction History</h1>
            <p style={{ fontSize: 14, color: '#64748B' }}>All on-chain payroll receipts, stored locally.</p>
          </div>
          <Button variant="ghost" icon={<RefreshCw size={14} />} onClick={loadTxs} loading={loading} size="sm">
            Refresh
          </Button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Loader2 size={28} color="#4F46E5" style={{ animation: 'spin 0.7s linear infinite', margin: '0 auto' }} />
          </div>
        ) : txs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <TransactionIllustration width={260} height={200} />
            <h3 style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', marginTop: 20 }}>No transactions yet</h3>
            <p style={{ fontSize: 14, color: '#64748B', marginTop: 8 }}>Your payroll receipts will appear here after your first payment run.</p>
          </div>
        ) : (
          <>
            {/* Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14 }}>
              <StatCard label="Total Volume" value={`${totalVolume.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`} icon={<DollarSign size={18} color="#4F46E5" />} />
              <StatCard label="Transactions" value={txs.length.toString()} icon={<TrendingUp size={18} color="#14B8A6" />} color="#14B8A6" />
              <StatCard label="Wallet Activity" value="Swaps · Bridges · Deposits" icon={<Wallet size={18} color="#059669" />} color="#059669" href="/transaction-history/wallet-activity" />
              <StatCard label="Private Transactions" value="Coming soon" icon={<Lock size={18} color="#94A3B8" />} color="#94A3B8" href="/transaction-history/private-transactions" />
            </div>

            {/* Area chart — dynamic range from first tx */}
            <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, padding: 24 }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', marginBottom: 20 }}>
                Payroll Volume (USDC)
              </h3>
              <ResponsiveContainer width="100%" height={190}>
                <AreaChart data={chartData} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="volGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#4F46E5" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="#4F46E5" stopOpacity={0}    />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94A3B8', fontWeight: 500 }}
                    axisLine={{ stroke: '#E2E8F0' }} tickLine={false}
                    tickMargin={10} interval="preserveStartEnd" padding={{ left: 8, right: 8 }} />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false}
                    ticks={dynamicTicks}
                    tickFormatter={fmtTick}
                  />
                  <Tooltip
                    contentStyle={{ borderRadius: 10, border: '1px solid #E2E8F0', fontSize: 13 }}
                    formatter={(v: number) => [`${v.toLocaleString()} USDC`, 'Volume']}
                  />
                  {/* "natural" gives a smooth, flowing curve through the real
                      data points (rather than blocky/linear segments) —
                      this only changes how points are visually connected,
                      never the underlying values. */}
                  <Area type="natural" dataKey="volume" stroke="#4F46E5" strokeWidth={2.5}
                    fill="url(#volGrad)" dot={{ r: 3, fill: '#4F46E5', strokeWidth: 0 }}
                    activeDot={{ r: 5, fill: '#4F46E5', stroke: '#fff', strokeWidth: 2 }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Receipt cards */}
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', marginBottom: 14 }}>
                All Transactions ({filteredTxs.length})
              </h3>

              <div style={{ position: 'relative', marginBottom: 16 }}>
                <Search size={15} color="#94A3B8" style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }} />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search by reference code or memo…"
                  style={{
                    width: '100%', padding: '10px 14px 10px 38px', borderRadius: 10,
                    border: '1px solid #E2E8F0', fontSize: 13, color: '#0F172A',
                    fontFamily: 'inherit', outline: 'none',
                  }}
                  onFocus={e => (e.target.style.borderColor = '#4F46E5')}
                  onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
                />
              </div>

              {filteredTxs.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '32px 0', color: '#94A3B8', fontSize: 13 }}>
                  No transactions match &ldquo;{searchQuery}&rdquo;.
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
                  {filteredTxs.map(tx => (
                    <ReceiptCard key={tx.id} tx={tx}
                      onResend={handleResendReceipt}
                      resending={resending}
                      hasEmail={!!payrollSetup?.email} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </AppLayout>
  );
}
