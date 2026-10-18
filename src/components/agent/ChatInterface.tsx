'use client';
/**
 * @file components/agent/ChatInterface.tsx
 *
 * Full chat interface for the Salden AI Payroll Agent.
 *
 * REWRITTEN for the function-calling chat route (no more SSE / regex
 * markers). Key changes from the previous version:
 *
 *   - Single fetch + json() per turn, the route no longer streams, since
 *     the function-calling loop is inherently multi-round and non-streaming
 *     server-side. Trade-off: no token-by-token typing effect anymore;
 *     gained: tool calls can't be corrupted by truncation mid-marker.
 *   - Session auth, every request now carries a signed bearer token via
 *     useAgentSession(), obtained by signing a one-time message with the
 *     connected wallet. Requires a WalletClient.
 *   - `actionLog` is now a real array returned by the server, generated
 *     from tool calls actually executed, not parsed from model text.
 *   - `events` is an array of structured proposals (faucet, unlisted
 *     payment, add employee, payroll run), rendered as real confirmation
 *     cards, each with its own expiry and idempotency guard.
 *   - `rateLimited` and `truncated` flags surfaced from the server.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { FileText } from 'lucide-react';
import { useUniversalWrite } from '@/lib/circle/useUniversalWrite';
import { useApp }    from '@/context/AppContext';
import ChatMessage   from '@/components/agent/ChatMessage';
import { IrisBrand } from '@/components/agent/IrisBrand';
import { useAgentSession } from '@/lib/agent/useAgentSession';
import { generateSessionId, loadSessionMessages, saveSession } from '@/lib/chatSessions';
import { saveAgentLog } from '@/lib/db/indexeddb';
import { friendlyErrorMessage } from '@/lib/errorMessage';
import { txLink } from '@/lib/contracts/config';
import { isCircleTxTerminal, isCircleTxSuccess } from '@/lib/circle/txState';
import type { PayrollSyncStatus } from '@/lib/usePayrollSync';
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
  /** Circle's own transaction id, present only when status is 'QUEUED', *  lets the polling effect below check /api/agent/tx-status and update
   *  this exact entry once the transaction actually resolves, instead of
   *  it staying "QUEUED" forever even after it's confirmed on-chain. */
  pendingTxId?: string;
}

interface AgentEvent {
  type: 'unlisted_payment_request' | 'add_employee_request' | 'payroll_run_request'
      | 'agent_executed_payment' | 'agent_executed_payroll_run'
      | 'edit_employee_request' | 'edit_employee_immediate' | 'remove_employee_request'
      | 'bulk_add_employees_request' | 'bulk_add_employees_immediate'
      | 'schedule_payment_request' | 'cancel_schedule_request';
  address?: string; amount?: string; token?: string;
  fullName?: string; department?: string; group?: string; salary?: string;
  txHash?: string; pending?: boolean; recipients?: number; totalAmount?: string;
  currentAddress?: string; newAddress?: string;
  employeesJson?: string; skippedCount?: number;
  /** schedule_payment_request only, epoch ms for when the one-time
   *  payment should run. */
  whenMs?: number;
  /** cancel_schedule_request only, the schedule's id and human-readable
   *  label (from get_schedules), so the card can show exactly what's
   *  about to be cancelled without a second round trip. */
  scheduleId?: string; label?: string;
  /** Circle's own transaction id for a pending agent_executed_* event, *  same purpose as ActionLogEntry.pendingTxId above. */
  transactionId?: string;
  /** Set by the server (see tools.ts's propose_* schemas and chat/route.ts)
   *  when the model judged the instruction fully explicit, the matching
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
   *  this turn, never rendered, only round-tripped back to the server on
   *  the next request so it can rebuild history with the thought
   *  signature Gemini 3.x requires. See app/api/agent/chat/route.ts's
   *  buildHistory() for the full explanation. Without this, tool calling
   *  works once per conversation and then breaks. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawParts?: any[];
  /** Only set on user messages that included a file, metadata only (name
   *  + type), not the file content itself, purely so the chat log shows
   *  what was actually sent instead of the attachment vanishing the
   *  moment the message is sent. */
  attachment?: { fileName: string; mimeType: string };
}

interface ChatInterfaceProps {
  walletAddress:  string;
  onDataChanged?: () => void;
  /** Real agent wallet address and active status from useAgentStatus() in the
   *  parent page, previously this component hardcoded agentActive: true and
   *  agentAddress: undefined, which meant the AI was always told the agent was
   *  "active" with no wallet, and get_balance/request_faucet for the agent
   *  wallet could never resolve a target address. */
  agentAddress?:  string;
  agentActive?:   boolean;
  /** Circle wallet ID for the agent, required for autonomous execution
   *  (execute_payment/execute_payroll_run) since Circle's contract-execution
   *  API signs by walletId, not by address. */
  agentWalletId?: string;
  /** Resume a previously-saved conversation (from /ai-agent?session=<id>,
   *  see chat-history/page.tsx). Omit for a fresh conversation. */
  sessionId?:     string;
  /** usePayrollSync's status from the parent page, the authoritative
   *  signal for whether state.employees (and payrollSetup) actually
   *  reflect this wallet's real, fully-hydrated data yet, as opposed to
   *  still being mid-load or empty because loading hasn't started.
   *  Threaded down to confirmation cards that read state.employees at
   *  confirm-time (add/edit employee, payroll run, schedule payment) so
   *  they can wait for a genuine "settled" signal instead of each
   *  guessing independently, see AgentConfirmationCards.tsx's
   *  hydrationStatus comments for the full reasoning and why a plain
   *  employees.length check or a fixed timeout isn't reliable enough on
   *  its own. Optional and defaults to treating hydration as settled if
   *  omitted, so nothing regresses for any caller that doesn't pass it. */
  hydrationStatus?: PayrollSyncStatus;
}

const API_BASE       = process.env.NEXT_PUBLIC_API_URL ?? '/api';
const MAX_CONV_MSGS  = 40;
const WARN_CONV_AT   = 25;
const CARD_TTL_MS    = 10 * 60 * 1000; // confirmation cards expire after 10 minutes

// Mirrors FREE_MESSAGE_LIMIT in lib/agent/tier.ts (SERVER ONLY, not
// importable from a client component). Display label only, the real
// enforcement and the real count live entirely server-side; this is never
// used to decide whether to lock, only how to word the locked message.
const FREE_TIER_LIMIT_LABEL = 5;

// How long the client waits for a response before giving up and showing
// "Network error" itself, rather than leaving the composer spinning for
// however long the request actually takes. Kept comfortably under
// /api/agent/chat's own `maxDuration = 60` export so this always fires
// first, the server-side budget is a last resort, not the normal path.
const AGENT_REQUEST_TIMEOUT_MS = 25_000;

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
  ];

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatRetryWait(seconds: number | null): string {
  if (!seconds || seconds <= 0) return 'shortly';
  const hrs  = Math.floor(seconds / 3600);
  const mins = Math.ceil((seconds % 3600) / 60);
  if (hrs <= 0) return `${mins} minute${mins === 1 ? '' : 's'}`;
  if (mins <= 0) return `${hrs} hour${hrs === 1 ? '' : 's'}`;
  return `${hrs} hour${hrs === 1 ? '' : 's'} ${mins} minute${mins === 1 ? '' : 's'}`;
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

// (ActionLogCard removed, these entries are now persisted to the Manage
// Agent page's log store instead of rendered inline in chat. See the
// persistence effect inside ChatInterface below.)

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

/**
 * Reads the chat route's status stream. Status lines update the thinking line
 * as the agent works; the final result line is turned back into an ordinary
 * JSON Response, so the rest of the send flow (401 retry, errors, replies) is
 * unchanged. Non-stream responses pass through untouched.
 */
async function normaliseAgentResponse(res: Response, onStatus: (text: string) => void): Promise<Response> {
  if (!res.headers.get('content-type')?.includes('application/x-ndjson') || !res.body) return res;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: { status: number; body: unknown } | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const event = JSON.parse(line) as { type: string; text?: string; status?: number; body?: unknown };
      if (event.type === 'status' && event.text) onStatus(event.text);
      if (event.type === 'result') result = { status: event.status ?? 500, body: event.body };
    }
  }
  if (!result) return new Response(JSON.stringify({ error: 'Request failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  const final = result as { status: number; body: unknown };
  return new Response(JSON.stringify(final.body), { status: final.status, headers: { 'Content-Type': 'application/json' } });
}

export default function ChatInterface({ walletAddress, onDataChanged, agentAddress, agentActive, agentWalletId, sessionId, hydrationStatus }: ChatInterfaceProps) {
  const [agentStatus, setAgentStatus] = useState('');
  const [upgradeNeeded, setUpgradeNeeded] = useState(false);
  /** Full free-tier lockout (distinct from upgradeNeeded, which only means
   *  "the last message asked for a tool action and this wallet is free").
   *  This is set from the server's own count, both on mount (via the quota
   *  check below, so a refresh or a brand-new chat shows the lock
   *  immediately, before any message is even typed) and from freeLimitReached
   *  on a chat response, so it can never be cleared by anything client-side,
   *  only by the server-side window actually rolling over. */
  const [freeLimitLocked, setFreeLimitLocked] = useState(false);
  const [freeLimitRetryAfter, setFreeLimitRetryAfter] = useState<number | null>(null);
  // Only ever set for free-tier wallets, the server omits this field
  // entirely for Pro wallets, see app/api/agent/chat/route.ts. Doubles as
  // the client's own "are we free tier" signal, no separate prop needed.
  const [freeMessagesRemaining, setFreeMessagesRemaining] = useState<number | null>(null);
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
  // every `messages`/`isLoading` change, including background updates like
  // the tx-status poller's silent setMessages calls, which yanked the view
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

  // Server-authoritative free-tier lock check. Runs on mount and whenever
  // the wallet changes, so a refresh or opening a brand-new chat shows the
  // lockout immediately, from the server's own count, instead of briefly
  // (or indefinitely) rendering an unlocked composer that only turns out to
  // be blocked once a message is actually sent. Deliberately NOT gated on
  // anything in localStorage/sessionStorage: those are client state and
  // would make the lock trivially clearable by clearing storage. Pro
  // wallets never see this (the endpoint reports freeLimitReached: false
  // for them without even reading the quota).
  useEffect(() => {
    let cancelled = false;
    if (!walletAddress) return;
    (async () => {
      try {
        const token = await getToken(walletAddress, universalSignMessage);
        const res = await fetch(`${API_BASE}/agent/quota?walletAddress=${encodeURIComponent(walletAddress)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok || cancelled) return;
        const data = await res.json() as { freeLimitReached?: boolean; retryAfterSeconds?: number; remaining?: number; pro?: boolean };
        if (cancelled) return;
        if (data.freeLimitReached) {
          setFreeLimitLocked(true);
          setFreeLimitRetryAfter(data.retryAfterSeconds ?? null);
        }
        if (!data.pro && typeof data.remaining === 'number') {
          setFreeMessagesRemaining(data.remaining);
        }
      } catch {
        // Fails open here deliberately, same reasoning as the quota route
        // itself: a failed check just means the lock banner doesn't show
        // pre-emptively, the real gate on /api/agent/chat still applies.
      }
    })();
    return () => { cancelled = true; };
  }, [walletAddress, getToken, universalSignMessage]);
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
  // to go out, a transaction that hadn't confirmed by then comes back
  // marked QUEUED/pending with nothing ever checking it again afterward,
  // even once it confirms moments later. This scans for any unresolved
  // pendingTxId/transactionId still in the conversation and keeps checking
  // /api/agent/tx-status until each one resolves, then updates that exact
  // action-log line and event card in place, no page refresh needed.
  //
  // Deliberately reuses sessionTokenRef.current (already obtained by the
  // request that produced the pending transaction) rather than calling
  // getToken() itself, this must never trigger a fresh sign-message
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
      if (!token) return; // no signed session yet, wait for the next interval rather than prompting

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
                  detail: resolvedStatus === 'FAILED' ? 'Transaction reverted on-chain, no funds moved.' : l.detail
                }
              : l),
            events: m.events?.map(e => e.transactionId === txId
              ? { ...e, pending: false, txHash: data.txHash ?? e.txHash }
              : e),
          })));
          if (resolvedStatus === 'SUCCESS') onDataChanged?.();
        } catch { /* network blip, retry on the next interval */ }
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
  // QUEUED and only resolve later, either via the tx-status poller just
  // above, or via one of the confirmation cards' own onResolved handlers
  // (FaucetResultCard, AddEmployeeCard, PayrollRunCard, etc.), without
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
        if (entry.status === 'QUEUED') return; // not final yet, wait for it to resolve
        const key = `${m.id}:${i}`;
        if (persistedLogKeysRef.current.has(key)) return;
        persistedLogKeysRef.current.add(key);

        // Best-effort tx-hash attachment: when this turn produced exactly
        // one event that already resolved to a txHash, pair it with a
        // SUCCESS entry, covers the common single-action-per-turn case.
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
  // inlineData, same mechanism as images, just a different MIME type.
  // Everything else here is plain text (code files, CSV, JSON, Markdown)
  // no special "document understanding" needed, it's just extracted as
  // text and included in the prompt like any other text.
  //
  // Deliberately NOT included: .doc/.docx. Per Google's own Gemini API
  // docs (ai.google.dev/gemini-api/docs/document-processing): "document
  // vision only meaningfully understands PDFs." Broader Office-format
  // support (DOCX, XLSX, PPTX) exists in Google's own Workspace apps,
  // which silently convert those files with Google's internal Docs/Sheets
  // converters before the model ever sees them, that conversion isn't
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
  // Extensions the OS file picker should filter to, belt-and-suspenders
  // alongside the MIME check above, since some browsers report an empty
  // or generic `file.type` for less common extensions (.ts/.tsx/.jsx in
  // particular are inconsistently recognized).
  const ALLOWED_ATTACHMENT_EXTENSIONS = ['.pdf', '.csv', '.js', '.jsx', '.ts', '.tsx', '.txt', '.json', '.md'];
  const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // matches the server's own limit, reject early with a clear message instead of a vague server error

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
      // that only applies to raster images, which are deliberately not
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
    reader.onerror = () => setAttachError('Could not read that file, please try again.');
    reader.readAsDataURL(file);
  }

  const send = useCallback(async (text: string, silent = false, attachment?: { mimeType: string; data: string; fileName?: string }) => {
    // Silent sends (confirmation events from card callbacks) must never be
    // dropped by the isLoading guard, the AI needs to know what happened.
    if ((!text.trim() && !attachment) || (isLoading && !silent)) return;
    // Belt-and-suspenders: the composer is hidden while locked, but a silent
    // send (card callback) bypasses the composer entirely, so re-check here
    // too. The server re-checks independently regardless; this just avoids
    // a wasted round trip once the client already knows it's locked.
    if (freeLimitLocked) return;

    const currentCount = getDailyCount();
    if (currentCount >= DAILY_BLOCK_AT) {
      setError(`Daily AI request limit almost reached (${currentCount}/${DAILY_LIMIT}). Resets at midnight UTC.`);
      return;
    }
    if (!canWrite) {
      setError('Wallet not connected, cannot start a secure agent session.');
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
    setAgentStatus('');
    setError(null);

    const allMessages = [
      ...messages.map(m => ({ role: m.role, content: m.content, rawParts: m.rawParts })),
      { role: 'user', content: effectiveText },
    ];

    // tokenRegistry (from AppContext) is a Record<address, { symbol, decimals, ... }>
    // the server's parseTokenRegistry() JSON.parse()s this string to build the
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
        // compute per-employee amounts. Every payroll action, proposed or
        // autonomous, is handled entirely within the chat interface; the
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
      // confirming on-chain, see the matching comment on the server side
      // in app/api/agent/chat/route.ts.
      receiptEmail:  payrollSetup?.email || undefined,
    };

    // BUG FIX: previously nothing ever cut this request short client-side.
    // A slow-but-not-erroring response (the model just taking a long time,
    // a stuck tool round, etc.) would leave the composer spinning for the
    // full duration of whatever the server allows (maxDuration = 60s on
    // /api/agent/chat) before the person saw anything at all, no matter how
    // long that felt. This aborts the attempt well under that server-side
    // budget and surfaces the same "Network error" message used for an
    // actual dropped connection, the person doesn't need to know which one
    // happened, just that it didn't work and they can try again.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AGENT_REQUEST_TIMEOUT_MS);

    try {
      let token = await getToken(walletAddress, universalSignMessage);
      sessionTokenRef.current = token;

      let res = await fetch(`${API_BASE}/agent/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'x-agent-stream': '1' },
        body: JSON.stringify({ messages: allMessages, walletAddress, context, attachment }),
        signal: controller.signal,
      });

      // Session expired mid-flight, refresh once and retry.
      res = await normaliseAgentResponse(res, setAgentStatus);
      if (res.status === 401) {
        invalidate(walletAddress);
        token = await getToken(walletAddress, universalSignMessage, true);
        sessionTokenRef.current = token;
        res = await fetch(`${API_BASE}/agent/chat`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'x-agent-stream': '1' },
          body: JSON.stringify({ messages: allMessages, walletAddress, context, attachment }),
          signal: controller.signal,
        });
      }

      res = await normaliseAgentResponse(res, setAgentStatus);
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: 'Request failed' })) as { error?: string };
        throw new Error(errBody.error ?? 'Request failed');
      }

      const data = await res.json() as {
        response?: string; actionLog?: ActionLogEntry[]; events?: AgentEvent[];
        truncated?: boolean; rateLimited?: boolean; cached?: boolean;
        upgradeRequired?: boolean; freeLimitReached?: boolean; retryAfterSeconds?: number;
        freeMessagesRemaining?: number;
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
      // freeLimitReached is the real, fully-enforced lockout (the free
      // message quota is actually exhausted for this wallet/window): hide
      // the composer entirely, see the render below. A bare upgradeRequired
      // with no freeLimitReached just means the last message asked for a
      // tool action on a free wallet, chat is still available, only the
      // lighter banner shows for that.
      if (data.freeLimitReached) {
        setFreeLimitLocked(true);
        setFreeLimitRetryAfter(data.retryAfterSeconds ?? null);
      } else if (data.upgradeRequired) {
        setUpgradeNeeded(true);
      }
      if (typeof data.freeMessagesRemaining === 'number') {
        setFreeMessagesRemaining(data.freeMessagesRemaining);
      }

      if (!data.rateLimited && !data.cached) {
        setDailyCount(incrementDailyCount());
      }
      if (data.actionLog?.some(l => l.status === 'SUCCESS')) onDataChanged?.();

    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : '';
      const msg = (err instanceof DOMException && err.name === 'AbortError')
        // Our own timeout above, or the person navigating away mid-request.
        // Same wording as an actual dropped connection, deliberately, see
        // the comment on AGENT_REQUEST_TIMEOUT_MS.
        ? 'Network error. Check your connection and try again.'
        : /session|sign in|401/i.test(raw)
        ? 'Session expired, please sign in again.'
        : /wallet|connect/i.test(raw)
        ? 'Wallet not connected. Please reconnect and try again.'
        : /network|fetch/i.test(raw)
        ? 'Network error. Check your connection and try again.'
        // BUG FIX: this used to fall through to a hardcoded generic
        // string for anything that didn't match one of the three patterns
        // above, silently discarding the server's own specific
        // already-friendly message (e.g. "I'm getting rate-limited right
        // now, please wait about a minute and try again.") and showing
        // the same unhelpful "Something went wrong" for every distinct
        // failure. `raw` here is our own controlled text from the server's
        // `error` field, never a raw exception dump, safe to show as-is;
        // friendlyErrorMessage() is a defensive backstop in case it's ever
        // something unexpectedly long.
        : friendlyErrorMessage(err, 'Something went wrong. Please try again.');
      setError(msg);
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(), role: 'assistant',
        content: msg, timestamp: nowTime(), proposedAt: Date.now(),
      }]);
    } finally {
      clearTimeout(timeoutId);
      setIsLoading(false);
    }
  }, [messages, isLoading, walletAddress, canWrite, universalSignMessage, employees, onDataChanged, getToken, invalidate, freeLimitLocked]);

  const markEventResolved = useCallback((messageId: string, index: number) => {
    setMessages(prev => prev.map(m => {
      if (m.id !== messageId || !m.eventsResolved) return m;
      const next = [...m.eventsResolved];
      next[index] = true;
      return { ...m, eventsResolved: next };
    }));
  }, []);

  // Enter used to send (Shift+Enter for a newline), on a phone's virtual
  // keyboard, the Enter/Go key has no reliable way to combine with Shift,
  // so every Enter press sent whatever had been typed so far mid-thought.
  // Enter now always just inserts a newline; the Send button is the only
  // way to send, on every device.
  const onKeyDown = (_e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Intentionally a no-op, let the textarea's default Enter behaviour
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
      {/* New-chat control, only shown once there's a conversation to reset */}
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
          <span>Long conversation, older context may be summarised.</span>
          <button onClick={resetConversation} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#14B8A6', fontWeight: 700, fontSize: 12, fontFamily: 'inherit' }}>Start fresh</button>
        </div>
      )}

      {/* Tool-access-only notice: the wallet is free and the last message
       *  asked for an action (pay, schedule, edit, etc). Chat itself is
       *  still available, this is NOT the full lockout, see freeLimitLocked
       *  below for that, rendered in place of the composer instead. */}
      {upgradeNeeded && !freeLimitLocked && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 10,
          padding: '10px 14px', margin: '8px 16px 0', fontSize: 13,
        }}>
          <span style={{ color: '#4338CA', fontWeight: 600 }}>
            That action requires Salden Pro. You can keep chatting on the free plan.
          </span>
          <a href="/pricing" style={{
            padding: '6px 14px', borderRadius: 8, background: '#4F46E5', color: '#fff',
            fontWeight: 700, fontSize: 13, textDecoration: 'none', whiteSpace: 'nowrap',
          }}>Upgrade</a>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollContainerRef} onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', padding: '20px 16px' }}>
        {messages.length === 0 && (
          // IRIS empty state: glowing, animated backdrop behind the IRIS
          // brand mark (spinning avatar + wordmark). Unmounts as soon as
          // the first message is sent, which returns the chat to a plain
          // white background. A new chat starts empty again.
          <div style={{
            position: 'relative', minHeight: '100%', display: 'flex',
            alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderRadius: 16,
          }}>
            <div aria-hidden className="iris-bg-glow" style={{ position: 'absolute', inset: 0, zIndex: 0 }} />
            <div style={{ position: 'relative', zIndex: 1, textAlign: 'center', padding: '48px 16px' }}>
              <IrisBrand size="lg" showTagline />
            </div>
            <style>{`
              .iris-bg-glow {
                background:
                  radial-gradient(circle at 20% 30%, rgba(79,70,229,0.45), transparent 45%)
                  radial-gradient(circle at 80% 70%, rgba(20,184,166,0.42), transparent 45%)
                  radial-gradient(circle at 55% 15%, rgba(199,210,254,0.6), transparent 50%)
                  radial-gradient(circle at 40% 85%, rgba(20,184,166,0.22), transparent 50%);
                background-size: 180% 180%;
                filter: blur(36px) saturate(1.2);
                animation: irisBgDrift 14s ease-in-out infinite, irisBgPulse 6s ease-in-out infinite;
              }
              @keyframes irisBgDrift {
                0%, 100% { background-position: 0% 0%; }
                50%      { background-position: 100% 100%; }
              }
              @keyframes irisBgPulse {
                0%, 100% { opacity: 0.85; }
                50%      { opacity: 1; }
              }
              @media (prefers-reduced-motion: reduce) {
                .iris-bg-glow { animation: none; }
              }
            `}</style>
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
              {/* actionLog is no longer rendered inline, see the persistence
                  effect above, which sends finalized entries to the Manage
                  Agent page's log store instead. */}

              {m.role === 'assistant' && m.events?.map((ev, i) => {
                const resolved = m.eventsResolved?.[i];
                if (resolved) return null; // outcome already reported via its own card transition

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
                      hydrationStatus={hydrationStatus}
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
                      hydrationStatus={hydrationStatus}
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
                      hydrationStatus={hydrationStatus}
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
                      hydrationStatus={hydrationStatus}
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
                      hydrationStatus={hydrationStatus}
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
                      {ev.pending ? ', still confirming on-chain.' : '.'}
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
                      <strong>Agent ran payroll for &quot;{ev.group}&quot;</strong>, {ev.recipients} employee{ev.recipients === 1 ? '' : 's'}, {ev.totalAmount} USDC
                      {ev.pending ? ', still confirming on-chain.' : '.'}
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

        {isLoading && <ChatMessage role="assistant" content="" isLoading thinkingText={[...messages].reverse().find(m => m.role === "user")?.content ?? ""} agentStatus={agentStatus} />}
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

      {/* Input, or — once the free-tier quota is actually exhausted for this
       *  wallet (server-confirmed, see freeLimitLocked above) — the timeout
       *  message in the exact same position instead. The upload icon, text
       *  field and send icon are not just disabled here, they're removed
       *  from the tree entirely, so there's nothing left to interact with. */}
      {freeLimitLocked ? (
        <div style={{ padding: '14px 16px', background: '#FEF2F2', borderTop: '1px solid #FECACA', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ color: '#991B1B', fontWeight: 600, fontSize: 13 }}>
              You&apos;ve reached your free usage limit ({FREE_TIER_LIMIT_LABEL} messages). Come back in {formatRetryWait(freeLimitRetryAfter)}, or upgrade to Salden Pro for unlimited messages and full agent actions.
            </span>
            <a href="/pricing" style={{
              padding: '6px 14px', borderRadius: 8, background: '#4F46E5', color: '#fff',
              fontWeight: 700, fontSize: 13, textDecoration: 'none', whiteSpace: 'nowrap',
            }}>Upgrade</a>
          </div>
        </div>
      ) : (
        <>
          <div style={{ padding: '12px 16px', background: '#FFF', borderTop: '1px solid #E2E8F0', display: 'flex', gap: 10, alignItems: 'flex-end', flexShrink: 0 }}>
            <input
              ref={fileInputRef}
              type="file"
              // No image MIME types here anymore at all, the previous gallery-
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
            {/* Only ever set for free-tier wallets (see state declaration),
               and only shown once it's getting low, this used to give no
               warning at all before the composer just disappeared. */}
            {freeMessagesRemaining !== null && freeMessagesRemaining <= 2 && (
              <span style={{ color: '#D97706', fontWeight: 600 }}>
                {' '}· {freeMessagesRemaining} free message{freeMessagesRemaining === 1 ? '' : 's'} left
              </span>
            )}
          </div>
        </>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
