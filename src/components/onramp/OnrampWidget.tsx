'use client';
/**
 * Mounts Circle's hosted fiat-to-USDC widget. The widget handles card, Apple Pay,
 * Google Pay and bank transfer, and KYC. We never see card data or personal details.
 *
 * Settlement is reported by Circle's events, which are best-effort. The authoritative
 * balance comes from the wallet's on-chain balance, which the wallet page already reads.
 */
import { useEffect, useRef, useState } from 'react';
import { createOnrampKit, type OnrampDepositInfo, type OnrampSession } from '@circle-fin/onramp-kit';
import { recordOnrampDeposit } from '@/lib/walletActivity/onrampDeposits';

const WIDGET_URL = process.env.NEXT_PUBLIC_ONRAMP_WIDGET_URL ?? 'https://onramp.arc.io';

/** Codes that mean the session itself is no longer usable, so a fresh one should be minted. */
const RETRYABLE_NOT_COMPLETED = new Set(['SESSION_TIMEOUT']);

export function OnrampWidget({
  session,
  onComplete,
  onClose,
  onNeedsNewSession,
}: {
  session: OnrampSession;
  onComplete: (amount: number, info: OnrampDepositInfo) => void;
  onClose: () => void;
  /** Called when the current session expired or failed to start. The parent mints a fresh one. */
  onNeedsNewSession: (reason: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  // Latest callbacks in a ref, so a parent re-render never remounts the widget
  // (a remount would reset the user's progress).
  const cb = useRef({ onComplete, onClose, onNeedsNewSession });
  useEffect(() => { cb.current = { onComplete, onClose, onNeedsNewSession }; });

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const kit = createOnrampKit({ widgetBaseUrl: WIDGET_URL });
    let credited = false;

    // DEPOSIT_SUBMITTED and DEPOSIT_SETTLED can both fire for one deposit; count it once.
    const amountOf = (info: OnrampDepositInfo) => (typeof info.amount === 'number' ? info.amount : 0);
    const tokenOf = (info: OnrampDepositInfo) => (info.tokenSymbol || 'USDC');
    const record = (info: OnrampDepositInfo, status: 'submitted' | 'settled') =>
      recordOnrampDeposit({
        walletAddress: session.destinationWallet,
        sessionId: session.sessionId,
        amount: amountOf(info),
        token: tokenOf(info),
        status,
      }).catch(() => { /* activity is a record of what happened; the widget flow itself is unaffected */ });

    const credit = (info: OnrampDepositInfo) => {
      if (credited) return;
      credited = true;
      void record(info, 'submitted');
      cb.current.onComplete(amountOf(info), info);
    };

    const widget = kit.mountIframe({
      session,
      container,
      title: 'Add cash',
      onInitializationSuccess: () => setReady(true),
      // Initialisation failed (page did not load or the token was rejected): re-mint.
      onInitializationError: (e) => cb.current.onNeedsNewSession(e?.code ?? 'INITIALIZATION_ERROR'),
      // Token expired or invalid mid-flow: re-mint.
      onSessionExpired: () => cb.current.onNeedsNewSession('SESSION_EXPIRED'),
      onDepositSubmitted: (e) => credit(e.payload),
      onDepositSettled: (e) => {
        void record(e.payload, 'settled');
        credit(e.payload);
      },
      onDepositNotCompleted: (e) => {
        const code = (e as { payload?: { code?: string } }).payload?.code ?? '';
        if (RETRYABLE_NOT_COMPLETED.has(code)) cb.current.onNeedsNewSession(code);
        else cb.current.onClose(); // cancelled, rejected, or provider error: re-minting would not help
      },
    });

    return () => widget.close();
  }, [session]);

  return (
    <div ref={containerRef} style={{ width: '100%', minHeight: 560, position: 'relative' }}>
      {!ready && (
        <div style={{ fontSize: 14, color: '#64748B', textAlign: 'center', paddingTop: 40 }}>
          Loading…
        </div>
      )}
    </div>
  );
}
