'use client';
/**
 * @file components/shared/Toasts.tsx
 * Global toast notification renderer. Reads from AppContext.
 * Renders in a fixed stack at the bottom-right of the viewport.
 */

import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { useApp } from '@/context/AppContext';

const ICONS = {
  success: <CheckCircle2 size={16} color="#059669" />,
  error:   <XCircle      size={16} color="#DC2626" />,
  warning: <AlertTriangle size={16} color="#D97706" />,
  info:    <Info          size={16} color="#4F46E5" />,
};

const BORDERS = {
  success: '#A7F3D0',
  error:   '#FCA5A5',
  warning: '#FDE68A',
  info:    '#C7D2FE',
};

export function Toasts() {
  const { state, removeToast } = useApp();
  const { toasts } = state;

  if (!toasts.length) return null;

  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24,
      zIndex: 10000, display: 'flex', flexDirection: 'column', gap: 8,
      maxWidth: 380, width: '100%',
    }}>
      {toasts.map(toast => (
        <div key={toast.id} style={{
          background: '#fff',
          border:      `1px solid ${BORDERS[toast.type]}`,
          borderRadius: 12,
          padding: '12px 14px',
          display: 'flex', alignItems: 'flex-start', gap: 10,
          boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
          animation: 'slideUp 0.2s ease',
        }}>
          <div style={{ flexShrink: 0, marginTop: 1 }}>{ICONS[toast.type]}</div>
          <p style={{ flex: 1, fontSize: 13, color: '#0F172A', margin: 0, lineHeight: 1.5 }}>
            {toast.message}
          </p>
          <button
            onClick={() => removeToast(toast.id)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: '#94A3B8', flexShrink: 0, padding: 0,
              display: 'flex', alignItems: 'center',
            }}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
