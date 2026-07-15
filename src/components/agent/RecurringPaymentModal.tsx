'use client';
/**
 * @file components/agent/RecurringPaymentModal.tsx
 * Deliberately kept separate from the schedules list/manage page and from
 * SetSchedulePaymentModal — this is the "Recurring" toggle's modal, letting
 * the user pick Weekly/Bi-weekly/Monthly for an existing scheduled payment.
 * The schedule keeps its already-set date/time as the first occurrence;
 * subsequent runs are computed by the cron executor after each run
 * (lib/agent/scheduleStore.ts's computeNextRun).
 */

import { useState } from 'react';
import { X, Repeat } from 'lucide-react';
import { saveAgentSchedule, type AgentSchedule } from '@/lib/db/indexeddb';

export type RecurrenceOption = 'weekly' | 'biweekly' | 'monthly';

interface RecurringPaymentModalProps {
  open: boolean;
  schedule: AgentSchedule;
  onClose: () => void;
  onUpdated: (schedule: AgentSchedule) => void;
  /** Best-effort push to the server's in-memory schedule store — see
   *  scheduleStore.ts for why this is a heartbeat, not a hard requirement. */
  syncToServer: (schedule: AgentSchedule) => void;
}

const OPTIONS: Array<{ value: RecurrenceOption; label: string; hint: string }> = [
  { value: 'weekly',   label: 'Weekly',    hint: 'Repeats every 7 days from the scheduled date.' },
  { value: 'biweekly', label: 'Bi-weekly', hint: 'Repeats every 14 days from the scheduled date.' },
  { value: 'monthly',  label: 'Monthly',   hint: 'Repeats every month on the same date.' },
];

export function RecurringPaymentModal({ open, schedule, onClose, onUpdated, syncToServer }: RecurringPaymentModalProps) {
  const [selected, setSelected] = useState<RecurrenceOption>(schedule.recurrence ?? 'monthly');
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  async function handleConfirm() {
    setSaving(true);
    try {
      const updated: AgentSchedule = { ...schedule, type: 'recurring', recurrence: selected, status: 'active' };
      await saveAgentSchedule(updated);
      syncToServer(updated);
      onUpdated(updated);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', zIndex: 65,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 24, width: 360, maxWidth: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Repeat size={16} color="#4F46E5" />
            <span style={{ fontSize: 15, fontWeight: 800, color: '#0F172A' }}>Make Recurring</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8' }}><X size={16} /></button>
        </div>
        <div style={{ fontSize: 12, color: '#64748B', marginBottom: 16 }}>{schedule.label}</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
          {OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setSelected(opt.value)}
              style={{
                textAlign: 'left', padding: '12px 14px', borderRadius: 10,
                border: selected === opt.value ? '2px solid #14B8A6' : '1px solid #E2E8F0',
                background: selected === opt.value ? '#F0FDFA' : '#fff', cursor: 'pointer',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{opt.label}</div>
              <div style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>{opt.hint}</div>
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{
            flex: 1, padding: '10px 0', borderRadius: 8, border: '1px solid #E2E8F0',
            background: '#fff', color: '#475569', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={handleConfirm} disabled={saving} style={{
            flex: 1, padding: '10px 0', borderRadius: 8, border: 'none',
            background: '#14B8A6', color: '#fff', fontSize: 13, fontWeight: 700,
            cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1,
          }}>
            {saving ? 'Saving…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
