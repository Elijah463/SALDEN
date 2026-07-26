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
 *
 * BUG FIX — stale session after switching social-login accounts:
 *   This used to read localStorage exactly once, in a `useEffect(() => {...}, [])`
 *   with an empty dependency array. Logging out and back in with a DIFFERENT
 *   social/email account writes a new session to localStorage, but any
 *   component using this hook that was already mounted before the switch
 *   (e.g. a persistent layout/sidebar that survives Next.js's client-side
 *   route navigation — logout/login here both use router.push, not a full
 *   reload) never re-ran that effect, so it kept serving the FIRST account's
 *   address/email from memory indefinitely. Any on-chain write made through
 *   that stale hook instance — including Pricing's upgrade flow — was
 *   silently signed as the OLD account, which is exactly why "upgrade"
 *   could revert with AlreadyDeployed() for what looked like a brand-new
 *   account: it wasn't actually acting as the new account at all. External
 *   wallets never had this problem because useAccount() is wagmi's own
 *   live, event-driven state — it updates automatically.
 *
 *   Fix: every place that writes or clears `salden_session` now also
 *   dispatches a same-tab 'salden-session-changed' event (localStorage's
 *   native 'storage' event only fires in OTHER tabs, never the tab that
 *   made the change) via setStoredSession()/clearCircleSession() below.
 *   This hook listens for both and re-reads on every change, not just once.
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

const SESSION_KEY   = 'salden_session';
const SESSION_EVENT = 'salden-session-changed';

function readSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch { return null; }
}

export function useEffectiveAddress(): EffectiveSession {
  const { address: wagmiAddress, isConnected } = useAccount();
  const [circleSession, setCircleSession]      = useState<StoredSession | null>(null);
  const [mounted,       setMounted]            = useState(false);

  useEffect(() => {
    setMounted(true);
    const sync = () => {
      const parsed = readSession();
      setCircleSession(parsed?.walletAddress ? parsed : null);
    };
    sync();
    // 'storage' catches changes made in OTHER tabs; our own custom event
    // catches changes made in THIS tab (login/logout), which the native
    // storage event deliberately does not fire for.
    window.addEventListener('storage', sync);
    window.addEventListener(SESSION_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(SESSION_EVENT, sync);
    };
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

/** Writes a session to localStorage AND notifies every mounted
 *  useEffectiveAddress() instance in this tab immediately (the native
 *  'storage' event only reaches other tabs). Use this instead of calling
 *  localStorage.setItem('salden_session', ...) directly — a raw setItem
 *  silently leaves already-mounted components on the previous session. */
export function setStoredSession(session: StoredSession): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    window.dispatchEvent(new Event(SESSION_EVENT));
  } catch { /* ignore write errors */ }
}

/** Clear the Circle session from localStorage (call on logout) */
export function clearCircleSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
    window.dispatchEvent(new Event(SESSION_EVENT));
  } catch { /* ignore */ }
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
  return readSession();
}
