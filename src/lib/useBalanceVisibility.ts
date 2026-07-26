'use client';
/**
 * @file lib/useBalanceVisibility.ts
 *
 * Shared "hide my balance" preference for hero-card eye icons (Dashboard,
 * Wallet, Agent Wallet). Previously each page kept this as plain local
 * `useState` with no persistence — so it reset to that page's own hardcoded
 * default on every navigation/reload instead of remembering what the user
 * last chose. Worse, the three pages didn't even agree with each other on
 * what that default should be (Dashboard defaulted to hidden, Wallet to
 * visible), so the toggle felt random depending which page you landed on.
 *
 * Fix: one shared preference, backed by localStorage, so the user's last
 * choice survives reloads and is consistent everywhere. If nothing has
 * been chosen yet (first visit, or storage unavailable), it defaults to
 * VISIBLE — the safer, more useful default for a balance the user hasn't
 * explicitly asked to hide.
 *
 * SSR-safety: the initial render (server + first client paint) always
 * returns `true` so hydration matches; the real stored preference (if any)
 * is applied a moment later in an effect, same pattern as any other
 * client-only-persisted UI preference in a Next.js app.
 */

import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'salden:balance-visible';

export function useBalanceVisibility(): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const [visible, setVisibleState] = useState(true);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored !== null) setVisibleState(stored === 'true');
    } catch {
      // localStorage unavailable (private browsing, etc.) — silently keep default
    }
  }, []);

  const setVisible = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setVisibleState(prev => {
      const resolved = typeof next === 'function' ? (next as (p: boolean) => boolean)(prev) : next;
      try { window.localStorage.setItem(STORAGE_KEY, String(resolved)); } catch { /* ignore */ }
      return resolved;
    });
  }, []);

  return [visible, setVisible];
}
