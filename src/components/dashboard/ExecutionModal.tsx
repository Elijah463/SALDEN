'use client';
/**
 * @file components/dashboard/ExecutionModal.tsx
 * Shows during and after a payroll execution. ImportantUpdate #20.
 *
 * States:
 *   pending   → spinning Salden logo + status text
 *   success   → green checkmark + "Transaction Successful" + close X
 *   failed    → red X + "Transaction Failed" + error message + close X
 *
 * For large batches (>30 employees):
 *   Shows a progress bar: "Batch N of M" + percentage
 */

import { X, CheckCircle2, XCircle, ExternalLink } from 'lucide-react';
import { txLink } from '@/lib/contracts/config';

export interface ExecutionProgress {
  current: number;
  total:   number;
}

export type ExecutionState = 'idle' | 'pending' | 'success' | 'failed';

interface ExecutionModalProps {
  state:       ExecutionState;
  statusText:  string;
  progress?:   ExecutionProgress | null;
  txHash?:     string;
  error?:      string;
  onClose:     () => void;
}

export function ExecutionModal({ state, statusText, progress, txHash, error, onClose }: ExecutionModalProps) {
  if (state === 'idle') return null;

  const showClose = state === 'success' || state === 'failed';
  // pct is always a number when the progress bar is visible (guarded by progress.total > 30)
  // but we default to 0 to satisfy TypeScript's null check
  const pct = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(15, 23, 42, 0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
      backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        background: '#fff', borderRadius: 24,
        padding: '40px 36px',
        maxWidth: 380, width: '100%',
        textAlign: 'center',
        boxShadow: '0 24px 64px rgba(0,0,0,0.18)',
        position: 'relative',
      }}>
        {/* Close button — only appears after terminal state */}
        {showClose && (
          <button onClick={onClose} style={{
            position: 'absolute', top: 16, right: 16,
            background: '#F1F5F9', border: 'none', cursor: 'pointer',
            width: 32, height: 32, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <X size={16} color="#475569" />
          </button>
        )}

        {/* Icon area */}
        <div style={{ marginBottom: 20 }}>
          {state === 'pending' && (
            <div style={{
              width: 72, height: 72, margin: '0 auto',
              borderRadius: '50%',
              border: '4px solid #E2E8F0',
              borderTopColor: '#4F46E5',
              animation: 'exec-spin 0.9s linear infinite',
            }} />
          )}
          {state === 'success' && (
            <div style={{
              width: 72, height: 72, borderRadius: '50%',
              background: '#ECFDF5', border: '3px solid #6EE7B7',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto',
              animation: 'exec-pop 0.3s cubic-bezier(0.34,1.56,0.64,1)',
            }}>
              <CheckCircle2 size={38} color="#059669" />
            </div>
          )}
          {state === 'failed' && (
            <div style={{
              width: 72, height: 72, borderRadius: '50%',
              background: '#FEF2F2', border: '3px solid #FCA5A5',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto',
              animation: 'exec-pop 0.3s cubic-bezier(0.34,1.56,0.64,1)',
            }}>
              <XCircle size={38} color="#DC2626" />
            </div>
          )}
        </div>

        {/* Title */}
        <h3 style={{
          fontSize: 20, fontWeight: 800, marginBottom: 8,
          color: state === 'success' ? '#059669' : state === 'failed' ? '#DC2626' : '#0F172A',
        }}>
          {state === 'pending' ? 'Transaction Pending'
           : state === 'success' ? 'Transaction Successful'
           : 'Transaction Failed'}
        </h3>

        {/* Status text */}
        <p style={{ fontSize: 14, color: '#64748B', marginBottom: progress ? 20 : 0, lineHeight: 1.6 }}>
          {state === 'failed' && error ? error : statusText}
        </p>

        {/* Batch progress bar */}
        {state === 'pending' && progress && progress.total > 30 && (
          <div style={{ marginTop: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: '#64748B', fontWeight: 600 }}>
                Batch {progress.current} of {progress.total}
              </span>
              <span style={{ fontSize: 12, color: '#4F46E5', fontWeight: 700 }}>{pct}%</span>
            </div>
            <div style={{ height: 8, background: '#E2E8F0', borderRadius: 99, overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                width: `${pct}%`,
                background: 'linear-gradient(90deg, #4F46E5, #14B8A6)',
                borderRadius: 99,
                transition: 'width 0.4s ease',
              }} />
            </div>
            <p style={{ fontSize: 11, color: '#94A3B8', marginTop: 8 }}>
              Large payroll batched automatically. Do not close this window.
            </p>
          </div>
        )}

        {/* Tx hash on success */}
        {state === 'success' && txHash && (
          <a href={txLink(txHash)} target="_blank" rel="noreferrer"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              marginTop: 16, fontSize: 13, color: '#4F46E5',
              fontFamily: "'JetBrains Mono', monospace",
              textDecoration: 'none',
            }}>
            {txHash.slice(0, 10)}…{txHash.slice(-6)} <ExternalLink size={13} />
          </a>
        )}
      </div>

      <style>{`
        @keyframes exec-spin { to { transform: rotate(360deg); } }
        @keyframes exec-pop  { from { transform: scale(0.5); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      `}</style>
    </div>
  );
}
