'use client';
/**
 * @file components/onramp/OnrampWidget.tsx
 *
 * Mounts Circle's hosted fiat-to-USDC widget (card, Apple Pay, Google
 * Pay, bank transfer) inline via App Kit's Onramp capability. Confirmed
 * directly against docs.arc.io/app-kit/onramp and the App Kit Onramp
 * quickstart, not guessed, see the session route's header comment for
 * why that distinction matters here specifically.
 *
 * WEBHOOK RECONCILIATION IS NOT WIRED UP YET. Circle's own docs are
 * explicit that onDepositSettled below is a "best-effort UX signal"
 * only, if the user closes the tab between submitting and settlement,
 * the browser never gets this event even though the deposit completes
 * server-side, a webhook receiver is the documented source of truth for
 * final state. Deliberately not built here, the exact webhook payload
 * shape and signature-verification scheme wasn't available in what
 * could be confirmed (the quickstart gestures at "set up a webhook
 * receiver" without the concrete spec). This onramp still works
 * end-to-end without it: this app's own on-chain deposit detector
 * (lib/walletActivity/detectDeposits.ts) independently picks up the
 * incoming USDC transfer once it lands, same as it does for a wallet
 * deposit, so the wallet balance is never wrong even without the
 * webhook, Circle's event here is purely to make the ALREADY recorded
 * "submitted" activity row update to "settled" promptly instead of
 * waiting on the next on-chain poll. Bring the real webhook spec and
 * this can be tightened.
 */

import { useEffect, useRef, useState } from 'react';
import { createOnrampKit, fetchOnrampSession } from '@circle-fin/onramp-kit';
import { recordOnrampDeposit } from '@/lib/walletActivity/onrampDeposits';

// Sandbox override for local dev only, see the session route's matching
// server-side ONRAMP_API_BASE_URL. Both must agree or mountIframe throws
// INPUT_WIDGET_URL_ORIGIN_MISMATCH per the docs. Unset in production.
const WIDGET_BASE_URL = process.env.NEXT_PUBLIC_ONRAMP_WIDGET_BASE_URL || undefined;

type DepositSettledPayload = { amount?: number; token?: string };
type OnrampWidgetProps = {
  walletAddress: string;
  onClose?: () => void;
};

type WidgetController = { close?: () => void };

export function OnrampWidget({ walletAddress, onClose }: OnrampWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<WidgetController | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (!containerRef.current) return;
      setStatus('loading');
      setErrorMessage(null);

      try {
        const onramp = createOnrampKit();
        const session = await fetchOnrampSession({
          url: '/api/onramp/sessions',
          body: { appUserId: walletAddress, destinationAddress: walletAddress },
          ...(WIDGET_BASE_URL ? { widgetBaseUrl: WIDGET_BASE_URL } : {}),
        });

        if (cancelled || !containerRef.current) return;

        const sessionId = (session as { id?: string }).id ?? crypto.randomUUID();

        widgetRef.current = onramp.mountIframe({
          session,
          container: containerRef.current,
          ...(WIDGET_BASE_URL ? { widgetBaseUrl: WIDGET_BASE_URL } : {}),
          onDepositSettled: (envelope) => {
            const payload = envelope.payload as unknown as DepositSettledPayload;
            void recordOnrampDeposit({
              walletAddress,
              sessionId,
              amount: payload?.amount ?? 0,
              token: payload?.token ?? 'USDC',
              status: 'settled',
            });
          },
          onDepositNotCompleted: () => {
            // User backed out or the deposit failed inside the widget,
            // nothing to record, the "submitted" row (if any) simply
            // never gets a matching settle, which is accurate.
          },
        }) as unknown as WidgetController;

        // Submitted as soon as the widget is up, matches the pattern
        // onrampDeposits.ts's header comment describes, updated to
        // 'settled' by onDepositSettled above when/if it fires.
        void recordOnrampDeposit({
          walletAddress, sessionId, amount: 0, token: 'USDC', status: 'submitted',
        });

        if (!cancelled) setStatus('ready');
      } catch (err) {
        console.error('Failed to start onramp:', err);
        if (!cancelled) {
          setStatus('error');
          setErrorMessage(
            err instanceof Error && /not configured/i.test(err.message)
              ? 'Fiat deposit is not available yet.'
              : 'Could not start a fiat deposit right now, please try again shortly.'
          );
        }
      }
    }

    void start();

    return () => {
      cancelled = true;
      widgetRef.current?.close?.();
      widgetRef.current = null;
    };
  }, [walletAddress]);

  return (
    <div>
      {status === 'error' && (
        <p style={{ fontSize: 14, color: '#B91C1C', marginBottom: 12 }}>
          {errorMessage}
        </p>
      )}
      {status === 'loading' && (
        <p style={{ fontSize: 13, color: '#64748B', marginBottom: 12 }}>
          Loading secure deposit form…
        </p>
      )}
      {/* Circle's iframe fills this container at 100%/100%, it collapses
         to 0px without an explicit non-zero height, per the hosting
         requirements doc, hence the fixed height rather than flex-grow. */}
      <div
        ref={containerRef}
        style={{
          width: '100%', height: 560, borderRadius: 12, overflow: 'hidden',
          background: status === 'loading' ? '#F8FAFC' : 'transparent',
        }}
      />
      {onClose && status === 'error' && (
        <button
          onClick={onClose}
          style={{
            marginTop: 12, width: '100%', padding: '10px 0', borderRadius: 10,
            border: '1px solid #E2E8F0', background: '#fff', color: '#334155',
            fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          Close
        </button>
      )}
    </div>
  );
}
