'use client';
/**
 * @file components/shared/SuccessCheck.tsx
 *
 * Shared "success" badge: a soft, pale-green circle behind a smaller solid
 * green circle with a white checkmark. Replaces the old box-shadow "halo"
 * version (solid circle + `boxShadow: '0 0 0 8px rgba(5,150,105,0.12)'`)
 * that was copy-pasted across send/swap/bridge/ExecutionModal with slightly
 * different sizes each time. One component now, used everywhere a flow
 * needs to say "this succeeded."
 */

import { Check } from 'lucide-react';

interface SuccessCheckProps {
  /** Diameter of the solid inner circle, in px. The pale outer ring scales with it. */
  size?: number;
  /** Set false to skip the pop-in animation (e.g. if the parent already animates). */
  animate?: boolean;
  className?: string;
}

export function SuccessCheck({ size = 64, animate = true, className }: SuccessCheckProps) {
  const ringSize = Math.round(size * 1.6);

  return (
    <div
      className={[animate ? 'success-check-ring' : '', className].filter(Boolean).join(' ')}
      style={{
        width: ringSize, height: ringSize, borderRadius: '50%',
        background: '#D1FAE5', // pale mint ring
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        margin: '0 auto',
      }}
    >
      <div style={{
        width: size, height: size, borderRadius: '50%',
        background: '#059669', // solid green
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Check size={Math.round(size * 0.5)} color="#fff" strokeWidth={3} />
      </div>
      {animate && (
        <style>{`
          .success-check-ring { animation: successCheckPop 0.35s cubic-bezier(0.34,1.56,0.64,1); }
          @keyframes successCheckPop {
            0%   { transform: scale(0.6); opacity: 0; }
            100% { transform: scale(1);   opacity: 1; }
          }
          @media (prefers-reduced-motion: reduce) {
            .success-check-ring { animation: none; }
          }
        `}</style>
      )}
    </div>
  );
}
