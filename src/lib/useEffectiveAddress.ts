'use client';
/**
 * @file lib/useEffectiveAddress.ts
 * Resolves the active wallet address regardless of login method.
 *
 * External wallet (wagmi/RainbowKit) → useAccount().address
 * Social login (Circle UCW / email OTP) → walletAddress from localStorage
 *
 * Hydration safety:
 *   During SSR and the first client render, `mounted` is false and we return
 *   `isConnected: false` with `address: undefined`. This prevents a flash where
 *   the app thinks no one is logged in and redirects — it simply waits until
 *   the useEffect has read localStorage before making auth decisions.
 *   Callers that gate navigation on `isConnected` should also gate on `mounted`.
 */

import { useState, useEffect } from 'react';
import { useAccount } from 'wagmi';

export interface EffectiveSession {
  address:     `0x${string}` | undefined;
  isConnected: boolean;
  /** false until localStorage has been read — use this to suppress auth redirects */
  mounted:     boolean;
  loginMethod: 'external' | 'circle' | null;
  email?:      string;
}

export interface StoredSession {
  email?:         string;
  walletAddress?: string;
  loginMethod?:   string;
  createdAt?:     number;
}

export function useEffectiveAddress(): EffectiveSession {
  const { address: wagmiAddress, isConnected } = useAccount();
  const [circleSession, setCircleSession]      = useState<StoredSession | null>(null);
  const [mounted,       setMounted]            = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      const raw = localStorage.getItem('salden_session');
      if (raw) {
        const parsed = JSON.parse(raw) as StoredSession;
        if (parsed?.walletAddress) setCircleSession(parsed);
      }
    } catch { /* localStorage blocked in some envs */ }
  }, []);

  // Always return mounted so callers can defer auth decisions
  const base = { mounted };

  if (!mounted) {
    // Suppress flash: don't claim logged-out until we've checked localStorage
    return { ...base, address: undefined, isConnected: false, loginMethod: null };
  }

  // External wallet takes priority
  if (isConnected && wagmiAddress) {
    return { ...base, address: wagmiAddress, isConnected: true, loginMethod: 'external' };
  }

  // Circle/social session
  if (circleSession?.walletAddress) {
    return {
      ...base,
      address:     circleSession.walletAddress as `0x${string}`,
      isConnected: true,
      loginMethod: 'circle',
      email:       circleSession.email,
    };
  }

  return { ...base, address: undefined, isConnected: false, loginMethod: null };
}

/** Clear the Circle session from localStorage (call on logout) */
export function clearCircleSession(): void {
  try { localStorage.removeItem('salden_session'); } catch { /* ignore */ }
}

/**
 * Most on-chain WRITE flows now route through lib/circle/useUniversalWrite,
 * which signs through Circle's own challenge/PIN flow for social-login
 * users instead of wagmi. This message is now mainly seen for the flows
 * that still can't: Swap (needs a standard EIP-1193 provider Circle's
 * social-login sessions don't expose — see app/wallet/swap/page.tsx) and
 * any flow that needs a raw message signature rather than a contract
 * call (e.g. the IPFS employee-data sync's encryption-key derivation),
 * which would need a separate SIGN_MESSAGE challenge type, not yet built.
 */
export function walletRequiredMessage(loginMethod: EffectiveSession['loginMethod']): string {
  if (loginMethod === 'circle') {
    return 'Your Salden account wallet can\u2019t sign this particular action yet \u2014 please connect an external wallet (MetaMask, Rabby, etc.) to continue.';
  }
  return 'Connect your wallet first.';
}

/** Read stored session synchronously (for non-hook contexts) */
export function getStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem('salden_session');
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch { return null; }
}
