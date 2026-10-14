'use client';
/**
 * "Deposit fiat" modal. Fiat onramp is not live yet, so this shows a "coming soon"
 * notice. Props are unchanged so existing callers keep working.
 */
import { X } from 'lucide-react';

export function FiatDepositModal({
  onClose,
}: {
  walletAddress: string;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Deposit fiat"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15,23,42,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div style={{
        width: '100%', maxWidth: 480, background: '#fff',
        border: '1px solid #E2E8F0', borderRadius: 20, padding: 20,
        maxHeight: '92vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: '#0F172A' }}>Deposit fiat</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#64748B' }}
          >
            <X size={18} />
          </button>
        </div>

        <p style={{ fontSize: 14, color: '#475569' }}>
          Fiat deposits are coming soon. In the meantime, you can deposit USDC directly to your wallet address.
        </p>
      </div>
    </div>
  );
}
