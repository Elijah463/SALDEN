'use client';
/**
 * @file context/SignatureExplainerContext.tsx
 *
 * Shows a one-time, Salden-branded explainer before an external wallet's
 * native signature popup, for the encryption-key-derivation signature
 * specifically (see lib/circle/useCachedSignMessage.ts). The wallet's own
 * popup only renders plain text — this lets the actual explanation be
 * properly structured (headings, sections) instead of a couple of
 * sentences crammed into what the wallet displays.
 *
 * IMPORTANT: this modal is purely informational. It does NOT change, wrap,
 * or otherwise alter the message that gets signed — ENCRYPTION_KEY_MESSAGE
 * in AppContext.tsx is untouched. Every wallet signing the same fixed
 * message reproduces the same signature (and therefore the same derived
 * encryption key) forever; changing that message would silently rotate
 * every existing user's key and lock them out of their own
 * already-encrypted data. This modal only decides *whether and when* to
 * ask the wallet to sign — never *what* it signs.
 *
 * Circle/social-login users don't see this — Circle's own PIN challenge
 * modal already explains itself in Circle's UI, and stacking a second
 * explainer in front of it would just be redundant.
 */

import { createContext, useContext, useCallback, useRef, useState, type ReactNode } from 'react';
import { Modal } from '@/components/shared/Modal';
import { Button } from '@/components/shared/Button';

interface SignatureExplainerContextValue {
  /** Shows the explainer once; resolves true if the user continues, false
   *  if they cancel/close it. Safe to call repeatedly — each call awaits
   *  its own answer. useCachedSignMessage only ever calls this the one
   *  time per session it actually needs a fresh signature (its own cache
   *  handles not re-prompting after that). */
  requestConfirmation: () => Promise<boolean>;
}

const SignatureExplainerContext = createContext<SignatureExplainerContextValue | null>(null);

function ExplainerSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div>
      <p style={{
        fontSize: 11, fontWeight: 700, color: '#4F46E5', textTransform: 'uppercase',
        letterSpacing: 0.6, margin: '0 0 4px',
      }}>
        {heading}
      </p>
      <p style={{ fontSize: 14, color: '#334155', margin: 0, lineHeight: 1.6 }}>
        {children}
      </p>
    </div>
  );
}

export function SignatureExplainerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);

  const requestConfirmation = useCallback((): Promise<boolean> => {
    return new Promise(resolve => {
      resolverRef.current = resolve;
      setOpen(true);
    });
  }, []);

  const settle = (confirmed: boolean) => {
    setOpen(false);
    resolverRef.current?.(confirmed);
    resolverRef.current = null;
  };

  return (
    <SignatureExplainerContext.Provider value={{ requestConfirmation }}>
      {children}
      {open && (
        <Modal open onClose={() => settle(false)} title="Signature request" maxWidth={440}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <ExplainerSection heading="What you're signing">
              A fixed message used only to derive a private encryption key for your payroll
              data. This is <strong>not a blockchain transaction</strong> — no gas is spent,
              nothing is broadcast to any network, and no funds move.
            </ExplainerSection>
            <ExplainerSection heading="Why Salden needs this">
              Your employee records are encrypted before they ever leave your device. Signing
              this message produces the same encryption key every time, from your wallet alone
              — so your data can be unlocked from any device you sign in on, without Salden
              ever storing the key itself.
            </ExplainerSection>
            <ExplainerSection heading="Where this goes">
              Nowhere. This signature stays on your device and is used only to compute the key
              — it's never sent to Salden's servers, IPFS, or anyone else.
            </ExplainerSection>
            <p style={{ fontSize: 12, color: '#94A3B8', margin: 0 }}>
              You'll only see this once per browser session — Salden won't ask again until you
              close this tab.
            </p>
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <Button variant="ghost" onClick={() => settle(false)} style={{ flex: 1 }}>Cancel</Button>
              <Button variant="brand" onClick={() => settle(true)} style={{ flex: 1 }}>Continue to wallet</Button>
            </div>
          </div>
        </Modal>
      )}
    </SignatureExplainerContext.Provider>
  );
}

export function useSignatureExplainer(): SignatureExplainerContextValue {
  const ctx = useContext(SignatureExplainerContext);
  if (!ctx) throw new Error('useSignatureExplainer must be used within SignatureExplainerProvider');
  return ctx;
}
