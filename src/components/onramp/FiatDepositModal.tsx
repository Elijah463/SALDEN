'use client';
/**
 * "Deposit fiat" flow. Mints a session when opened (so its short expiry starts late),
 * then mounts Circle's hosted widget. Mint requests carry a signed session token for
 * this wallet; the server rejects any other destination.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { OnrampSession } from '@circle-fin/onramp-kit';
import { OnrampWidget } from './OnrampWidget';
import { useAgentSession } from '@/lib/agent/useAgentSession';
import { useUniversalWrite } from '@/lib/circle/useUniversalWrite';

export function FiatDepositModal({
  walletAddress,
  onClose,
}: {
  walletAddress: string;
  onClose: () => void;
}) {
  const { getToken } = useAgentSession();
  const { signMessage } = useUniversalWrite();
  const [session, setSession] = useState<OnrampSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  // Re-mints per open. Capped so a session that keeps failing cannot loop forever.
  const retries = useRef(0);
  const MAX_RETRIES = 2;

  const mint = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const token = await getToken(walletAddress, signMessage);
      if (!token) throw new Error('No session');
      const res = await fetch('/api/onramp/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ appUserId: walletAddress, destinationAddress: walletAddress }),
      });
      if (!res.ok) throw new Error(`Session request failed (${res.status})`);
      const data = (await res.json()) as OnrampSession;
      setSession(data);
    } catch {
      setSession(null);
      setError('Could not start fiat deposit. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [getToken, signMessage, walletAddress]);

  // Mint when the modal opens (so the short expiry starts late).
  useEffect(() => { void mint(); }, [mint]);

  // The widget reports an expired, rejected, or failed session. Re-mint while we have
  // retries left; otherwise show the error and let the user try again.
  const onNeedsNewSession = useCallback(() => {
    if (retries.current >= MAX_RETRIES) {
      setSession(null);
      setError('This deposit session could not be restored. Please close and try again.');
      return;
    }
    retries.current += 1;
    setSession(null); // unmounts the old widget before the new one mounts
    void mint();
  }, [mint]);

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

        {loading && <p style={{ fontSize: 14, color: '#64748B' }}>Preparing secure deposit…</p>}
        {!loading && error && <p style={{ fontSize: 14, color: '#DC2626' }}>{error}</p>}

        {!loading && !error && session && !submitted && (
          <OnrampWidget
            session={session}
            onComplete={() => setSubmitted(true)}
            onClose={onClose}
            onNeedsNewSession={onNeedsNewSession}
          />
        )}

        {submitted && (
          <p style={{ fontSize: 14, color: '#475569' }}>
            Deposit submitted. Your balance will update once it settles on Arc Network.
          </p>
        )}
      </div>
    </div>
  );
}
