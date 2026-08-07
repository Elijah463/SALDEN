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
import { FileText } from 'lucide-react';
import { useUniversalWrite } from '@/lib/circle/useUniversalWrite';
import { useApp }    from '@/context/AppContext';
import ChatMessage   from '@/components/agent/ChatMessage';
import { useAgentSession } from '@/lib/agent/useAgentSession';
import { generateSessionId, loadSessionMessages, saveSession } from '@/lib/chatSessions';
import { saveAgentLog } from '@/lib/db/indexeddb';
import { friendlyErrorMessage } from '@/lib/errorMessage';
import { txLink } from '@/lib/contracts/config';
import { isCircleTxTerminal, isCircleTxSuccess } from '@/lib/circle/txState';
import {
  UnlistedPaymentCard, AddEmployeeCard, PayrollRunCard,
  EditEmployeeCard, RemoveEmployeeCard, BulkAddEmployeesCard,
  ScheduleConfirmationCard, CancelScheduleCard,
} from '@/components/agent/AgentConfirmationCards';

interface ActionLogEntry {
  action:    string;
  status:    'SUCCESS' | 'FAILED' | 'QUEUED';
  detail?:   string;
  timestamp: string;
  /** Circle's own transaction id, present only when status is 'QUEUED' —
   *  lets the polling effect below check /api/agent/tx-status and update
   *  this exact entry once the transaction actually resolves, instead of
   *  it staying "QUEUED" forever even after it's confirmed on-chain. */
  pendingTxId?: string;
}

interface AgentEvent {
  type: 'faucet_request' | 'unlisted_payment_request' | 'add_employee_request' | 'payroll_run_request'
      | 'agent_executed_payment' | 'agent_executed_payroll_run'
      | 'edit_employee_request' | 'edit_employee_immediate' | 'remove_employee_request'
      | 'bulk_add_employees_request' | 'bulk_add_employees_immediate'
      | 'schedule_payment_request' | 'cancel_schedule_request';
  address?: string; amount?: string; token?: string;
  fullName?: string; department?: string; group?: string; salary?: string;
  txHash?: string; pending?: boolean; recipients?: number; totalAmount?: string;
  currentAddress?: string; newAddress?: string;
  employeesJson?: string; skippedCount?: number;
  /** schedule_payment_request only — epoch ms for when the one-time
   *  payment should run. */
  whenMs?: number;
  /** cancel_schedule_request only — the schedule's id and human-readable
   *  label (from get_schedules), so the card can show exactly what's
   *  about to be cancelled without a second round trip. */
  scheduleId?: string; label?: string;
  /** Circle's own transaction id for a pending agent_executed_* event —
   *  same purpose as ActionLogEntry.pendingTxId above. */
  transactionId?: string;
  /** Set by the server (see tools.ts's propose_* schemas and chat/route.ts)
   *  when the model judged the instruction fully explicit — the matching
   *  card skips its manual review click and goes straight to the wallet
   *  signature prompt. Undefined/false shows the normal review card. */
  autoConfirm?: boolean;
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
  /** Only set on assistant messages. The raw Gemini response parts for
   *  this turn — never rendered, only round-tripped back to the server on
   *  the next request so it can rebuild history with the thought
   *  signature Gemini 3.x requires. See app/api/agent/chat/route.ts's
   *  buildHistory() for the full explanation. Without this, tool calling
   *  works once per conversation and then breaks. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawParts?: any[];
  /** Only set on user messages that included a file — metadata only (name
   *  + type), not the file content itself, purely so the chat log shows
   *  what was actually sent instead of the attachment vanishing the
   *  moment the message is sent. */
  attachment?: { fileName: string; mimeType: string };
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
  { label: 'Add an employee',      text: 'I want to add a new employee'                    },
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

// (ActionLogCard removed — these entries are now persisted to the Manage
// Agent page's log store instead of rendered inline in chat. See the
// persistence effect inside ChatInterface below.)

// ── Faucet result card (unchanged behaviour from prior round) ─────────────────

interface FaucetResult {
  status: 'funded' | 'pending' | 'rate_limited' | 'error' | 'balance';
  address: string; balance?: string; balanceBefore?: string; balanceAfter?: string; message?: string;
}

function FaucetResultCard({ address, walletAddress, token, agentAddress, onResolved }: { address: string; walletAddress: string; token?: string; agentAddress?: string; onResolved?: (outcome: 'confirmed' | 'error', detail?: string) => void }) {
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
        if (!cancelled) {
          setResult(data); setLoading(false);
          // BUG FIX: this used to resolve entirely on its own, with no way
          // to tell the parent — so the action-log line server-rendered as
          // "⏳ QUEUED · Faucet request for 0x..." stayed QUEUED forever,
          // even once this card clearly showed Funded/Error right below
          // it. Same underlying bug class as the payment/payroll-run
          // "stuck in Queue" fix, just resolved via a direct callback here
          // since this component already knows its real outcome
          // synchronously, rather than needing to poll anything.
          onResolved?.(data.status === 'funded' || data.status === 'pending' ? 'confirmed' : 'error', data.message);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const msg = friendlyErrorMessage(err, 'Faucet request failed');
          setError(msg); setLoading(false);
          onResolved?.('error', msg);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [address, walletAddress, token, agentAddress, onResolved]);

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
  const { employees, tokenRegistry, payrollClone, payrollSetup } = state;
  const { signMessage: universalSignMessage, canWrite } = useUniversalWrite();
  const { getToken, invalidate } = useAgentSession();
  const sessionTokenRef = useRef<string | null>(null);

  const [messages,   setMessages]   = useState<Message[]>([]);
  const [input,      setInput]      = useState('');
  const [isLoading,  setIsLoading]  = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [dailyCount, setDailyCount] = useState(0);
  const [pendingAttachment, setPendingAttachment] = useState<{ mimeType: string; data: string; fileName: string; previewUrl: string | null } | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const endRef      = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Tracks whether the person is currently scrolled near the bottom of the
  // chat. The auto-scroll effect below used to fire unconditionally on
  // every `messages`/`isLoading` change — including background updates like
  // the tx-status poller's silent setMessages calls — which yanked the view
  // back to the bottom even while someone was actively scrolled up reading
  // earlier messages, making it impossible to read history. Defaults to
  // true so the normal "stick to the latest message" behavior is unchanged
  // on load and while the person hasn't scrolled away from the bottom.
  const isNearBottomRef = useRef(true);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  // Which local-storage session this conversation is being saved under.
  // Resumes the given sessionId if provided (from /ai-agent?session=<id>),
  // otherwise a fresh id is generated for a brand-new conversation.
  const currentSessionIdRef = useRef<string>(sessionId ?? generateSessionId());
  const loadedSessionIdRef  = useRef<string | null>(null);
  // Tracks which `${message id}:${actionLog index}` entries have already
  // been written to the Manage Agent page's log store, so the persistence
  // effect further down never re-persists the same entry on every
  // subsequent messages update.
  const persistedLogKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => { setDailyCount(getDailyCount()); }, []);
  useEffect(() => {
    if (!isNearBottomRef.current) return;
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
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

  // ── Resolve any still-pending autonomous-execution transactions ───────────
  // This is THE fix for "the transaction succeeded on-chain but the chat
  // stayed stuck on QUEUED forever": lib/agent/autonomousExecution.ts only
  // polls for confirmation for a few seconds before the chat response has
  // to go out — a transaction that hadn't confirmed by then comes back
  // marked QUEUED/pending with nothing ever checking it again afterward,
  // even once it confirms moments later. This scans for any unresolved
  // pendingTxId/transactionId still in the conversation and keeps checking
  // /api/agent/tx-status until each one resolves, then updates that exact
  // action-log line and event card in place — no page refresh needed.
  //
  // Deliberately reuses sessionTokenRef.current (already obtained by the
  // request that produced the pending transaction) rather than calling
  // getToken() itself — this must never trigger a fresh sign-message
  // prompt from a background poll the user didn't initiate. If there's no
  // cached token yet (e.g. messages were just reloaded from a saved
  // session on page load, before any new message has been sent), it
  // simply waits for one rather than interrupting the user.
  useEffect(() => {
    const pendingIds = new Set<string>();
    for (const m of messages) {
      m.actionLog?.forEach(l => { if (l.status === 'QUEUED' && l.pendingTxId) pendingIds.add(l.pendingTxId); });
      m.events?.forEach(e => { if (e.pending && e.transactionId) pendingIds.add(e.transactionId); });
    }
    if (pendingIds.size === 0 || !walletAddress) return;

    let cancelled = false;

    const pollOnce = async () => {
      const token = sessionTokenRef.current;
      if (!token) return; // no signed session yet — wait for the next interval rather than prompting

      for (const txId of pendingIds) {
        try {
          const res = await fetch(
            `${API_BASE}/agent/tx-status?id=${encodeURIComponent(txId)}&wallet=${encodeURIComponent(walletAddress)}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!res.ok) continue;
          const data = await res.json() as { state?: string; txHash?: string };
          if (!isCircleTxTerminal(data.state)) continue;
          if (cancelled) return;

          const resolvedStatus: ActionLogEntry['status'] = isCircleTxSuccess(data.state) ? 'SUCCESS' : 'FAILED';
          setMessages(prev => prev.map(m => ({
            ...m,
            actionLog: m.actionLog?.map(l => l.pendingTxId === txId
              ? {
                  ...l, status: resolvedStatus, pendingTxId: undefined,
                  detail: resolvedStatus === 'FAILED' ? 'Transaction reverted on-chain — no funds moved.' : l.detail,
                }
              : l),
            events: m.events?.map(e => e.transactionId === txId
              ? { ...e, pending: false, txHash: data.txHash ?? e.txHash }
              : e),
          })));
          if (resolvedStatus === 'SUCCESS') onDataChanged?.();
        } catch { /* network blip — retry on the next interval */ }
      }
    };

    pollOnce();
    const interval = setInterval(pollOnce, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [messages, walletAddress, onDataChanged]);

  // ── Persist finalized action-log entries to the Manage Agent page's log
  // store, instead of showing them inline in chat (see ActionLogCard's
  // removal above). Runs off `messages` itself rather than only the
  // initial send response, so it also catches entries that start out
  // QUEUED and only resolve later — either via the tx-status poller just
  // above, or via one of the confirmation cards' own onResolved handlers
  // (FaucetResultCard, AddEmployeeCard, PayrollRunCard, etc.) — without
  // needing a separate persistence call duplicated into every one of those
  // handlers. `persistedLogKeys` guards against re-persisting the same
  // entry on every subsequent messages update; the deterministic
  // `${message id}-${entry index}` id passed to saveAgentLog also makes a
  // duplicate write (e.g. after a session reload) an idempotent overwrite
  // rather than a second row.
  useEffect(() => {
    if (!walletAddress) return;
    for (const m of messages) {
      if (!m.actionLog) continue;
      m.actionLog.forEach((entry, i) => {
        if (entry.status === 'QUEUED') return; // not final yet — wait for it to resolve
        const key = `${m.id}:${i}`;
        if (persistedLogKeysRef.current.has(key)) return;
        persistedLogKeysRef.current.add(key);

        // Best-effort tx-hash attachment: when this turn produced exactly
        // one event that already resolved to a txHash, pair it with a
        // SUCCESS entry — covers the common single-action-per-turn case.
        // A multi-action turn simply logs without a tx link rather than
        // risk pairing the wrong hash to the wrong entry.
        const soleTxHash = m.events?.length === 1 ? m.events[0].txHash : undefined;

        saveAgentLog({
          id:            `${m.id}-${i}`,
          walletAddress,
          timestamp:     new Date(entry.timestamp).getTime() || Date.now(),
          action:        entry.action,
          status:        entry.status === 'SUCCESS' ? 'success' : 'failed',
          details:       entry.detail,
          txHash:        entry.status === 'SUCCESS' ? soleTxHash : undefined,
        }).catch(err => console.warn('[ChatInterface] Failed to persist agent log entry:', err));
      });
    }
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

  // PDF: Gemini's own document understanding reads this natively via
  // inlineData — same mechanism as images, just a different MIME type.
  // Everything else here is plain text (code files, CSV, JSON, Markdown)
  // — no special "document understanding" needed, it's just extracted as
  // text and included in the prompt like any other text.
  //
  // Deliberately NOT included: .doc/.docx. Per Google's own Gemini API
  // docs (ai.google.dev/gemini-api/docs/document-processing): "document
  // vision only meaningfully understands PDFs." Broader Office-format
  // support (DOCX, XLSX, PPTX) exists in Google's own Workspace apps,
  // which silently convert those files with Google's internal Docs/Sheets
  // converters before the model ever sees them — that conversion isn't
  // part of the raw Gemini API this app calls, so passing a .docx file's
  // raw bytes here would not be reliably understood. Rather than accept
  // it and silently produce garbage, it's excluded until there's a real,
  // tested conversion step to pair with it.
  const ALLOWED_ATTACHMENT_TYPES = [
    'application/pdf',
    'text/csv', 'text/plain', 'text/markdown',
    'application/json',
    'text/javascript', 'application/javascript',
    'text/typescript', 'application/typescript',
    'text/jsx', 'text/tsx',
    'text/x-csv', 'application/csv', // some browsers/OSes report CSV under these instead of text/csv
  ];
  // Extensions the OS file picker should filter to — belt-and-suspenders
  // alongside the MIME check above, since some browsers report an empty
  // or generic `file.type` for less common extensions (.ts/.tsx/.jsx in
  // particular are inconsistently recognized).
  const ALLOWED_ATTACHMENT_EXTENSIONS = ['.pdf', '.csv', '.js', '.jsx', '.ts', '.tsx', '.txt', '.json', '.md'];
  const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // matches the server's own limit — reject early with a clear message instead of a vague server error

  function clearAttachment() {
    setPendingAttachment(prev => { if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl); return null; });
    setAttachError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function isAllowedAttachment(file: File): boolean {
    if (ALLOWED_ATTACHMENT_TYPES.includes(file.type)) return true;
    // Fall back to extension when the browser didn't report a useful MIME
    // type at all (common for .ts/.tsx/.jsx, which have no standardized
    // MIME type and are frequently reported as '' or 'application/octet-stream').
    const lower = file.name.toLowerCase();
    return ALLOWED_ATTACHMENT_EXTENSIONS.some(ext => lower.endsWith(ext));
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachError(null);

    if (!isAllowedAttachment(file)) {
      setAttachError('Only PDF, CSV, JSON, Markdown, plain text, or code files (.js/.jsx/.ts/.tsx) are supported.');
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setAttachError('File is too large (max 8MB).');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1] ?? '';
      // None of the allowed types here (PDF, CSV, code, text, JSON, MD) are
      // things a browser <img> tag can actually render as a visual preview
      // — that only applies to raster images, which are deliberately not
      // in the allowed list anymore. Every attachment shows as a file chip.
      setPendingAttachment(prev => {
        if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
        return {
          mimeType: file.type || 'text/plain', // fall back for browsers that report '' for .ts/.tsx/.jsx
          data: base64,
          fileName: file.name,
          previewUrl: null,
        };
      });
    };
    reader.onerror = () => setAttachError('Could not read that file — please try again.');
    reader.readAsDataURL(file);
  }

  const send = useCallback(async (text: string, silent = false, attachment?: { mimeType: string; data: string; fileName?: string }) => {
    // Silent sends (confirmation events from card callbacks) must never be
    // dropped by the isLoading guard — the AI needs to know what happened.
    if ((!text.trim() && !attachment) || (isLoading && !silent)) return;

    const currentCount = getDailyCount();
    if (currentCount >= DAILY_BLOCK_AT) {
      setError(`Daily AI request limit almost reached (${currentCount}/${DAILY_LIMIT}). Resets at midnight UTC.`);
      return;
    }
    if (!canWrite) {
      setError('Wallet not connected — cannot start a secure agent session.');
      return;
    }

    if (messages.length >= MAX_CONV_MSGS && !silent) setMessages([]);

    const effectiveText = text.trim() || (attachment ? `Please extract the relevant data from this file${attachment.fileName ? ` (${attachment.fileName})` : ''}.` : '');

    const userMsg: Message = {
      id: crypto.randomUUID(), role: 'user',
      content: effectiveText, timestamp: nowTime(), proposedAt: Date.now(),
      attachment: attachment ? { fileName: attachment.fileName || 'file', mimeType: attachment.mimeType } : undefined,
    };
    if (!silent) { isNearBottomRef.current = true; setMessages(prev => [...prev, userMsg]); setInput(''); }
    setIsLoading(true);
    setError(null);

    const allMessages = [
      ...messages.map(m => ({ role: m.role, content: m.content, rawParts: m.rawParts })),
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
        // Needed for execute_payroll_run and the in-chat PayrollRunCard to
        // compute per-employee amounts. Every payroll action — proposed or
        // autonomous — is handled entirely within the chat interface; the
        // agent never redirects the user out to the dashboard to finish
        // something itself.
        salaryAmount: e.salaryAmount,
      })),
      agentActive:   agentActive ?? false,
      agentAddress,
      agentWalletId,
      payrollClone:  payrollClone ?? undefined,
      tokenRegistry: tokenRegistryJson,
      // Lets execute_payment/execute_payroll_run (the fully autonomous,
      // server-executed paths) send a payroll receipt email after
      // confirming on-chain — see the matching comment on the server side
      // in app/api/agent/chat/route.ts.
      receiptEmail:  payrollSetup?.email || undefined,
    };

    try {
      let token = await getToken(walletAddress, universalSignMessage);
      sessionTokenRef.current = token;

      let res = await fetch(`${API_BASE}/agent/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ messages: allMessages, walletAddress, context, attachment }),
      });

      // Session expired mid-flight — refresh once and retry.
      if (res.status === 401) {
        invalidate(walletAddress);
        token = await getToken(walletAddress, universalSignMessage, true);
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rawParts?: any[];
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
        rawParts: data.rawParts,
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
        // BUG FIX: this used to fall through to a hardcoded generic
        // string for anything that didn't match one of the three patterns
        // above — silently discarding the server's own specific,
        // already-friendly message (e.g. "I'm getting rate-limited right
        // now — please wait about a minute and try again.") and showing
        // the same unhelpful "Something went wrong" for every distinct
        // failure. `raw` here is our own controlled text from the server's
        // `error` field, never a raw exception dump — safe to show as-is;
        // friendlyErrorMessage() is a defensive backstop in case it's ever
        // something unexpectedly long.
        : friendlyErrorMessage(err, 'Something went wrong. Please try again.');
      setError(msg);
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(), role: 'assistant',
        content: msg, timestamp: nowTime(), proposedAt: Date.now(),
      }]);
    } finally {
      setIsLoading(false);
    }
  }, [messages, isLoading, walletAddress, canWrite, universalSignMessage, employees, onDataChanged, getToken, invalidate]);

  const markEventResolved = useCallback((messageId: string, index: number) => {
    setMessages(prev => prev.map(m => {
      if (m.id !== messageId || !m.eventsResolved) return m;
      const next = [...m.eventsResolved];
      next[index] = true;
      return { ...m, eventsResolved: next };
    }));
  }, []);

  // Enter used to send (Shift+Enter for a newline) — on a phone's virtual
  // keyboard, the Enter/Go key has no reliable way to combine with Shift,
  // so every Enter press sent whatever had been typed so far mid-thought.
  // Enter now always just inserts a newline; the Send button is the only
  // way to send, on every device.
  const onKeyDown = (_e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Intentionally a no-op — let the textarea's default Enter behaviour
    // (insert a newline) happen. Kept as a named handler rather than
    // removed so the intent is documented, not just silently absent.
  };

  const isBlocked   = dailyCount >= DAILY_BLOCK_AT;
  const warnConvLen = messages.length >= WARN_CONV_AT;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: '500px',
      background: '#F8FAFC', borderRadius: '16px', border: '1px solid #E2E8F0',
      overflow: 'hidden', fontFamily: "'DM Sans', system-ui, sans-serif",
    }}>
      {/* New-chat control — only shown once there's a conversation to reset */}
      {messages.length > 0 && (
        <div style={{ padding: '10px 16px 0', display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
          <button
            onClick={resetConversation}
            title="Start a new chat"
            style={{
              background: '#F1F5F9', border: '1px solid #E2E8F0', borderRadius: 8,
              padding: '5px 12px', color: '#475569', fontSize: 12, fontWeight: 600,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            + New chat
          </button>
        </div>
      )}

      {dailyCount >= DAILY_WARN_AT && <UsageBanner count={dailyCount} />}

      {warnConvLen && (
        <div style={{ margin: '0 12px 8px', padding: '7px 12px', borderRadius: 9, background: '#EEF2FF', border: '1px solid #C7D2FE', fontSize: 12, color: '#4338CA', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Long conversation — older context may be summarised.</span>
          <button onClick={resetConversation} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#14B8A6', fontWeight: 700, fontSize: 12, fontFamily: 'inherit' }}>Start fresh</button>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollContainerRef} onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', padding: '20px 16px' }}>
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
            <div key={m.id} style={{ marginBottom: 16 }}>
              <ChatMessage role={m.role} content={m.content} timestamp={m.timestamp} attachment={m.attachment} />
              {m.truncated && (
                <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>
                  ⓘ This response was shortened and regenerated after hitting the length limit.
                </div>
              )}
              {/* actionLog is no longer rendered inline — see the persistence
                  effect above, which sends finalized entries to the Manage
                  Agent page's log store instead. */}

              {m.role === 'assistant' && m.events?.map((ev, i) => {
                const resolved = m.eventsResolved?.[i];
                if (resolved) return null; // outcome already reported via its own card transition

                if (ev.type === 'faucet_request' && ev.address) {
                  return (
                    <FaucetResultCard
                      key={i}
                      address={ev.address} walletAddress={walletAddress}
                      token={sessionTokenRef.current ?? undefined} agentAddress={agentAddress}
                      onResolved={(outcome, detail) => {
                        setMessages(prev => prev.map(msg => msg.id !== m.id ? msg : {
                          ...msg,
                          actionLog: msg.actionLog?.map(log =>
                            (log.status === 'QUEUED' && log.action.startsWith('Faucet request for'))
                              ? { ...log, status: outcome === 'confirmed' ? 'SUCCESS' : 'FAILED', detail: outcome === 'error' ? detail : log.detail }
                              : log
                          ),
                        }));
                      }}
                    />
                  );
                }

                if (ev.type === 'unlisted_payment_request' && ev.address && ev.amount && ev.token) {
                  if (expired) return <ExpiredCard key={i} label="payment" />;
                  return (
                    <UnlistedPaymentCard
                      key={i}
                      address={ev.address} amount={ev.amount} token={ev.token}
                      walletAddress={walletAddress}
                      sessionToken={sessionTokenRef.current ?? undefined}
                      autoConfirm={ev.autoConfirm}
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
                      autoConfirm={ev.autoConfirm}
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
                      autoConfirm={ev.autoConfirm}
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
                      autoConfirm={ev.autoConfirm}
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
                  if (expired) return <ExpiredCard key={i} label="payroll run" />;
                  return (
                    <PayrollRunCard
                      key={i}
                      group={ev.group}
                      walletAddress={walletAddress}
                      sessionToken={sessionTokenRef.current ?? undefined}
                      autoConfirm={ev.autoConfirm}
                      onResolved={(outcome, detail) => {
                        markEventResolved(m.id, i);
                        if (outcome === 'confirmed') {
                          onDataChanged?.();
                          send(`[CONFIRMATION_EVENT] The user confirmed and signed the payroll run for "${ev.group}". It executed successfully on-chain. Transaction hash: ${detail}.`, true);
                        } else if (outcome === 'declined') {
                          send(`[CONFIRMATION_EVENT] The user declined the proposed payroll run for "${ev.group}". Do not propose it again unless they ask.`, true);
                        } else {
                          send(`[CONFIRMATION_EVENT] The payroll run for "${ev.group}" failed before confirmation: ${detail}.`, true);
                        }
                      }}
                    />
                  );
                }

                if (ev.type === 'schedule_payment_request' && ev.group && ev.whenMs) {
                  if (expired) return <ExpiredCard key={i} label="scheduled payment" />;
                  return (
                    <ScheduleConfirmationCard
                      key={i}
                      group={ev.group}
                      token={ev.token ?? 'USDC'}
                      whenMs={ev.whenMs}
                      walletAddress={walletAddress}
                      sessionToken={sessionTokenRef.current ?? undefined}
                      autoConfirm={ev.autoConfirm}
                      onResolved={(outcome, detail) => {
                        markEventResolved(m.id, i);
                        if (outcome === 'confirmed') {
                          onDataChanged?.();
                          send(`[CONFIRMATION_EVENT] The user confirmed the scheduled payment for "${ev.group}". It has been saved and will run automatically at the scheduled time.`, true);
                        } else if (outcome === 'declined') {
                          send(`[CONFIRMATION_EVENT] The user declined the proposed scheduled payment for "${ev.group}". Do not propose it again unless they ask.`, true);
                        } else {
                          send(`[CONFIRMATION_EVENT] Saving the scheduled payment for "${ev.group}" failed: ${detail}.`, true);
                        }
                      }}
                    />
                  );
                }

                if (ev.type === 'cancel_schedule_request' && ev.scheduleId) {
                  if (expired) return <ExpiredCard key={i} label="schedule cancellation" />;
                  return (
                    <CancelScheduleCard
                      key={i}
                      scheduleId={ev.scheduleId}
                      label={ev.label ?? 'this scheduled payment'}
                      walletAddress={walletAddress}
                      sessionToken={sessionTokenRef.current ?? undefined}
                      autoConfirm={ev.autoConfirm}
                      onResolved={(outcome, detail) => {
                        markEventResolved(m.id, i);
                        if (outcome === 'confirmed') {
                          onDataChanged?.();
                          send(`[CONFIRMATION_EVENT] The user confirmed cancelling "${ev.label}". It has been cancelled and will no longer run.`, true);
                        } else if (outcome === 'declined') {
                          send(`[CONFIRMATION_EVENT] The user declined cancelling "${ev.label}". Leave it as-is unless they ask again.`, true);
                        } else {
                          send(`[CONFIRMATION_EVENT] Cancelling "${ev.label}" failed: ${detail}.`, true);
                        }
                      }}
                    />
                  );
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
          {pendingAttachment.previewUrl ? (
            <img src={pendingAttachment.previewUrl} alt="Attached file preview" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 8, border: '1px solid #E2E8F0' }} />
          ) : (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
              borderRadius: 8, border: '1px solid #E2E8F0', background: '#F8FAFC',
              maxWidth: 220, overflow: 'hidden',
            }}>
              <FileText size={16} color="#4F46E5" style={{ flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: '#334155', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {pendingAttachment.fileName}
              </span>
            </div>
          )}
          <button onClick={clearAttachment} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: 12, marginLeft: 'auto' }}>Remove</button>
        </div>
      )}

      {/* Input */}
      <div style={{ padding: '12px 16px', background: '#FFF', borderTop: '1px solid #E2E8F0', display: 'flex', gap: 10, alignItems: 'flex-end', flexShrink: 0 }}>
        <input
          ref={fileInputRef}
          type="file"
          // No image MIME types here anymore at all — the previous gallery-
          // jump issue was specifically caused by an image-only accept list
          // making mobile browsers treat this as a photo picker. With only
          // document/code/data types now, there's nothing for the OS to
          // read as "this wants a photo," so it should show the normal
          // file browser instead. Both MIME types and extensions are
          // listed for the same reason as before: some extensions
          // (.ts/.tsx/.jsx especially) don't have a standardized MIME type
          // and are inconsistently reported by different browsers/OSes.
          accept="application/pdf,.pdf,text/csv,.csv,application/json,.json,text/markdown,.md,text/plain,.txt,.js,.jsx,.ts,.tsx"
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
          className="salden-chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Chat Agent"
          rows={1}
          disabled={isLoading || isBlocked}
          style={{ flex: 1, resize: 'none', border: '1px solid #E2E8F0', borderRadius: 12, padding: '11px 16px', fontSize: 14, fontFamily: 'inherit', color: '#0F172A', outline: 'none', background: isBlocked ? '#F8F9FA' : '#F8FAFC', lineHeight: 1.5, maxHeight: 200, transition: 'border-color 0.15s, background 0.15s' }}
        />
        <button
          onClick={() => { const att = pendingAttachment ? { mimeType: pendingAttachment.mimeType, data: pendingAttachment.data, fileName: pendingAttachment.fileName } : undefined; send(input, false, att); clearAttachment(); }}
          disabled={isLoading || (!input.trim() && !pendingAttachment) || isBlocked}
          style={{ width: 40, height: 40, borderRadius: 10, background: isLoading || (!input.trim() && !pendingAttachment) || isBlocked ? '#E2E8F0' : '#14B8A6', border: 'none', cursor: isLoading || (!input.trim() && !pendingAttachment) || isBlocked ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={isLoading || (!input.trim() && !pendingAttachment) || isBlocked ? '#94A3B8' : '#fff'} strokeWidth="2.5">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
      <div style={{ textAlign: 'center', fontSize: 10, color: '#CBD5E1', padding: '4px 0 8px', background: '#FFF' }}>
        Tap the send button to send · Enter for a new line
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
