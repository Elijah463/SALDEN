'use client';
/**
 * @file lib/useAgentStatus.ts
 *
 * React hook for checking + activating the AI Agent.
 *
 * Key fixes applied vs Fred's original:
 *   1. Uses useEffectiveAddress instead of useAccount — works for Circle social login.
 *   2. Persists walletId in localStorage so status survives page reloads.
 *   3. Sends walletId with every status request — lets the backend verify
 *      against Circle without server-side state.
 *   4. Body/response fields aligned with the actual activate API route.
 *
 * Backend contract:
 *   GET  /api/agent/status?wallet=0x...&walletId=<id>
 *     → { active: true,  agentWallet: string, walletId: string }
 *     → { active: false }
 *
 *   POST /api/agent/activate
 *     body: { walletAddress: string, action: "activate", existingWalletId?: string }
 *     → { active: true, agentAddress: string, walletId: string, message: string }
 */

import { useState, useEffect, useCallback } from 'react';
import { useEffectiveAddress }               from '@/lib/useEffectiveAddress';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

// ── localStorage key for persisting the agent walletId ────────────────────────
const agentKey = (addr: string) =>
  `salden_agent_walletId_${addr.toLowerCase()}`;

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentStatus = 'loading' | 'none' | 'active' | 'error';

export interface AgentInfo {
  agentWallet:  string;   // Circle developer-controlled wallet address
  walletId:     string;   // Circle internal wallet ID (persisted in localStorage)
}

export interface GrantRoleInstructions {
  payrollClone:  string;
  registryClone: string;
  agentWallet:   string;
  message:       string;
}

export interface ActivateResult {
  agentInfo:             AgentInfo;
  grantRoleInstructions: GrantRoleInstructions;
}

export interface AgentStatusResult {
  status:     AgentStatus;
  agentInfo:  AgentInfo | null;
  error:      string | null;
  activate:   () => Promise<ActivateResult | null>;
  refresh:    () => void;
  activating: boolean;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useAgentStatus(): AgentStatusResult {
  const { address, isConnected, mounted } = useEffectiveAddress();

  const [status,     setStatus]     = useState<AgentStatus>('loading');
  const [agentInfo,  setAgentInfo]  = useState<AgentInfo | null>(null);
  const [error,      setError]      = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [tick,       setTick]       = useState(0);

  const refresh = useCallback(() => setTick(t => t + 1), []);

  // ── Check status on mount + address change ────────────────────────────────
  useEffect(() => {
    // Wait for localStorage to be read before making auth decisions
    if (!mounted) return;

    if (!isConnected || !address) {
      setStatus('none');
      setAgentInfo(null);
      return;
    }

    let cancelled = false;
    setStatus('loading');
    setError(null);

    // Read stored walletId — lets backend verify without server state
    let storedWalletId: string | null = null;
    try {
      storedWalletId = localStorage.getItem(agentKey(address));
    } catch { /* ignore */ }

    const params = new URLSearchParams({ wallet: address });
    if (storedWalletId) params.set('walletId', storedWalletId);

    fetch(`${API_BASE}/agent/status?${params}`)
      .then(res => {
        if (!res.ok) throw new Error(`Status API returned ${res.status}`);
        return res.json() as Promise<{
          active:       boolean;
          agentWallet?: string;
          walletId?:    string;
        }>;
      })
      .then(data => {
        if (cancelled) return;
        if (data.active && data.agentWallet && data.walletId) {
          setStatus('active');
          setAgentInfo({ agentWallet: data.agentWallet, walletId: data.walletId });
        } else {
          setStatus('none');
          setAgentInfo(null);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Failed to check agent status.');
      });

    return () => { cancelled = true; };
  }, [address, isConnected, mounted, tick]);

  // ── Activate ──────────────────────────────────────────────────────────────
  const activate = useCallback(async (): Promise<ActivateResult | null> => {
    if (!address) return null;
    setActivating(true);
    setError(null);

    try {
      // Read existing walletId if available (lets backend skip re-creation)
      let existingWalletId: string | null = null;
      try { existingWalletId = localStorage.getItem(agentKey(address)); } catch { /* ignore */ }

      const res = await fetch(`${API_BASE}/agent/activate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress:    address,
          action:           'activate',
          existingWalletId: existingWalletId ?? undefined,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' })) as
          { error?: string };
        throw new Error(body.error ?? `Activation failed (${res.status})`);
      }

      const data = await res.json() as {
        active:       boolean;
        agentAddress: string;   // the route returns agentAddress
        walletId:     string;
        message:      string;
      };

      // Persist walletId so status survives page reloads
      try { localStorage.setItem(agentKey(address), data.walletId); } catch { /* ignore */ }

      const info: AgentInfo = {
        agentWallet: data.agentAddress,
        walletId:    data.walletId,
      };

      setStatus('active');
      setAgentInfo(info);

      return {
        agentInfo: info,
        grantRoleInstructions: {
          payrollClone:  '',   // populated by the caller (see ai-agent/page.tsx's auto-trigger effect)
          registryClone: '',
          agentWallet:   data.agentAddress,
          message:       data.message,
        },
      };
    } catch (err: unknown) {
      setStatus('error');
      const msg = err instanceof Error ? err.message : 'Activation failed.';
      setError(msg);
      return null;
    } finally {
      setActivating(false);
    }
  }, [address]);

  return { status, agentInfo, error, activate, refresh, activating };
}
