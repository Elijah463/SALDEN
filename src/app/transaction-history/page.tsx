'use client';
/**
 * @file app/transaction-history/page.tsx
 * Transaction History — reads from IndexedDB, shows area chart + table.
 * Invoice email can be re-sent per transaction. PDF receipt downloadable.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAccount } from 'wagmi';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  ExternalLink, Download, Mail, RefreshCw,
  TrendingUp, Users, DollarSign, Loader2,
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/shared/Button';
import { getTxsByWallet, type TxRecord } from '@/lib/db/indexeddb';
import { truncAddr } from '@/lib/validation';
import { TransactionIllustration } from '@/components/shared/Illustrations';
import { format } from 'date-fns';

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusBadge(status: TxRecord['invoiceEmailStatus']) {
  if (!status) return null;
  const map = {
    sent:    { bg: '#ECFDF5', color: '#059669', label: 'Invoice Sent'  },
    failed:  { bg: '#FEF2F2', color: '#DC2626', label: 'Email Failed'  },
    pending: { bg: '#FFFBEB', color: '#D97706', label: 'Sending…'      },
  } as const;
  const s = map[status as keyof typeof map];
  if (!s) return null;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 10px', borderRadius: 99,
      background: s.bg, color: s.color,
      fontSize: 11, fontWeight: 600,
    }}>{s.label}</span>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, icon, color = '#4F46E5' }: {
  label: string; value: string; icon: React.ReactNode; color?: string;
}) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #E2E8F0',
      borderRadius: 14, padding: '18px 20px',
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 9,
        background: color + '15',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 10,
      }}>{icon}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: '#0F172A' }}>{value}</div>
      <div style={{ fontSize: 12, color: '#64748B', marginTop: 2, fontWeight: 500 }}>{label}</div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TransactionHistoryPage() {
  const { address } = useAccount();
  const [txs,      setTxs]      = useState<TxRecord[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [resending, setResending] = useState<string | null>(null);
  const [genPdf,   setGenPdf]   = useState<string | null>(null);

  const loadTxs = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      // address is guaranteed string here — we guard above
      const records = await getTxsByWallet(address as string);
      setTxs(records);
    } catch { /* IndexedDB unavailable or SSR */ }
    finally { setLoading(false); }
  }, [address]);

  useEffect(() => { loadTxs(); }, [loadTxs]);

  // ── Chart data: last 12 months volume ─────────────────────────────────────

  const chartData = (() => {
    const buckets: Record<string, number> = {};
    txs.forEach(tx => {
      const month = format(new Date(tx.timestamp), 'MMM yy');
      buckets[month] = (buckets[month] ?? 0) + parseFloat(tx.amount.replace(/,/g, '') || '0');
    });

    // Last 6 months
    const months: string[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      months.push(format(d, 'MMM yy'));
    }

    return months.map(m => ({ month: m, volume: buckets[m] ?? 0 }));
  })();

  // ── Stats ─────────────────────────────────────────────────────────────────

  const totalVolume = txs.reduce((sum, tx) => sum + parseFloat(tx.amount.replace(/,/g, '') || '0'), 0);
  const totalRecipients = txs.reduce((sum, tx) => sum + tx.recipientCount, 0);

  // ── Resend invoice ────────────────────────────────────────────────────────

  async function handleResendInvoice(tx: TxRecord) {
    setResending(tx.id);
    try {
      const res = await fetch('/api/invoice/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txHash: tx.hash, walletAddress: address }),
      });
      if (!res.ok) throw new Error('Failed to resend invoice');
    } catch { /* silently handle */ }
    finally { setResending(null); }
  }

  // ── Download PDF receipt ──────────────────────────────────────────────────

  async function handleDownloadPdf(tx: TxRecord) {
    setGenPdf(tx.id);
    try {
      const { jsPDF } = await import('jspdf');
      const doc = new jsPDF();
      doc.setFontSize(18);
      doc.setTextColor(79, 70, 229);
      doc.text('SALDEN PAYROLL RECEIPT', 20, 24);
      doc.setFontSize(10);
      doc.setTextColor(100, 116, 139);
      doc.text(`Date: ${format(new Date(tx.timestamp), 'PPP')}`, 20, 36);
      doc.text(`Transaction: ${tx.hash}`, 20, 44);
      doc.text(`Recipients: ${tx.recipientCount}`, 20, 52);
      doc.text(`Token: ${tx.token}`, 20, 60);
      doc.setFontSize(14);
      doc.setTextColor(15, 23, 42);
      doc.text(`Total Amount: ${tx.amount} ${tx.token}`, 20, 72);
      doc.setFontSize(9);
      doc.setTextColor(148, 163, 184);
      doc.text('Generated by Salden · salden.xyz · Arc Testnet', 20, 280);
      doc.save(`salden-receipt-${tx.hash.slice(0, 10)}.pdf`);
    } finally { setGenPdf(null); }
  }

  return (
    <AppLayout title="Transaction History">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: '#0F172A', marginBottom: 4 }}>
              Transaction History
            </h1>
            <p style={{ fontSize: 14, color: '#64748B' }}>
              All Onchain payroll transactions — stored locally and always accessible.
            </p>
          </div>
          <Button variant="ghost" icon={<RefreshCw size={14} />} onClick={loadTxs} loading={loading} size="sm">
            Refresh
          </Button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Loader2 size={28} color="#4F46E5" style={{ animation: 'spin 0.7s linear infinite', margin: '0 auto' }} />
            <p style={{ color: '#64748B', fontSize: 14, marginTop: 12 }}>Loading transactions…</p>
          </div>
        ) : txs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <TransactionIllustration width={260} height={200} />
            <h3 style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', marginTop: 20 }}>No transactions yet</h3>
            <p style={{ fontSize: 14, color: '#64748B', marginTop: 8 }}>
              Your payroll transactions will appear here after your first payment run.
            </p>
          </div>
        ) : (
          <>
            {/* Stats row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
              <StatCard
                label="Total Volume"
                value={`${totalVolume.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`}
                icon={<DollarSign size={18} color="#4F46E5" />}
              />
              <StatCard
                label="Total Transactions"
                value={txs.length.toLocaleString()}
                icon={<TrendingUp size={18} color="#14B8A6" />}
                color="#14B8A6"
              />
              <StatCard
                label="Total Recipients Paid"
                value={totalRecipients.toLocaleString()}
                icon={<Users size={18} color="#059669" />}
                color="#059669"
              />
            </div>

            {/* Area chart */}
            <div style={{
              background: '#fff', border: '1px solid #E2E8F0',
              borderRadius: 16, padding: '24px',
            }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', marginBottom: 20 }}>
                Payroll Volume — Last 6 Months (USDC)
              </h3>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
                  <defs>
                    <linearGradient id="volGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#4F46E5" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="#4F46E5" stopOpacity={0}    />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false}
                    tickFormatter={v => v === 0 ? '0' : `${(v/1000).toFixed(0)}k`} />
                  <Tooltip
                    contentStyle={{ borderRadius: 10, border: '1px solid #E2E8F0', fontSize: 13 }}
                    formatter={(v: number) => [`${v.toLocaleString()} USDC`, 'Volume']}
                  />
                  <Area type="monotone" dataKey="volume" stroke="#4F46E5" strokeWidth={2}
                    fill="url(#volGradient)" dot={{ fill: '#4F46E5', r: 3 }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Transaction table */}
            <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, overflow: 'hidden' }}>
              <div style={{ padding: '16px 20px', borderBottom: '1px solid #E2E8F0' }}>
                <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>All Transactions</h3>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #E2E8F0' }}>
                      {['Date', 'Tx Hash', 'Recipients', 'Amount', 'Token', 'Invoice', 'Actions'].map(h => (
                        <th key={h} style={{
                          textAlign: 'left', padding: '10px 18px',
                          fontSize: 11, fontWeight: 700, color: '#94A3B8',
                          textTransform: 'uppercase', letterSpacing: '0.05em',
                          whiteSpace: 'nowrap',
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {txs.map(tx => (
                      <tr key={tx.id} style={{ borderBottom: '1px solid #F1F5F9' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#F8F9FA')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <td style={{ padding: '13px 18px', fontSize: 13, color: '#475569', whiteSpace: 'nowrap' }}>
                          {format(new Date(tx.timestamp), 'dd MMM yyyy')}
                        </td>
                        <td style={{ padding: '13px 18px' }}>
                          <a
                            href={`https://testnet.arcscan.app/tx/${tx.hash}`}
                            target="_blank" rel="noreferrer"
                            style={{
                              display: 'flex', alignItems: 'center', gap: 5,
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: 12, color: '#4F46E5',
                            }}
                          >
                            {truncAddr(tx.hash, 8, 6)}
                            <ExternalLink size={11} />
                          </a>
                        </td>
                        <td style={{ padding: '13px 18px', fontSize: 13, color: '#0F172A', fontWeight: 600 }}>
                          {tx.recipientCount}
                        </td>
                        <td style={{ padding: '13px 18px', fontSize: 13, fontWeight: 700, color: '#0F172A' }}>
                          {tx.amount}
                        </td>
                        <td style={{ padding: '13px 18px' }}>
                          <span style={{
                            padding: '2px 10px', borderRadius: 99,
                            background: '#EEF2FF', color: '#4F46E5',
                            fontSize: 11, fontWeight: 600,
                          }}>{tx.token}</span>
                        </td>
                        <td style={{ padding: '13px 18px' }}>
                          {statusBadge(tx.invoiceEmailStatus) ?? (
                            <span style={{ fontSize: 12, color: '#E2E8F0' }}>—</span>
                          )}
                        </td>
                        <td style={{ padding: '13px 18px' }}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              onClick={() => handleResendInvoice(tx)}
                              disabled={resending === tx.id}
                              title="Resend invoice email"
                              style={{
                                width: 30, height: 30, borderRadius: 7,
                                border: '1px solid #E2E8F0', background: '#F8F9FA',
                                cursor: resending === tx.id ? 'not-allowed' : 'pointer',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                              }}
                            >
                              {resending === tx.id
                                ? <Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} />
                                : <Mail size={13} color="#64748B" />}
                            </button>
                            <button
                              onClick={() => handleDownloadPdf(tx)}
                              disabled={genPdf === tx.id}
                              title="Download PDF receipt"
                              style={{
                                width: 30, height: 30, borderRadius: 7,
                                border: '1px solid #E2E8F0', background: '#F8F9FA',
                                cursor: genPdf === tx.id ? 'not-allowed' : 'pointer',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                              }}
                            >
                              {genPdf === tx.id
                                ? <Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} />
                                : <Download size={13} color="#64748B" />}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </AppLayout>
  );
}
