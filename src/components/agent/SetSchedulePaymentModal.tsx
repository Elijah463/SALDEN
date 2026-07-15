'use client';
/**
 * @file components/agent/SetSchedulePaymentModal.tsx
 * "Set Schedule Payments" modal — lets the user schedule a future payroll
 * run (all employees or a specific group) in USDC (EURC shown but
 * disabled — "Soon"), for an exact UTC date/time.
 *
 * Resolves the actual recipient list + amounts HERE, client-side, at
 * creation time — this is the only point in the whole flow where the
 * decrypted employee list is available (see AgentSchedule.resolvedPayments
 * doc comment in lib/db/indexeddb.ts for why the cron executor can't do
 * this itself).
 */

import { useState, useMemo } from 'react';
import { X, Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { useAgentStatus } from '@/lib/useAgentStatus';
import { saveAgentSchedule, type AgentSchedule } from '@/lib/db/indexeddb';
import { CONTRACTS } from '@/lib/contracts/config';
import { ALL_EMPLOYEES_LABEL } from '@/lib/groups';

interface SetSchedulePaymentModalProps {
  open: boolean;
  onClose: () => void;
  walletAddress: string;
  sessionToken: string | null;
  onScheduled: (schedule: AgentSchedule) => void;
}

async function syncScheduleToServer(walletAddress: string, schedule: AgentSchedule, token: string | null) {
  if (!token) return; // best-effort — IndexedDB save already succeeded; the manage page's own load-time sync is the primary self-heal mechanism
  try {
    await fetch('/api/agent/schedule/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ walletAddress, schedules: [schedule] }),
    });
  } catch { /* self-heals next time the manage page loads — see scheduleStore.ts */ }
}

// ── Compact date/time sub-modal ──────────────────────────────────────────────

function DateTimePicker({
  initial, onCancel, onSet,
}: {
  initial: Date;
  onCancel: () => void;
  onSet: (d: Date) => void;
}) {
  const [viewMonth, setViewMonth] = useState(new Date(initial.getUTCFullYear(), initial.getUTCMonth(), 1));
  const [selectedDay, setSelectedDay] = useState(initial.getUTCDate());
  const [selectedMonth, setSelectedMonth] = useState(initial.getUTCMonth());
  const [selectedYear, setSelectedYear] = useState(initial.getUTCFullYear());
  const [hour, setHour] = useState(initial.getUTCHours());
  const [minute, setMinute] = useState(initial.getUTCMinutes());

  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
  const firstWeekday = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1).getDay();
  const monthLabel = viewMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  function pickDay(day: number) {
    setSelectedDay(day);
    setSelectedMonth(viewMonth.getMonth());
    setSelectedYear(viewMonth.getFullYear());
  }

  function handleSet() {
    const d = new Date(Date.UTC(selectedYear, selectedMonth, selectedDay, hour, minute, 0));
    onSet(d);
  }

  const cells: Array<number | null> = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', zIndex: 70,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 20, width: 320, maxWidth: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <button onClick={() => setViewMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748B' }}>
            <ChevronLeft size={18} />
          </button>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{monthLabel}</span>
          <button onClick={() => setViewMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748B' }}>
            <ChevronRight size={18} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 4 }}>
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
            <div key={i} style={{ textAlign: 'center', fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>{d}</div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 16 }}>
          {cells.map((day, i) => {
            const isSelected = day !== null && day === selectedDay && viewMonth.getMonth() === selectedMonth && viewMonth.getFullYear() === selectedYear;
            return (
              <button
                key={i}
                disabled={day === null}
                onClick={() => day !== null && pickDay(day)}
                style={{
                  aspectRatio: '1', border: 'none', borderRadius: 8, fontSize: 12,
                  background: isSelected ? '#14B8A6' : 'transparent',
                  color: day === null ? 'transparent' : isSelected ? '#fff' : '#334155',
                  cursor: day === null ? 'default' : 'pointer', fontWeight: isSelected ? 700 : 400,
                }}
              >
                {day ?? ''}
              </button>
            );
          })}
        </div>

        <div style={{ fontSize: 12, color: '#64748B', fontWeight: 600, marginBottom: 6 }}>Time (UTC)</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <input
            type="number" min={0} max={23} value={hour}
            onChange={e => setHour(Math.min(23, Math.max(0, Number(e.target.value) || 0)))}
            style={{ width: '50%', padding: '8px 10px', borderRadius: 8, border: '1px solid #E2E8F0', fontSize: 14, textAlign: 'center' }}
            aria-label="Hour (UTC)"
          />
          <input
            type="number" min={0} max={59} value={minute}
            onChange={e => setMinute(Math.min(59, Math.max(0, Number(e.target.value) || 0)))}
            style={{ width: '50%', padding: '8px 10px', borderRadius: 8, border: '1px solid #E2E8F0', fontSize: 14, textAlign: 'center' }}
            aria-label="Minute (UTC)"
          />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onCancel} style={{
            flex: 1, padding: '10px 0', borderRadius: 8, border: '1px solid #E2E8F0',
            background: '#fff', color: '#475569', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={handleSet} style={{
            flex: 1, padding: '10px 0', borderRadius: 8, border: 'none',
            background: '#14B8A6', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer',
          }}>Set</button>
        </div>
      </div>
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

export function SetSchedulePaymentModal({ open, onClose, walletAddress, sessionToken, onScheduled }: SetSchedulePaymentModalProps) {
  const { state } = useApp();
  const { employees, groups, payrollClone, tokenRegistry, payrollSetup } = state;
  const { agentInfo } = useAgentStatus();

  const [target, setTarget] = useState<string>(ALL_EMPLOYEES_LABEL);
  const [token, setToken]   = useState<'USDC' | 'EURC'>('USDC');
  const [when, setWhen]     = useState<Date>(() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(9, 0, 0, 0); return d; });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError]   = useState('');
  const [saving, setSaving] = useState(false);

  const targets = useMemo(
    () => employees.filter(e => target === ALL_EMPLOYEES_LABEL || e.group === target),
    [employees, target]
  );

  if (!open) return null;

  async function handleSchedule() {
    setError('');
    if (targets.length === 0) { setError('No employees match this target.'); return; }
    if (targets.some(e => !Number.isFinite(e.salaryAmount) || e.salaryAmount <= 0)) {
      setError('One or more employees are missing a valid salary amount.');
      return;
    }
    if (!agentInfo?.walletId || !agentInfo?.agentWallet) {
      setError('Activate the AI Agent before scheduling autonomous payments.');
      return;
    }
    if (when.getTime() <= Date.now()) { setError('Pick a date/time in the future.'); return; }

    setSaving(true);
    try {
      const tokenAddress = token === 'USDC' ? CONTRACTS.USDC : Object.values(tokenRegistry ?? {}).find(t => t.symbol === 'EURC')?.address;
      if (!tokenAddress) { setError('Token address not found.'); setSaving(false); return; }

      const schedule: AgentSchedule = {
        id: crypto.randomUUID(),
        walletAddress,
        type: 'scheduled',
        label: `${target} — ${targets.length} employee${targets.length === 1 ? '' : 's'} — ${token}`,
        group: target === ALL_EMPLOYEES_LABEL ? undefined : target,
        employees: targets.map(e => e.walletAddress),
        token,
        amount: targets.reduce((s, e) => s + e.salaryAmount, 0).toFixed(2),
        nextRunAt: when.getTime(),
        status: 'active',
        createdAt: Date.now(),
        runHistory: [],
        resolvedPayments: targets.map(e => ({ address: e.walletAddress, amount: String(e.salaryAmount) })),
        agentWalletId: agentInfo.walletId,
        agentWalletAddress: agentInfo.agentWallet,
        payrollCloneAddress: payrollClone ?? undefined,
        tokenAddress,
        tokenDecimals: 6,
        // Snapshotted now because payrollSetup is only ever decrypted
        // client-side — the server-side executor has no way to live-fetch
        // it later (see AgentSchedule.recipientEmail doc comment). Left
        // undefined (not empty string) when unset so downstream email
        // logic can do a plain truthiness check.
        recipientEmail: payrollSetup?.email || undefined,
      };

      await saveAgentSchedule(schedule);
      void syncScheduleToServer(walletAddress, schedule, sessionToken);

      onScheduled(schedule);
      onClose();
    } catch (err) {
      setError((err as Error).message ?? 'Could not create schedule.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', zIndex: 60,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}>
        <div style={{ background: '#fff', borderRadius: 16, padding: 24, width: 420, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: '#0F172A' }}>Set Schedule Payments</span>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8' }}><X size={18} /></button>
          </div>

          <label style={{ fontSize: 12, fontWeight: 600, color: '#475569' }}>Pay</label>
          <select value={target} onChange={e => setTarget(e.target.value)} style={{
            width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #E2E8F0',
            fontSize: 13, marginTop: 4, marginBottom: 14, background: '#fff',
          }}>
            <option value={ALL_EMPLOYEES_LABEL}>{ALL_EMPLOYEES_LABEL}</option>
            {groups.map(g => <option key={g} value={g}>{g}</option>)}
          </select>

          <label style={{ fontSize: 12, fontWeight: 600, color: '#475569' }}>Token</label>
          <select value={token} onChange={e => setToken(e.target.value as 'USDC' | 'EURC')} style={{
            width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #E2E8F0',
            fontSize: 13, marginTop: 4, marginBottom: 14, background: '#fff',
          }}>
            <option value="USDC">USDC</option>
            <option value="EURC" disabled>EURC — Soon</option>
          </select>

          <label style={{ fontSize: 12, fontWeight: 600, color: '#475569' }}>Date &amp; Time</label>
          <button onClick={() => setPickerOpen(true)} style={{
            width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #E2E8F0',
            fontSize: 13, marginTop: 4, marginBottom: 14, background: '#F8F9FA', textAlign: 'left',
            display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: '#0F172A',
          }}>
            <CalendarIcon size={14} color="#4F46E5" />
            {when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}
            {' at '}
            {String(when.getUTCHours()).padStart(2, '0')}:{String(when.getUTCMinutes()).padStart(2, '0')} UTC
          </button>

          <div style={{ fontSize: 12, color: '#64748B', marginBottom: 14 }}>
            {targets.length} employee{targets.length === 1 ? '' : 's'} · {targets.reduce((s, e) => s + (e.salaryAmount || 0), 0).toFixed(2)} {token} total
          </div>

          {error && <div style={{ fontSize: 12, color: '#DC2626', marginBottom: 12 }}>{error}</div>}

          <button
            onClick={handleSchedule}
            disabled={saving}
            style={{
              width: '100%', padding: '12px 0', borderRadius: 10, border: 'none',
              background: '#14B8A6', color: '#fff', fontSize: 14, fontWeight: 700,
              cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Scheduling…' : 'Schedule Payment'}
          </button>
        </div>
      </div>

      {pickerOpen && (
        <DateTimePicker
          initial={when}
          onCancel={() => setPickerOpen(false)}
          onSet={(d) => { setWhen(d); setPickerOpen(false); }}
        />
      )}
    </>
  );
}
