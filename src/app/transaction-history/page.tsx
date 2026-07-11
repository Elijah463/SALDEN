'use client';
/**
 * @file app/transaction-history/page.tsx
 * - Chart starts from the very first transaction month (not a fixed 6-month window)
 * - Y-axis uses dynamic custom ticks: 0→100→500→1k→5k→10k→20k→50k→100k…
 * - Receipt cards with ref (alphanumeric), type, status badge, invoice status
 * - useEffectiveAddress for Circle social login compatibility
 */

import { useState, useEffect, useCallback } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  ExternalLink, Download, Mail, RefreshCw,
  TrendingUp, Users, DollarSign, Loader2,
  CheckCircle2, AlertCircle, Clock, Copy, XCircle,
} from 'lucide-react';
import { AppLayout }           from '@/components/layout/AppLayout';
import { Button }              from '@/components/shared/Button';
import { useApp }              from '@/context/AppContext';
import { getTxsByWallet, type TxRecord } from '@/lib/db/indexeddb';
import { TransactionIllustration } from '@/components/shared/Illustrations';
import { txLink }              from '@/lib/contracts/config';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
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

// ── Status & Invoice helpers ───────────────────────────────────────────────────

function StatusBadge({ status }: { status: 'success' | 'failed' }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 9px', borderRadius: 99, fontSize: 11, fontWeight: 700,
      background: status === 'success' ? '#ECFDF5' : '#FEF2F2',
      color: status === 'success' ? '#059669' : '#DC2626',
    }}>
      {status === 'success' ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
      {status === 'success' ? 'Successful' : 'Failed'}
    </span>
  );
}

function InvoiceStatus({ status }: { status?: TxRecord['invoiceEmailStatus'] }) {
  if (!status) return null;
  const map = {
    sent:    { icon: <CheckCircle2 size={12} />, color: '#059669', label: 'Invoice sent'  },
    failed:  { icon: <AlertCircle  size={12} />, color: '#DC2626', label: 'Email failed'  },
    pending: { icon: <Clock        size={12} />, color: '#D97706', label: 'Sending…'      },
  } as const;
  const s = map[status as keyof typeof map];
  if (!s) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: s.color, fontWeight: 600 }}>
      {s.icon}{s.label}
    </span>
  );
}

function StatCard({ label, value, icon, color = '#4F46E5' }: { label: string; value: string; icon: React.ReactNode; color?: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 14, padding: '18px 20px' }}>
      <div style={{ width: 36, height: 36, borderRadius: 9, background: color + '18', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}>
        {icon}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: '#0F172A' }}>{value}</div>
      <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>{label}</div>
    </div>
  );
}

// ── Receipt card ───────────────────────────────────────────────────────────────

function ReceiptCard({ tx, onResend, onDownload, resending, genPdf, hasEmail }: {
  tx: TxRecord;
  onResend:   (tx: TxRecord) => void;
  onDownload: (tx: TxRecord) => void;
  resending: string | null;
  genPdf:    string | null;
  hasEmail:  boolean;
}) {
  const [copied, setCopied] = useState(false);
  const ref = tx.ref ?? ('SLD-' + tx.hash.slice(2, 8).toUpperCase());

  return (
    <div style={{
      background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, overflow: 'hidden',
      boxShadow: '0 -1px 2px rgba(15,23,42,0.03), 0 2px 6px rgba(15,23,42,0.05)',
    }}>
      <div style={{ padding: '18px 20px' }}>

        {/* Reference + date */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 800, color: '#4F46E5', letterSpacing: '0.06em', fontFamily: "'JetBrains Mono', monospace" }}>
            {ref}
          </span>
          <span style={{ fontSize: 12, color: '#94A3B8' }}>
            {format(new Date(tx.timestamp), 'dd MMM yyyy · HH:mm')}
          </span>
        </div>

        {/* Amount */}
        <div style={{ fontSize: 28, fontWeight: 900, color: '#0F172A', letterSpacing: '-0.02em', marginBottom: 6 }}>
          {tx.amount} <span style={{ fontSize: 14, fontWeight: 600, color: '#94A3B8' }}>{tx.token}</span>
        </div>

        {/* Recipients */}
        <div style={{ fontSize: 13, color: '#64748B', marginBottom: 12 }}>
          Paid to <strong style={{ color: '#0F172A' }}>{tx.recipientCount}</strong> recipient{tx.recipientCount !== 1 ? 's' : ''}
        </div>

        {/* Badges row */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          <StatusBadge status={tx.status ?? 'success'} />
          <span style={{ padding: '2px 9px', borderRadius: 99, background: '#EEF2FF', color: '#4F46E5', fontSize: 11, fontWeight: 700 }}>
            {tx.type}
          </span>
          {tx.remark && (
            <span style={{ padding: '2px 9px', borderRadius: 99, background: '#F1F5F9', color: '#64748B', fontSize: 11, fontWeight: 600 }}>
              {tx.remark}
            </span>
          )}
          {tx.executedBy === 'ai_agent' && (
            <span style={{ padding: '2px 9px', borderRadius: 99, background: '#EEF2FF', color: '#4F46E5', fontSize: 11, fontWeight: 700 }}>
              AI Agent
            </span>
          )}
        </div>

        {/* Invoice status */}
        {tx.invoiceEmailStatus && (
          <div style={{ marginBottom: 12 }}><InvoiceStatus status={tx.invoiceEmailStatus} /></div>
        )}

        {/* Tx hash */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: '#F8F9FA', borderRadius: 9, marginBottom: 14 }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#475569', flex: 1 }}>
            {tx.hash.slice(0, 10)}…{tx.hash.slice(-8)}
          </span>
          <button onClick={() => { navigator.clipboard?.writeText(tx.hash); setCopied(true); setTimeout(() => setCopied(false), 1800); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied ? '#14B8A6' : '#94A3B8', padding: 0 }}>
            <Copy size={13} />
          </button>
          <a href={txLink(tx.hash)} target="_blank" rel="noreferrer" style={{ color: '#4F46E5', display: 'flex' }}>
            <ExternalLink size={13} />
          </a>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => onDownload(tx)} disabled={genPdf === tx.id}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '9px 0', borderRadius: 9, border: '1.5px solid #E2E8F0', background: '#fff', fontSize: 13, fontWeight: 600, color: '#475569', cursor: genPdf === tx.id ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}>
            {genPdf === tx.id ? <Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Download size={13} />}
            Receipt
          </button>
          <button onClick={() => onResend(tx)} disabled={resending === tx.id || !hasEmail}
            title={!hasEmail ? 'No company email on file' : undefined}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '9px 0', borderRadius: 9, border: 'none', background: hasEmail ? '#EEF2FF' : '#F1F5F9', fontSize: 13, fontWeight: 600, color: hasEmail ? '#4F46E5' : '#94A3B8', cursor: (resending === tx.id || !hasEmail) ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}>
            {resending === tx.id ? <Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Mail size={13} />}
            Invoice
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TransactionHistoryPage() {
  const { address } = useEffectiveAddress();
  const { state, saveTxRecord } = useApp();
  const { payrollSetup } = state;
  const [txs,      setTxs]      = useState<TxRecord[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [resending, setResending] = useState<string | null>(null);
  const [genPdf,   setGenPdf]   = useState<string | null>(null);

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

  // ── Chart: from very first transaction month → now ────────────────────────
  const { chartData, maxVolume } = (() => {
    if (!txs.length) return { chartData: [], maxVolume: 0 };

    const buckets: Record<string, number> = {};
    txs.forEach(tx => {
      const key = format(new Date(tx.timestamp), 'MMM yy');
      buckets[key] = (buckets[key] ?? 0) + parseFloat(tx.amount.replace(/,/g, '') || '0');
    });

    // Build a continuous month range from first tx month to now
    const oldest  = Math.min(...txs.map(t => t.timestamp));
    const start   = startOfMonth(new Date(oldest));
    const now     = new Date();
    const months: string[] = [];
    const cursor  = new Date(start);
    while (cursor <= now) {
      months.push(format(cursor, 'MMM yy'));
      cursor.setMonth(cursor.getMonth() + 1);
    }

    const data = months.map(m => ({ month: m, volume: buckets[m] ?? 0 }));
    const max  = Math.max(...data.map(d => d.volume), 0);
    return { chartData: data, maxVolume: max };
  })();

  const dynamicTicks = getDynamicTicks(maxVolume);

  const totalVolume     = txs.reduce((s, t) => s + parseFloat(t.amount.replace(/,/g, '') || '0'), 0);
  const totalRecipients = txs.reduce((s, t) => s + t.recipientCount, 0);

  async function handleResendInvoice(tx: TxRecord) {
    const invoiceEmail = payrollSetup?.email ?? null;
    if (!invoiceEmail) {
      // No company email on file — nothing we can resend to
      return;
    }

    setResending(tx.id);
    try {
      const res = await fetch('/api/invoice/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txHash:         tx.hash,
          walletAddress:  address,
          recipientEmail: invoiceEmail,
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
      await saveTxRecord({ ...tx, invoiceEmailStatus: newStatus }, address!);
      setTxs(prev => prev.map(t => t.id === tx.id ? { ...t, invoiceEmailStatus: newStatus } : t));
    } catch {
      await saveTxRecord({ ...tx, invoiceEmailStatus: 'failed' }, address!).catch(() => {});
      setTxs(prev => prev.map(t => t.id === tx.id ? { ...t, invoiceEmailStatus: 'failed' } : t));
    }
    finally { setResending(null); }
  }

  async function handleDownloadPdf(tx: TxRecord) {
    setGenPdf(tx.id);
    try {
      const ref = tx.ref ?? ('SLD-' + tx.hash.slice(2, 8).toUpperCase());
      const { jsPDF } = await import('jspdf');
      const doc = new jsPDF();
      doc.setFontSize(18); doc.setTextColor(79, 70, 229);
      doc.text('SALDEN PAYROLL RECEIPT', 20, 24);
      doc.setFontSize(10); doc.setTextColor(100, 116, 139);
      doc.text(`Reference: ${ref}`, 20, 36);
      doc.text(`Date: ${format(new Date(tx.timestamp), 'PPP')}`, 20, 44);
      doc.text(`Transaction: ${tx.hash}`, 20, 52);
      doc.text(`Recipients: ${tx.recipientCount}`, 20, 60);
      doc.text(`Token: ${tx.token}`, 20, 68);
      if (tx.remark) doc.text(`Remark: ${tx.remark}`, 20, 76);
      const executedByLabel = tx.executedBy === 'ai_agent'
        ? 'Executed by: Salden AI Payroll Agent (autonomous)'
        : 'Executed by: Employer (manual)';
      doc.text(executedByLabel, 20, tx.remark ? 84 : 76);
      doc.setFontSize(14); doc.setTextColor(15, 23, 42);
      doc.text(`Total Amount: ${tx.amount} ${tx.token}`, 20, tx.remark ? 100 : 92);
      doc.setFontSize(9); doc.setTextColor(148, 163, 184);
      doc.text('Generated by Salden · Arc Testnet', 20, 280);
      doc.save(`salden-receipt-${ref}.pdf`);
    } finally { setGenPdf(null); }
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
              <StatCard label="Recipients Paid" value={totalRecipients.toString()} icon={<Users size={18} color="#059669" />} color="#059669" />
            </div>

            {/* Area chart — dynamic range from first tx */}
            <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, padding: 24 }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', marginBottom: 20 }}>
                Payroll Volume (USDC)
              </h3>
              <ResponsiveContainer width="100%" height={190}>
                <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="volGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#4F46E5" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="#4F46E5" stopOpacity={0}    />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false}
                    interval={Math.max(0, Math.floor(chartData.length / 6) - 1)} />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false}
                    ticks={dynamicTicks}
                    tickFormatter={fmtTick}
                  />
                  <Tooltip
                    contentStyle={{ borderRadius: 10, border: '1px solid #E2E8F0', fontSize: 13 }}
                    formatter={(v: number) => [`${v.toLocaleString()} USDC`, 'Volume']}
                  />
                  <Area type="monotone" dataKey="volume" stroke="#4F46E5" strokeWidth={2}
                    fill="url(#volGrad)" dot={false} activeDot={{ r: 4, fill: '#4F46E5' }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Receipt cards */}
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', marginBottom: 14 }}>
                All Transactions ({txs.length})
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
                {txs.map(tx => (
                  <ReceiptCard key={tx.id} tx={tx}
                    onResend={handleResendInvoice}
                    onDownload={handleDownloadPdf}
                    resending={resending} genPdf={genPdf}
                    hasEmail={!!payrollSetup?.email} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </AppLayout>
  );
}
