'use client';
/**
 * @file app/ai-agent/manage/page.tsx
 * Manage AI Agent — view recurring/scheduled payments, success/failed history,
 * active/past schedules (filterable by group or individual), full agent logs.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useWalletClient } from 'wagmi';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import {
  Clock, CheckCircle2, AlertTriangle,
  Filter, RefreshCw, Calendar, Repeat, List,
  ChevronDown, ExternalLink, Plus,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { AgentLayout } from '@/components/agent/AgentLayout';
import { SetSchedulePaymentModal } from '@/components/agent/SetSchedulePaymentModal';
import { RecurringPaymentModal } from '@/components/agent/RecurringPaymentModal';
import { useAgentSession } from '@/lib/agent/useAgentSession';
import {
  getAgentLogs, type AgentLog,
  getAgentSchedules, saveAgentSchedule, type AgentSchedule,
} from '@/lib/db/indexeddb';
import { txLink } from '@/lib/contracts/config';
import { format } from 'date-fns';

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, icon, color }: { label: string; value: string | number; icon: React.ReactNode; color: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {icon}
      </div>
      <div>
        <div style={{ fontSize: 22, fontWeight: 800, color: '#0F172A' }}>{value}</div>
        <div style={{ fontSize: 12, color: '#64748B' }}>{label}</div>
      </div>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default function ManageAgentPage() {
  const router      = useRouter();
  const { state }   = useApp();
  const { address } = useEffectiveAddress();
  const { data: walletClient } = useWalletClient();
  const { getToken } = useAgentSession();
  const { groups, isPremiumUser } = state;

  const [logs,         setLogs]         = useState<AgentLog[]>([]);
  const [schedules,    setSchedules]    = useState<AgentSchedule[]>([]);
  const [activeTab,    setActiveTab]    = useState<'history' | 'schedules' | 'logs'>('history');
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'failed'>('all');
  const [groupFilter,  setGroupFilter]  = useState<string>('All');
  const [filterOpen,   setFilterOpen]   = useState(false);
  const [loading,      setLoading]      = useState(false);
  const [scheduleModalOpen,  setScheduleModalOpen]  = useState(false);
  const [recurringTarget,    setRecurringTarget]    = useState<AgentSchedule | null>(null);

  useEffect(() => {
    if (!isPremiumUser) router.replace('/ai-agent');
  }, [isPremiumUser, router]);

  // Load schedules from IndexedDB (source of truth for the UI) and push a
  // heartbeat to the server's in-memory store (see scheduleStore.ts for why
  // this self-heal-on-visit pattern exists instead of a real database).
  const loadSchedules = useCallback(async () => {
    if (!address) return;
    const local = await getAgentSchedules(address);
    setSchedules(local);

    if (walletClient && local.length > 0) {
      try {
        const token = await getToken(address, walletClient);
        await fetch('/api/agent/schedule/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ walletAddress: address, schedules: local }),
        });
      } catch {
        /* best-effort heartbeat — schedules still work locally; next visit retries */
      }
    }
  }, [address, walletClient, getToken]);

  useEffect(() => { void loadSchedules(); }, [loadSchedules]);

  const syncOneToServer = useCallback((schedule: AgentSchedule) => {
    if (!address || !walletClient) return;
    (async () => {
      try {
        const token = await getToken(address, walletClient);
        await fetch('/api/agent/schedule/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ walletAddress: address, schedules: [schedule] }),
        });
      } catch { /* self-heals on next page load */ }
    })();
  }, [address, walletClient, getToken]);

  useEffect(() => {
    if (!address) return;
    setLoading(true);
    getAgentLogs(address)
      .then(setLogs)
      .finally(() => setLoading(false));
  }, [address]);

  const filteredLogs = logs.filter(log => {
    if (statusFilter !== 'all' && log.status !== statusFilter) return false;
    if (groupFilter !== 'All' && !log.action.toLowerCase().includes(groupFilter.toLowerCase())) return false;
    return true;
  });

  const successCount = logs.filter(l => l.status === 'success').length;
  const failedCount  = logs.filter(l => l.status === 'failed').length;
  const activeScheds = schedules.filter(s => s.status === 'active').length;

  return (
    <AgentLayout title="Manage AI Agent">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Page header row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', marginBottom: 4 }}>Manage AI Agent</h2>
            <p style={{ fontSize: 12, color: '#64748B', margin: 0 }}>View history, schedules, and full execution logs</p>
          </div>
          <button onClick={() => { if (address) { setLoading(true); getAgentLogs(address).then(setLogs).finally(() => setLoading(false)); } }}
            style={{ width: 36, height: 36, borderRadius: 8, border: '1px solid #E2E8F0', background: '#F8F9FA', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#475569' }}
            title="Refresh">
            <RefreshCw size={15} style={{ animation: loading ? 'spin 0.8s linear infinite' : 'none' }} />
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
          <StatCard label="Successful Actions" value={successCount} icon={<CheckCircle2 size={18} color="#059669" />} color="#059669" />
          <StatCard label="Failed Actions"     value={failedCount}  icon={<AlertTriangle size={18} color="#DC2626" />} color="#DC2626" />
          <StatCard label="Active Schedules"   value={activeScheds} icon={<Clock size={18} color="#4F46E5" />}         color="#4F46E5" />
          <StatCard label="Total Runs"         value={logs.length}  icon={<List size={18} color="#14B8A6" />}          color="#14B8A6" />
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #E2E8F0', background: '#fff', borderRadius: '12px 12px 0 0', overflow: 'hidden' }}>
          {([
            { key: 'history',   label: 'Payment History', icon: <CheckCircle2 size={14} /> },
            { key: 'schedules', label: 'Schedules',        icon: <Calendar size={14} /> },
            { key: 'logs',      label: 'Full Log',         icon: <List size={14} /> },
          ] as const).map(({ key, label, icon }) => (
            <button key={key} onClick={() => setActiveTab(key)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '11px 18px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: activeTab === key ? 700 : 500, color: activeTab === key ? '#14B8A6' : '#64748B', borderBottom: activeTab === key ? '2px solid #14B8A6' : '2px solid transparent' }}>
              {icon} {label}
            </button>
          ))}
        </div>

        {/* Filter bar */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', background: '#fff', padding: '12px 16px', borderRadius: 12, border: '1px solid #E2E8F0' }}>
          <Filter size={14} color="#94A3B8" />
          <span style={{ fontSize: 13, color: '#64748B', fontWeight: 500 }}>Filter:</span>

          {/* Status filter */}
          <div style={{ display: 'flex', gap: 4 }}>
            {(['all', 'success', 'failed'] as const).map(s => (
              <button key={s} onClick={() => setStatusFilter(s)}
                style={{ padding: '4px 12px', borderRadius: 99, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
                  background: statusFilter === s ? (s === 'success' ? '#ECFDF5' : s === 'failed' ? '#FEF2F2' : '#F0FDFA') : '#F8F9FA',
                  color:      statusFilter === s ? (s === 'success' ? '#059669' : s === 'failed' ? '#DC2626' : '#14B8A6')  : '#64748B',
                }}>
                {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>

          {/* Group filter */}
          {groups.length > 0 && (
            <div style={{ position: 'relative', marginLeft: 'auto' }}>
              <button onClick={() => setFilterOpen(v => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, border: '1.5px solid #E2E8F0', background: '#F8F9FA', fontSize: 12, fontWeight: 500, cursor: 'pointer', color: '#475569', fontFamily: 'inherit' }}>
                {groupFilter}
                <ChevronDown size={12} />
              </button>
              {filterOpen && (
                <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: '#fff', border: '1px solid #E2E8F0', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.08)', zIndex: 10, minWidth: 160, padding: '4px 0' }}>
                  {['All', ...groups].map(g => (
                    <button key={g} onClick={() => { setGroupFilter(g); setFilterOpen(false); }}
                      style={{ width: '100%', padding: '8px 14px', textAlign: 'left', background: g === groupFilter ? '#F0FDFA' : 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: g === groupFilter ? '#14B8A6' : '#475569', fontFamily: 'inherit' }}>
                      {g}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── History tab ──────────────────────────────────────────────────── */}
        {activeTab === 'history' && (
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: '0 0 16px 16px', overflow: 'hidden' }}>
            {filteredLogs.filter(l => l.action.toLowerCase().includes('pay') || l.action.toLowerCase().includes('batch')).length === 0 ? (
              <div style={{ padding: '48px 20px', textAlign: 'center' }}>
                <CheckCircle2 size={32} color="#E2E8F0" style={{ margin: '0 auto 12px' }} />
                <p style={{ color: '#94A3B8', fontSize: 14 }}>No payment history yet. Ask the agent to run payroll.</p>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #E2E8F0', background: '#F8F9FA' }}>
                    {['Time', 'Action', 'Status', 'Tx Hash'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '10px 18px', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredLogs.filter(l => l.action.toLowerCase().includes('pay') || l.action.toLowerCase().includes('batch')).map(log => (
                    <tr key={log.id} style={{ borderBottom: '1px solid #F1F5F9' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#F8F9FA')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <td style={{ padding: '12px 18px', fontSize: 12, color: '#64748B', whiteSpace: 'nowrap' }}>{format(new Date(log.timestamp), 'dd MMM yyyy, HH:mm')}</td>
                      <td style={{ padding: '12px 18px', fontSize: 13, color: '#0F172A', maxWidth: 300 }}>{log.action}{log.details ? <span style={{ color: '#94A3B8', marginLeft: 6, fontSize: 12 }}>— {log.details}</span> : null}</td>
                      <td style={{ padding: '12px 18px' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 99, fontSize: 11, fontWeight: 600, background: log.status === 'success' ? '#ECFDF5' : '#FEF2F2', color: log.status === 'success' ? '#059669' : '#DC2626' }}>
                          {log.status === 'success' ? <CheckCircle2 size={10} /> : <AlertTriangle size={10} />}
                          {log.status}
                        </span>
                      </td>
                      <td style={{ padding: '12px 18px' }}>
                        {log.txHash ? (
                          <a href={txLink(log.txHash)} target="_blank" rel="noreferrer"
                            style={{ fontFamily: 'monospace', fontSize: 12, color: '#4F46E5', display: 'flex', alignItems: 'center', gap: 4 }}>
                            {log.txHash.slice(0, 10)}…
                            <ExternalLink size={11} />
                          </a>
                        ) : <span style={{ color: '#CBD5E1' }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── Schedules tab ────────────────────────────────────────────────── */}
        {activeTab === 'schedules' && (
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: '0 0 16px 16px', padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
              <button
                onClick={() => setScheduleModalOpen(true)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px',
                  borderRadius: 9, border: 'none', background: '#14B8A6', color: '#fff',
                  fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                <Plus size={14} /> Set Schedule Payments
              </button>
            </div>

            {schedules.length === 0 ? (
              <div style={{ padding: '48px 20px', textAlign: 'center' }}>
                <Repeat size={32} color="#E2E8F0" style={{ margin: '0 auto 12px' }} />
                <p style={{ color: '#94A3B8', fontSize: 14 }}>No scheduled jobs yet.</p>
                <p style={{ color: '#94A3B8', fontSize: 13, marginTop: 4 }}>
                  Use "Set Schedule Payments" above, or go to the <button onClick={() => router.push('/ai-agent')} style={{ background: 'none', border: 'none', color: '#14B8A6', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, padding: 0 }}>AI Agent chat</button> and ask it to schedule a payroll run.
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {schedules.map(schedule => (
                  <div key={schedule.id} style={{ border: '1px solid #E2E8F0', borderRadius: 12, padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                    <div style={{ width: 40, height: 40, borderRadius: 10, background: schedule.status === 'active' ? '#EEF2FF' : '#F8F9FA', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Repeat size={18} color={schedule.status === 'active' ? '#4F46E5' : '#94A3B8'} />
                    </div>
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A' }}>{schedule.label}</div>
                      <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>
                        {schedule.group ?? 'All Employees'} · Next run: {schedule.nextRunAt ? format(new Date(schedule.nextRunAt), 'dd MMM yyyy, HH:mm') + ' UTC' : '—'}
                        {schedule.lastRunAt ? ` · Last run: ${format(new Date(schedule.lastRunAt), 'dd MMM, HH:mm')}` : ''}
                        {schedule.type === 'recurring' && schedule.recurrence ? ` · Repeats ${schedule.recurrence}` : ''}
                      </div>
                    </div>

                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569', cursor: 'pointer' }}>
                      Recurring
                      <span
                        role="switch"
                        aria-checked={schedule.type === 'recurring'}
                        onClick={() => {
                          if (schedule.type === 'recurring') {
                            // Turning off recurring — revert to a one-off schedule keeping the same next run.
                            const reverted: AgentSchedule = { ...schedule, type: 'scheduled', recurrence: undefined };
                            void saveAgentSchedule(reverted).then(() => {
                              setSchedules(prev => prev.map(s => s.id === reverted.id ? reverted : s));
                              syncOneToServer(reverted);
                            });
                          } else {
                            setRecurringTarget(schedule);
                          }
                        }}
                        style={{
                          width: 34, height: 19, borderRadius: 99, position: 'relative', cursor: 'pointer',
                          background: schedule.type === 'recurring' ? '#4F46E5' : '#E2E8F0', transition: 'background 0.15s',
                        }}
                      >
                        <span style={{
                          position: 'absolute', top: 2, left: schedule.type === 'recurring' ? 17 : 2,
                          width: 15, height: 15, borderRadius: '50%', background: '#fff', transition: 'left 0.15s',
                        }} />
                      </span>
                    </label>

                    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 12px', borderRadius: 99, fontSize: 11, fontWeight: 600, background: schedule.status === 'active' ? '#EEF2FF' : '#F8F9FA', color: schedule.status === 'active' ? '#4F46E5' : '#94A3B8' }}>
                      {schedule.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {address && (
          <SetSchedulePaymentModal
            open={scheduleModalOpen}
            onClose={() => setScheduleModalOpen(false)}
            walletAddress={address}
            sessionToken={null}
            onScheduled={(s) => { setSchedules(prev => [s, ...prev]); syncOneToServer(s); }}
          />
        )}
        {recurringTarget && (
          <RecurringPaymentModal
            open={!!recurringTarget}
            schedule={recurringTarget}
            onClose={() => setRecurringTarget(null)}
            onUpdated={(updated) => setSchedules(prev => prev.map(s => s.id === updated.id ? updated : s))}
            syncToServer={syncOneToServer}
          />
        )}

        {/* ── Full log tab ─────────────────────────────────────────────────── */}
        {activeTab === 'logs' && (
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: '0 0 16px 16px', overflow: 'hidden' }}>
            {filteredLogs.length === 0 ? (
              <div style={{ padding: '48px 20px', textAlign: 'center' }}>
                <List size={32} color="#E2E8F0" style={{ margin: '0 auto 12px' }} />
                <p style={{ color: '#94A3B8', fontSize: 14 }}>No logs match the current filter.</p>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #E2E8F0', background: '#F8F9FA' }}>
                    {['Time', 'Action', 'Details', 'Status', 'Tx'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '10px 16px', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredLogs.map(log => (
                    <tr key={log.id} style={{ borderBottom: '1px solid #F1F5F9' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#F8F9FA')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <td style={{ padding: '10px 16px', fontSize: 11, color: '#64748B', whiteSpace: 'nowrap' }}>{format(new Date(log.timestamp), 'dd MMM HH:mm')}</td>
                      <td style={{ padding: '10px 16px', fontSize: 13, color: '#0F172A' }}>{log.action}</td>
                      <td style={{ padding: '10px 16px', fontSize: 12, color: '#64748B', maxWidth: 200 }}>{log.details ?? '—'}</td>
                      <td style={{ padding: '10px 16px' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 99, fontSize: 10, fontWeight: 600, background: log.status === 'success' ? '#ECFDF5' : '#FEF2F2', color: log.status === 'success' ? '#059669' : '#DC2626' }}>
                          {log.status === 'success' ? <CheckCircle2 size={9} /> : <AlertTriangle size={9} />}
                          {log.status}
                        </span>
                      </td>
                      <td style={{ padding: '10px 16px' }}>
                        {log.txHash ? (
                          <a href={txLink(log.txHash)} target="_blank" rel="noreferrer"
                            style={{ fontFamily: 'monospace', fontSize: 11, color: '#4F46E5', display: 'flex', alignItems: 'center', gap: 3 }}>
                            {log.txHash.slice(0, 8)}…
                            <ExternalLink size={10} />
                          </a>
                        ) : <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </AgentLayout>
  );
}
