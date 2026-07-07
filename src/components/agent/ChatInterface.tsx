'use client';
/**
 * @file components/agent/ChatInterface.tsx
 *
 * Full chat interface for the Salden AI Payroll Agent.
 *
 * REWRITTEN for the function-calling chat route (no more SSE / regex
 * markers). Key changes from the previous version:
 *
 *   - Single fetch + json() per turn — the route no longer streams, since
 *     the function-calling loop is inherently multi-round and non-streaming
 *     server-side. Trade-off: no token-by-token typing effect anymore;
 *     gained: tool calls can't be corrupted by truncation mid-marker.
 *   - Session auth — every request now carries a signed bearer token via
 *     useAgentSession(), obtained by signing a one-time message with the
 *     connected wallet. Requires a WalletClient.
 *   - `actionLog` is now a real array returned by the server, generated
 *     from tool calls actually executed — not parsed from model text.
 *   - `events` is an array of structured proposals (faucet, unlisted
 *     payment, add employee, payroll run) — rendered as real confirmation
 *     cards, each with its own expiry and idempotency guard.
 *   - `rateLimited` and `truncated` flags surfaced from the server.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useWalletClient } from 'wagmi';
import { useApp }    from '@/context/AppContext';
import ChatMessage   from '@/components/agent/ChatMessage';
import { useAgentSession } from '@/lib/agent/useAgentSession';
import { generateSessionId, loadSessionMessages, saveSession } from '@/lib/chatSessions';
import { txLink } from '@/lib/contracts/config';
import {
  UnlistedPaymentCard, AddEmployeeCard, PayrollRunCard,
  EditEmployeeCard, RemoveEmployeeCard, BulkAddEmployeesCard,
} from '@/components/agent/AgentConfirmationCards';

interface ActionLogEntry {
  action:    string;
  status:    'SUCCESS' | 'FAILED' | 'QUEUED';
  detail?:   string;
  timestamp: string;
}

interface AgentEvent {
  type: 'faucet_request' | 'unlisted_payment_request' | 'add_employee_request' | 'payroll_run_request'
      | 'agent_executed_payment' | 'agent_executed_payroll_run'
      | 'edit_employee_request' | 'edit_employee_immediate' | 'remove_employee_request'
      | 'bulk_add_employees_request' | 'bulk_add_employees_immediate';
  address?: string; amount?: string; token?: string;
  fullName?: string; department?: string; group?: string; salary?: string;
  txHash?: string; pending?: boolean; recipients?: number; totalAmount?: string;
  currentAddress?: string; newAddress?: string;
  employeesJson?: string; skippedCount?: number;
}

interface Message {
  id:        string;
  role:      'user' | 'assistant';
  content:   string;
  timestamp: string;
  actionLog?: ActionLogEntry[];
  events?:    AgentEvent[];
  eventsResolved?: boolean[];  // tracks which event cards have been actioned, by index
  truncated?: boolean;
  proposedAt: number;          // for card expiry
}

interface ChatInterfaceProps {
  walletAddress:  string;
  onDataChanged?: () => void;
  /** Real agent wallet address and active status from useAgentStatus() in the
   *  parent page — previously this component hardcoded agentActive: true and
   *  agentAddress: undefined, which meant the AI was always told the agent was
   *  "active" with no wallet, and get_balance/request_faucet for the agent
   *  wallet could never resolve a target address. */
  agentAddress?:  string;
  agentActive?:   boolean;
  /** Circle wallet ID for the agent — required for autonomous execution
   *  (execute_payment/execute_payroll_run) since Circle's contract-execution
   *  API signs by walletId, not by address. */
  agentWalletId?: string;
  /** Resume a previously-saved conversation (from /ai-agent?session=<id>,
   *  see chat-history/page.tsx). Omit for a fresh conversation. */
  sessionId?:     string;
}

const API_BASE       = process.env.NEXT_PUBLIC_API_URL ?? '/api';
const MAX_CONV_MSGS  = 40;
const WARN_CONV_AT   = 25;
const CARD_TTL_MS    = 10 * 60 * 1000; // confirmation cards expire after 10 minutes

const DAILY_KEY      = () => `salden_agent_requests_${new Date().toISOString().slice(0, 10)}`;
const DAILY_LIMIT    = 1500;
const DAILY_WARN_AT  = 1200;
const DAILY_BLOCK_AT = 1455;

const SUGGESTED = [
  { label: 'Run monthly payroll',  text: 'Run payroll for all monthly employees'           },
  { label: 'Show all employees',   text: 'Show me all active employees'                    },
  { label: 'Check balance',        text: "What's the employer wallet USDC balance?"        },
  { label: 'Compliance check',     text: 'Run a compliance check on all employee wallets'  },
  { label: 'Last 5 runs',          text: 'Show me the last 5 payroll runs'                 },
  { label: 'Top up wallet',        text: 'Request testnet USDC for my employer wallet'     },
];

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getDailyCount(): number {
  try { return parseInt(localStorage.getItem(DAILY_KEY()) ?? '0', 10); } catch { return 0; }
}

function incrementDailyCount(): number {
  try {
    const next = getDailyCount() + 1;
    localStorage.setItem(DAILY_KEY(), String(next));
    return next;
  } catch { return 0; }
}

// ── Action log card (renders the real, server-generated tool-call log) ────────

function ActionLogCard({ entries }: { entries: ActionLogEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {entries.map((log, i) => {
        const tone = log.status === 'SUCCESS' ? 'success' : log.status === 'FAILED' ? 'error' : 'warn';
        const palette = {
          success: { border: '#6EE7B7', bg: '#F0FDF4', color: '#059669', label: '✓ SUCCESS' },
          error:   { border: '#FCA5A5', bg: '#FEF2F2', color: '#DC2626', label: '✗ FAILED' },
          warn:    { border: '#FDE68A', bg: '#FFFBEB', color: '#92400E', label: '⏳ QUEUED' },
        }[tone];
        return (
          <div key={i} style={{
            padding: '8px 12px', borderRadius: 9,
            border: `1.5px solid ${palette.border}`, background: palette.bg, fontSize: 12,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <span style={{ fontWeight: 800, fontSize: 10, letterSpacing: '0.05em', color: palette.color }}>{palette.label}</span>
              <span style={{ color: '#94A3B8' }}>·</span>
              <span style={{ color: '#94A3B8' }}>{new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div style={{ color: '#475569' }}>{log.action}</div>
            {log.detail && <div style={{ color: '#64748B', marginTop: 1 }}>{log.detail}</div>}
          </div>
        );
      })}
    </div>
  );
}

// ── Faucet result card (unchanged behaviour from prior round) ─────────────────

interface FaucetResult {
  status: 'funded' | 'pending' | 'rate_limited' | 'error' | 'balance';
  address: string; balance?: string; balanceBefore?: string; balanceAfter?: string; message?: string;
}

function FaucetResultCard({ address, walletAddress, token, agentAddress }: { address: string; walletAddress: string; token?: string; agentAddress?: string }) {
  const [result, setResult]   = useState<FaucetResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/agent/faucet`, {
          method: 'POST', headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ address, ownerWallet: walletAddress, agentAddress }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? 'Faucet request failed. Please try again.');
        }
        const data = await res.json() as FaucetResult;
        if (!cancelled) { setResult(data); setLoading(false); }
      } catch (err: unknown) {
        if (!cancelled) { setError(err instanceof Error ? err.message : 'Faucet request failed'); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [address, walletAddress, token, agentAddress]);

  const shortAddr = `${address.slice(0, 8)}…${address.slice(-6)}`;

  if (loading) {
    return (
      <div style={{ marginTop: 8, padding: '10px 14px', borderRadius: 10, border: '1.5px solid #C7D2FE', background: '#EEF2FF', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid #4F46E5', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
        <span style={{ color: '#4338CA' }}>Requesting testnet USDC for {shortAddr}…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ marginTop: 8, padding: '10px 14px', borderRadius: 10, border: '1.5px solid #FCA5A5', background: '#FEF2F2', fontSize: 12 }}>
        <span style={{ color: '#DC2626', fontWeight: 700 }}>✗ Faucet Error</span>
        <div style={{ color: '#991B1B', marginTop: 2 }}>{error}</div>
      </div>
    );
  }
  if (!result) return null;

  const statusMeta: Record<string, { label: string; color: string; bg: string; border: string }> = {
    funded:       { label: '✓ Funded',       color: '#059669', bg: '#F0FDF4', border: '#6EE7B7' },
    pending:      { label: '⏳ Pending',      color: '#92400E', bg: '#FFFBEB', border: '#FDE68A' },
    rate_limited: { label: '⚠ Rate Limited',  color: '#92400E', bg: '#FFFBEB', border: '#FED7AA' },
    error:        { label: '✗ Error',         color: '#DC2626', bg: '#FEF2F2', border: '#FCA5A5' },
  };
  const meta = statusMeta[result.status] ?? statusMeta.error;

  return (
    <div style={{ marginTop: 8, padding: '10px 14px', borderRadius: 10, border: `1.5px solid ${meta.border}`, background: meta.bg, fontSize: 12 }}>
      <div style={{ fontWeight: 800, fontSize: 11, letterSpacing: '0.05em', color: meta.color, marginBottom: 4 }}>{meta.label} — Testnet Faucet</div>
      <div style={{ color: '#475569' }}>Address: {shortAddr}</div>
      {result.status === 'funded' && result.balanceBefore && result.balanceAfter && (
        <div style={{ color: '#475569', marginTop: 2 }}>Balance: {result.balanceBefore} → <strong style={{ color: '#059669' }}>{result.balanceAfter} USDC</strong></div>
      )}
      {result.message && <div style={{ color: '#64748B', marginTop: 2 }}>{result.message}</div>}
    </div>
  );
}

// ── Expired card placeholder ───────────────────────────────────────────────────

function ExpiredCard({ label }: { label: string }) {
  return (
    <div style={{ marginTop: 8, padding: '10px 14px', borderRadius: 10, border: '1.5px solid #E2E8F0', background: '#F8FAFC', fontSize: 12, color: '#94A3B8' }}>
      ⏱ This {label} proposal has expired. Ask the agent again if you still want to proceed.
    </div>
  );
}

// ── Usage banner ────────────────────────────────────────────────────────────────

function UsageBanner({ count }: { count: number }) {
  if (count < DAILY_WARN_AT) return null;
  const pct = Math.round((count / DAILY_LIMIT) * 100);
  const isBlocked = count >= DAILY_BLOCK_AT;
  return (
    <div style={{ margin: '0 12px 8px', padding: '8px 12px', borderRadius: 9, background: isBlocked ? '#FEF2F2' : '#FFFBEB', border: `1px solid ${isBlocked ? '#FCA5A5' : '#FED7AA'}`, fontSize: 12, color: isBlocked ? '#DC2626' : '#92400E' }}>
      {isBlocked
        ? `Daily Gemini limit nearly reached (${count}/${DAILY_LIMIT} requests). Resets at midnight.`
        : `${count}/${DAILY_LIMIT} daily AI requests used (${pct}%). Consider starting a new chat to save context.`}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ChatInterface({ walletAddress, onDataChanged, agentAddress, agentActive, agentWalletId, sessionId }: ChatInterfaceProps) {
  const { state } = useApp();
  const { employees, tokenRegistry, payrollClone } = state;
  const { data: walletClient } = useWalletClient();
  const { getToken, invalidate } = useAgentSession();
  const sessionTokenRef = useRef<string | null>(null);

  const [messages,   setMessages]   = useState<Message[]>([]);
  const [input,      setInput]      = useState('');
  const [isLoading,  setIsLoading]  = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [dailyCount, setDailyCount] = useState(0);
  const [pendingAttachment, setPendingAttachment] = useState<{ mimeType: string; data: string; previewUrl: string } | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const endRef      = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Which local-storage session this conversation is being saved under.
  // Resumes the given sessionId if provided (from /ai-agent?session=<id>),
  // otherwise a fresh id is generated for a brand-new conversation.
  const currentSessionIdRef = useRef<string>(sessionId ?? generateSessionId());
  const loadedSessionIdRef  = useRef<string | null>(null);

  useEffect(() => { setDailyCount(getDailyCount()); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, isLoading]);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  // Resume a saved conversation. Guarded by loadedSessionIdRef so this only
  // ever runs once per distinct sessionId (a resumed conversation's own
  // later saves must not re-trigger a reload of itself).
  useEffect(() => {
    if (!sessionId || !walletAddress) return;
    if (loadedSessionIdRef.current === sessionId) return;
    loadedSessionIdRef.current = sessionId;
    currentSessionIdRef.current = sessionId;
    const saved = loadSessionMessages<Message>(walletAddress, sessionId);
    if (saved && saved.length > 0) setMessages(saved);
  }, [sessionId, walletAddress]);

  // Persist on every change. saveSession() itself no-ops on an empty list,
  // so this is safe to fire on initial mount before any messages exist.
  useEffect(() => {
    if (!walletAddress) return;
    saveSession(walletAddress, currentSessionIdRef.current, messages);
  }, [messages, walletAddress]);

  function resetConversation() {
    setMessages([]);
    setError(null);
    // A fresh conversation gets its own session id so it doesn't overwrite
    // the one just left behind (matches /ai-agent?new=<timestamp>).
    currentSessionIdRef.current = generateSessionId();
    loadedSessionIdRef.current = null;
    clearAttachment();
  }

  const ALLOWED_ATTACHMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // matches the server's own limit — reject early with a clear message instead of a vague server error

  function clearAttachment() {
    setPendingAttachment(prev => { if (prev) URL.revokeObjectURL(prev.previewUrl); return null; });
    setAttachError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachError(null);

    if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type)) {
      setAttachError('Only JPEG, PNG, or WebP images are supported.');
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setAttachError('Image is too large (max 8MB).');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1] ?? '';
      setPendingAttachment(prev => { if (prev) URL.revokeObjectURL(prev.previewUrl); return { mimeType: file.type, data: base64, previewUrl: URL.createObjectURL(file) }; });
    };
    reader.onerror = () => setAttachError('Could not read that file — please try again.');
    reader.readAsDataURL(file);
  }

  const send = useCallback(async (text: string, silent = false, attachment?: { mimeType: string; data: string }) => {
    // Silent sends (confirmation events from card callbacks) must never be
    // dropped by the isLoading guard — the AI needs to know what happened.
    if ((!text.trim() && !attachment) || (isLoading && !silent)) return;

    const currentCount = getDailyCount();
    if (currentCount >= DAILY_BLOCK_AT) {
      setError(`Daily AI request limit almost reached (${currentCount}/${DAILY_LIMIT}). Resets at midnight UTC.`);
      return;
    }
    if (!walletClient) {
      setError('Wallet not connected — cannot start a secure agent session.');
      return;
    }

    if (messages.length >= MAX_CONV_MSGS && !silent) setMessages([]);

    const effectiveText = text.trim() || (attachment ? 'Please extract the employee data from this document.' : '');

    const userMsg: Message = {
      id: crypto.randomUUID(), role: 'user',
      content: effectiveText, timestamp: nowTime(), proposedAt: Date.now(),
    };
    if (!silent) { setMessages(prev => [...prev, userMsg]); setInput(''); }
    setIsLoading(true);
    setError(null);

    const allMessages = [
      ...messages.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: effectiveText },
    ];

    // tokenRegistry (from AppContext) is a Record<address, { symbol, decimals, ... }>
    // — the server's parseTokenRegistry() JSON.parse()s this string to build the
    // real symbol->decimals map get_balance needs for ERC-20 reads. Previously
    // this field was never sent at all, so get_balance for any token other than
    // 'native' silently failed every time with "not in the token registry".
    let tokenRegistryJson: string | undefined;
    try { tokenRegistryJson = tokenRegistry ? JSON.stringify(tokenRegistry) : undefined; }
    catch { tokenRegistryJson = undefined; }

    const context = {
      employeeCount: employees.length,
      employees:     employees.map(e => ({
        fullName: e.fullName, walletAddress: e.walletAddress,
        department: e.department, group: e.group,
        // Needed for execute_payroll_run to compute per-employee amounts
        // server-side. Not previously sent since no server-side tool used
        // to need it (propose_payroll_run only ever deep-linked to the
        // dashboard, where the real salary data already lives client-side).
        salaryAmount: e.salaryAmount,
      })),
      agentActive:   agentActive ?? false,
      agentAddress,
      agentWalletId,
      payrollClone:  payrollClone ?? undefined,
      tokenRegistry: tokenRegistryJson,
    };

    try {
      let token = await getToken(walletAddress, walletClient);
      sessionTokenRef.current = token;

      let res = await fetch(`${API_BASE}/agent/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ messages: allMessages, walletAddress, context, attachment }),
      });

      // Session expired mid-flight — refresh once and retry.
      if (res.status === 401) {
        invalidate(walletAddress);
        token = await getToken(walletAddress, walletClient, true);
        sessionTokenRef.current = token;
        res = await fetch(`${API_BASE}/agent/chat`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ messages: allMessages, walletAddress, context, attachment }),
        });
      }

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: 'Request failed' })) as { error?: string };
        throw new Error(errBody.error ?? 'Request failed');
      }

      const data = await res.json() as {
        response?: string; actionLog?: ActionLogEntry[]; events?: AgentEvent[];
        truncated?: boolean; rateLimited?: boolean; cached?: boolean;
      };

      const assistantMsg: Message = {
        id: crypto.randomUUID(), role: 'assistant',
        content: data.response ?? 'No response from agent.',
        timestamp: nowTime(),
        actionLog: data.actionLog,
        events:    data.events,
        eventsResolved: data.events ? data.events.map(() => false) : undefined,
        truncated: data.truncated,
        proposedAt: Date.now(),
      };
      setMessages(prev => [...prev, assistantMsg]);

      if (!data.rateLimited && !data.cached) {
        setDailyCount(incrementDailyCount());
      }
      if (data.actionLog?.some(l => l.status === 'SUCCESS')) onDataChanged?.();

    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : '';
      const msg = /session|sign in|401/i.test(raw)
        ? 'Session expired — please sign in again.'
        : /wallet|connect/i.test(raw)
        ? 'Wallet not connected. Please reconnect and try again.'
        : /network|fetch/i.test(raw)
        ? 'Network error. Check your connection and try again.'
        : 'Something went wrong. Please try again.';
      setError(msg);
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(), role: 'assistant',
        content: msg, timestamp: nowTime(), proposedAt: Date.now(),
      }]);
    } finally {
      setIsLoading(false);
    }
  }, [messages, isLoading, walletAddress, walletClient, employees, onDataChanged, getToken, invalidate]);

  const markEventResolved = useCallback((messageId: string, index: number) => {
    setMessages(prev => prev.map(m => {
      if (m.id !== messageId || !m.eventsResolved) return m;
      const next = [...m.eventsResolved];
      next[index] = true;
      return { ...m, eventsResolved: next };
    }));
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); }
  };

  const isBlocked   = dailyCount >= DAILY_BLOCK_AT;
  const warnConvLen = messages.length >= WARN_CONV_AT;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: '500px',
      background: '#F8FAFC', borderRadius: '16px', border: '1px solid #E2E8F0',
      overflow: 'hidden', fontFamily: "'DM Sans', system-ui, sans-serif",
    }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', background: '#1E3A5F', display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
        <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="2">
            <circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
          </svg>
        </div>
        <div>
          <div style={{ color: '#FFF', fontWeight: 700, fontSize: 15 }}>Salden AI Payroll Agent</div>
          <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>Gemini 2.5 Flash · Arc Testnet · {dailyCount}/{DAILY_LIMIT} req today</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {messages.length > 0 && (
            <button onClick={resetConversation} title="New chat" style={{ background: 'rgba(255,255,255,0.12)', border: 'none', borderRadius: 7, padding: '4px 10px', color: 'rgba(255,255,255,0.8)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              + New
            </button>
          )}
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#6EE7B7', boxShadow: '0 0 6px #6EE7B7' }} />
        </div>
      </div>

      {dailyCount >= DAILY_WARN_AT && <UsageBanner count={dailyCount} />}

      {warnConvLen && (
        <div style={{ margin: '0 12px 8px', padding: '7px 12px', borderRadius: 9, background: '#EEF2FF', border: '1px solid #C7D2FE', fontSize: 12, color: '#4338CA', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Long conversation — older context may be summarised.</span>
          <button onClick={resetConversation} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4F46E5', fontWeight: 700, fontSize: 12, fontFamily: 'inherit' }}>Start fresh</button>
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 16px' }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '32px 16px' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A', marginBottom: 8 }}>How can I help with payroll today?</div>
            <div style={{ fontSize: 13, color: '#64748B', marginBottom: 24 }}>Ask me to run payroll, check balances, manage employees, or schedule payments.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, maxWidth: 400, margin: '0 auto' }}>
              {SUGGESTED.map((p, i) => (
                <button key={i} onClick={() => send(p.text)} style={{ padding: '10px 12px', background: '#FFF', border: '1px solid #E2E8F0', borderRadius: 10, cursor: 'pointer', fontSize: 12, color: '#334155', fontWeight: 500, textAlign: 'left' as const, fontFamily: 'inherit' }}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map(m => {
          const expired = Date.now() - m.proposedAt > CARD_TTL_MS;
          return (
            <div key={m.id}>
              <ChatMessage role={m.role} content={m.content} timestamp={m.timestamp} />
              {m.truncated && (
                <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>
                  ⓘ This response was shortened and regenerated after hitting the length limit.
                </div>
              )}
              {m.actionLog && m.actionLog.length > 0 && <ActionLogCard entries={m.actionLog} />}

              {m.role === 'assistant' && m.events?.map((ev, i) => {
                const resolved = m.eventsResolved?.[i];
                if (resolved) return null; // outcome already reported via its own card transition

                if (ev.type === 'faucet_request' && ev.address) {
                  return <FaucetResultCard key={i} address={ev.address} walletAddress={walletAddress} token={sessionTokenRef.current ?? undefined} agentAddress={agentAddress} />;
                }

                if (ev.type === 'unlisted_payment_request' && ev.address && ev.amount && ev.token) {
                  if (expired) return <ExpiredCard key={i} label="payment" />;
                  return (
                    <UnlistedPaymentCard
                      key={i}
                      address={ev.address} amount={ev.amount} token={ev.token}
                      walletAddress={walletAddress}
                      sessionToken={sessionTokenRef.current ?? undefined}
                      onResolved={(outcome, detail) => {
                        markEventResolved(m.id, i);
                        if (outcome === 'confirmed') {
                          send(`[CONFIRMATION_EVENT] The user confirmed and signed the payment of ${ev.amount} ${ev.token} to ${ev.address}. It executed successfully on-chain. Transaction hash: ${detail}.`, true);
                        } else if (outcome === 'declined') {
                          send(`[CONFIRMATION_EVENT] The user declined the proposed payment to ${ev.address}. Do not propose it again unless they ask.`, true);
                        } else {
                          send(`[CONFIRMATION_EVENT] The payment to ${ev.address} failed before confirmation: ${detail}.`, true);
                        }
                      }}
                    />
                  );
                }

                if (ev.type === 'add_employee_request' && ev.address && ev.fullName) {
                  if (expired) return <ExpiredCard key={i} label="add employee" />;
                  return (
                    <AddEmployeeCard
                      key={i}
                      address={ev.address} fullName={ev.fullName}
                      department={ev.department ?? ''} group={ev.group ?? ''} salary={ev.salary ?? '0'}
                      walletAddress={walletAddress}
                      onResolved={(outcome, detail) => {
                        markEventResolved(m.id, i);
                        if (outcome === 'confirmed') {
                          send(`[CONFIRMATION_EVENT] The user confirmed saving ${ev.fullName} to the employee database. It was written to IPFS and anchored on-chain successfully.`, true);
                          onDataChanged?.();
                        } else if (outcome === 'declined') {
                          send(`[CONFIRMATION_EVENT] The user declined saving ${ev.fullName} to the employee database.`, true);
                        } else {
                          send(`[CONFIRMATION_EVENT] Saving ${ev.fullName} to the employee database failed: ${detail}.`, true);
                        }
                      }}
                    />
                  );
                }

                if (ev.type === 'edit_employee_request' && ev.currentAddress) {
                  if (expired) return <ExpiredCard key={i} label="edit employee" />;
                  return (
                    <EditEmployeeCard
                      key={i}
                      currentAddress={ev.currentAddress}
                      fullName={ev.fullName} department={ev.department} group={ev.group}
                      salary={ev.salary} newAddress={ev.newAddress}
                      walletAddress={walletAddress}
                      onResolved={(outcome, detail) => {
                        markEventResolved(m.id, i);
                        if (outcome === 'confirmed') {
                          send('[CONFIRMATION_EVENT] The user confirmed the employee update. It was written to IPFS and anchored on-chain successfully.', true);
                          onDataChanged?.();
                        } else if (outcome === 'declined') {
                          send('[CONFIRMATION_EVENT] The user declined the employee update.', true);
                        } else {
                          send(`[CONFIRMATION_EVENT] Updating the employee failed: ${detail}.`, true);
                        }
                      }}
                    />
                  );
                }

                if (ev.type === 'edit_employee_immediate' && ev.currentAddress) {
                  return (
                    <EditEmployeeCard
                      key={i}
                      currentAddress={ev.currentAddress}
                      fullName={ev.fullName} department={ev.department} group={ev.group}
                      salary={ev.salary} newAddress={ev.newAddress}
                      walletAddress={walletAddress}
                      autoConfirm
                      onResolved={(outcome, detail) => {
                        markEventResolved(m.id, i);
                        if (outcome === 'confirmed') onDataChanged?.();
                        if (outcome === 'error') send(`[CONFIRMATION_EVENT] The explicit employee update failed: ${detail}.`, true);
                      }}
                    />
                  );
                }

                if (ev.type === 'remove_employee_request' && ev.address && ev.fullName) {
                  if (expired) return <ExpiredCard key={i} label="remove employee" />;
                  return (
                    <RemoveEmployeeCard
                      key={i}
                      address={ev.address} fullName={ev.fullName}
                      walletAddress={walletAddress}
                      onResolved={(outcome, detail) => {
                        markEventResolved(m.id, i);
                        if (outcome === 'confirmed') {
                          send(`[CONFIRMATION_EVENT] The user confirmed removing ${ev.fullName} from the employee database.`, true);
                          onDataChanged?.();
                        } else if (outcome === 'declined') {
                          send(`[CONFIRMATION_EVENT] The user declined removing ${ev.fullName}.`, true);
                        } else {
                          send(`[CONFIRMATION_EVENT] Removing ${ev.fullName} failed: ${detail}.`, true);
                        }
                      }}
                    />
                  );
                }

                if (ev.type === 'bulk_add_employees_request' && ev.employeesJson) {
                  if (expired) return <ExpiredCard key={i} label="add employees" />;
                  return (
                    <BulkAddEmployeesCard
                      key={i}
                      employeesJson={ev.employeesJson}
                      skippedCount={ev.skippedCount}
                      walletAddress={walletAddress}
                      onResolved={(outcome, detail) => {
                        markEventResolved(m.id, i);
                        if (outcome === 'confirmed') {
                          send('[CONFIRMATION_EVENT] The user confirmed adding the extracted employees. They were written to IPFS and anchored on-chain successfully.', true);
                          onDataChanged?.();
                        } else if (outcome === 'declined') {
                          send('[CONFIRMATION_EVENT] The user declined adding the extracted employees.', true);
                        } else {
                          send(`[CONFIRMATION_EVENT] Adding the extracted employees failed: ${detail}.`, true);
                        }
                      }}
                    />
                  );
                }

                if (ev.type === 'bulk_add_employees_immediate' && ev.employeesJson) {
                  return (
                    <BulkAddEmployeesCard
                      key={i}
                      employeesJson={ev.employeesJson}
                      skippedCount={ev.skippedCount}
                      walletAddress={walletAddress}
                      autoConfirm
                      onResolved={(outcome, detail) => {
                        markEventResolved(m.id, i);
                        if (outcome === 'confirmed') onDataChanged?.();
                        if (outcome === 'error') send(`[CONFIRMATION_EVENT] The explicit bulk employee add failed: ${detail}.`, true);
                      }}
                    />
                  );
                }

                if (ev.type === 'payroll_run_request' && ev.group) {
                  return <PayrollRunCard key={i} group={ev.group} />;
                }

                if (ev.type === 'agent_executed_payment' && ev.address) {
                  return (
                    <div key={i} style={{
                      background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10,
                      padding: '12px 16px', fontSize: 13, color: '#166534',
                    }}>
                      <strong>Agent paid {ev.amount} {ev.token}</strong> to {String(ev.address).slice(0, 8)}…{String(ev.address).slice(-4)}
                      {ev.pending ? ' — still confirming on-chain.' : '.'}
                      {ev.txHash && (
                        <> <a href={txLink(String(ev.txHash))} target="_blank" rel="noreferrer" style={{ color: '#166534', textDecoration: 'underline' }}>View transaction</a></>
                      )}
                    </div>
                  );
                }

                if (ev.type === 'agent_executed_payroll_run' && ev.group) {
                  return (
                    <div key={i} style={{
                      background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10,
                      padding: '12px 16px', fontSize: 13, color: '#166534',
                    }}>
                      <strong>Agent ran payroll for &quot;{ev.group}&quot;</strong> — {ev.recipients} employee{ev.recipients === 1 ? '' : 's'}, {ev.totalAmount} USDC
                      {ev.pending ? ' — still confirming on-chain.' : '.'}
                      {ev.txHash && (
                        <> <a href={txLink(String(ev.txHash))} target="_blank" rel="noreferrer" style={{ color: '#166534', textDecoration: 'underline' }}>View transaction</a></>
                      )}
                    </div>
                  );
                }

                return null;
              })}
            </div>
          );
        })}

        {isLoading && <ChatMessage role="assistant" content="" isLoading />}
        <div ref={endRef} />
      </div>

      {error && (
        <div style={{ margin: '0 16px', padding: '10px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, fontSize: 12, color: '#991B1B' }}>
          {error}
        </div>
      )}

      {attachError && (
        <div style={{ margin: '0 16px', padding: '10px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, fontSize: 12, color: '#991B1B' }}>
          {attachError}
        </div>
      )}

      {pendingAttachment && (
        <div style={{ margin: '0 16px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src={pendingAttachment.previewUrl} alt="Attached document preview" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 8, border: '1px solid #E2E8F0' }} />
          <span style={{ fontSize: 12, color: '#64748B' }}>Document attached — I&apos;ll extract employee data from it.</span>
          <button onClick={clearAttachment} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: 12, marginLeft: 'auto' }}>Remove</button>
        </div>
      )}

      {/* Input */}
      <div style={{ padding: '12px 16px', background: '#FFF', borderTop: '1px solid #E2E8F0', display: 'flex', gap: 10, alignItems: 'flex-end', flexShrink: 0 }}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={isLoading || isBlocked}
          title="Attach a document (roster, offer letter, etc.) for the agent to read"
          style={{
            width: 40, height: 40, borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0',
            cursor: isLoading || isBlocked ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center',
            justifyContent: 'center', flexShrink: 0, color: '#64748B',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask me anything about payroll…"
          rows={1}
          disabled={isLoading || isBlocked}
          style={{ flex: 1, resize: 'none', border: '1px solid #E2E8F0', borderRadius: 10, padding: '10px 14px', fontSize: 14, fontFamily: 'inherit', color: '#0F172A', outline: 'none', background: isBlocked ? '#F8F9FA' : '#F8FAFC', lineHeight: 1.5, maxHeight: 120 }}
        />
        <button
          onClick={() => { const att = pendingAttachment ? { mimeType: pendingAttachment.mimeType, data: pendingAttachment.data } : undefined; send(input, false, att); clearAttachment(); }}
          disabled={isLoading || (!input.trim() && !pendingAttachment) || isBlocked}
          style={{ width: 40, height: 40, borderRadius: 10, background: isLoading || (!input.trim() && !pendingAttachment) || isBlocked ? '#E2E8F0' : '#14B8A6', border: 'none', cursor: isLoading || (!input.trim() && !pendingAttachment) || isBlocked ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={isLoading || (!input.trim() && !pendingAttachment) || isBlocked ? '#94A3B8' : '#fff'} strokeWidth="2.5">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
      <div style={{ textAlign: 'center', fontSize: 10, color: '#CBD5E1', padding: '4px 0 8px', background: '#FFF' }}>
        Enter to send · Shift+Enter for newline
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
