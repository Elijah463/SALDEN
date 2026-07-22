'use client';

import { useCallback } from 'react';
import { useUniversalWrite } from './useUniversalWrite';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { useSignatureExplainer } from '@/context/SignatureExplainerContext';

/**
 * @file lib/circle/useCachedSignMessage.ts
 *
 * A wallet's signature over a fixed message string is deterministic
 * (standard ECDSA signing) — the same wallet signing the same message
 * always produces the exact same signature. Salden relies on this to
 * derive a per-wallet encryption key for IPFS-synced payroll data (see
 * context/AppContext.tsx's ENCRYPTION_KEY_MESSAGE / getEncryptionKey).
 *
 * Because it's deterministic, the wallet only ever needs to be prompted
 * for that signature ONCE per browser tab session — every other place in
 * the app that needs it can safely reuse the cached result instead of
 * prompting again. Without this, "add an employee" (or save a group, or
 * finish onboarding) would mean two prompts every time: one for this
 * signature, one for the actual on-chain transaction that follows it.
 * With it, it's one prompt the first time or a session, and just the
 * (unavoidable — it's a real transaction) on-chain confirmation after
 * that.
 *
 * This applies identically to an external wallet (wagmi's signature
 * popup) and Circle social login (the SIGN_MESSAGE PIN challenge) — both
 * go through useUniversalWrite's signMessage underneath.
 *
 * Cached in sessionStorage (not localStorage) so it's automatically
 * cleared when the tab closes, never persisted across sessions or to
 * disk long-term.
 */
export function useCachedSignMessage() {
  const { signMessage: universalSignMessage, canWrite } = useUniversalWrite();
  const { address, loginMethod } = useEffectiveAddress();
  const { requestConfirmation } = useSignatureExplainer();

  const sign = useCallback(async (msg: string): Promise<string> => {
    if (!canWrite || !address) throw new Error('No wallet');

    const storageKey = `salden_sig::${address.toLowerCase()}::${btoa(msg).slice(0, 32)}`;

    try {
      const cached = sessionStorage.getItem(storageKey);
      if (cached) return cached;
    } catch { /* sessionStorage blocked (private browsing edge cases) */ }

    // Not cached — about to prompt for a real signature. For an external
    // wallet, show Salden's own explainer first (see
    // context/SignatureExplainerContext.tsx) — the wallet's own popup only
    // renders plain text, so this is where the full explanation lives.
    // Circle/social-login sessions skip this: Circle's PIN challenge modal
    // already explains itself in its own UI.
    if (loginMethod === 'external') {
      const confirmed = await requestConfirmation();
      if (!confirmed) throw new Error('Signature cancelled.');
    }

    const sig = await universalSignMessage(msg);

    try { sessionStorage.setItem(storageKey, sig); } catch { /* ignore write errors */ }

    return sig;
  }, [canWrite, universalSignMessage, address, loginMethod, requestConfirmation]);

  return sign;
}
