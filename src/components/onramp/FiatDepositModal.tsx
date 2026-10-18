'use client';
/**
 * @file components/onramp/FiatDepositModal.tsx
 * "Deposit fiat" modal, hosts the real OnrampWidget (card, Apple Pay,
 * Google Pay, bank transfer via Circle's hosted onramp).
 */
import { X } from 'lucide-react';
import { OnrampWidget } from './OnrampWidget';

export function FiatDepositModal({
  walletAddress,
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

        <OnrampWidget walletAddress={walletAddress} onClose={onClose} />
      </div>
    </div>
  );
}
