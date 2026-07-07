/**
 * @file lib/agent/useAgentSession.ts
 * CLIENT-SIDE.
 *
 * Manages the short-lived session token required by app/api/agent/chat
 * (see lib/agent/auth.ts on the server for the full flow). Tokens are
 * cached in sessionStorage (cleared when the tab closes — deliberately
 * not localStorage, since this is a bearer credential, even a short-lived
 * one) and re-signed automatically when missing or expired.
 *
 * SESSION_TTL_MS_CLIENT must stay <= the server's actual TTL
 * (lib/agent/auth.ts SESSION_TTL_MS, currently 15 minutes) — kept a
 * minute under it here so the client never tries to use a token the
 * server has already expired.
 */

import { useCallback, useRef } from 'react';
import type { WalletClient } from 'viem';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';
const SESSION_TTL_MS_CLIENT = 14 * 60 * 1000; // 1 min under the server's 15 min TTL

interface CachedSession { token: string; walletAddress: string; expiresAt: number }

function storageKey(walletAddress: string): string {
  return `salden_agent_session_${walletAddress.toLowerCase()}`;
}

function readCached(walletAddress: string): CachedSession | null {
  try {
    const raw = sessionStorage.getItem(storageKey(walletAddress));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedSession;
    if (parsed.expiresAt < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCached(session: CachedSession): void {
  try { sessionStorage.setItem(storageKey(session.walletAddress), JSON.stringify(session)); }
  catch { /* sessionStorage unavailable — caller will just re-sign next time */ }
}

function clearCached(walletAddress: string): void {
  try { sessionStorage.removeItem(storageKey(walletAddress)); } catch { /* ignore */ }
}

export function useAgentSession() {
  // Prevents two concurrent calls from both kicking off a sign request
  // (e.g. two tool calls firing in quick succession before either resolves).
  // Keyed per wallet address — a single shared ref would incorrectly hand
  // back wallet A's in-flight sign-in promise to a caller asking for wallet
  // B's token if the connected account changes mid-flow.
  const inFlight = useRef<Map<string, Promise<string>>>(new Map());

  const getToken = useCallback(async (
    walletAddress: string,
    walletClient: WalletClient,
    forceRefresh = false,
  ): Promise<string> => {
    const key = walletAddress.toLowerCase();

    if (!forceRefresh) {
      const cached = readCached(walletAddress);
      if (cached) return cached.token;
    }

    const existing = inFlight.current.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const startRes = await fetch(`${API_BASE}/agent/session`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletAddress }),
        });
        if (!startRes.ok) throw new Error('Could not start agent session.');
        const { message } = await startRes.json() as { message: string };

        const signature = await walletClient.signMessage({
          account: walletAddress as `0x${string}`,
          // Wallet will show the full message including:
          // "Sign in to the Salden AI Payroll Agent — proves wallet ownership, no payment authorised"
          message,
        });

        const verifyRes = await fetch(`${API_BASE}/agent/session`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletAddress, signature }),
        });
        if (!verifyRes.ok) {
          const body = await verifyRes.json().catch(() => ({})) as { error?: string };
          void body; // don't expose server detail to UI
          throw new Error('Sign-in failed. Please try again.');
        }
        const { token } = await verifyRes.json() as { token: string };

        writeCached({ token, walletAddress, expiresAt: Date.now() + SESSION_TTL_MS_CLIENT });
        return token;
      } finally {
        inFlight.current.delete(key);
      }
    })();

    inFlight.current.set(key, promise);
    return promise;
  }, []);

  const invalidate = useCallback((walletAddress: string) => {
    clearCached(walletAddress);
  }, []);

  return { getToken, invalidate };
}
