/**
 * @file lib/chatSessions.ts
 * Local persistence for AI Agent chat sessions. This is the write side that
 * was previously missing entirely — chat-history/page.tsx already reads
 * from `salden_agent_sessions_${addr}` (the metadata list) but nothing ever
 * wrote to it, so the page always showed "No chats yet". This file is the
 * single source of truth for the storage key/shape so ChatInterface.tsx
 * (writer) and chat-history/page.tsx (reader) never drift apart.
 *
 * Two kinds of storage:
 *  - `salden_agent_sessions_${addr}`      -> ChatSessionMeta[]  (the list)
 *  - `salden_agent_session_${addr}_${id}` -> full Message[] for that session
 *
 * Everything here is best-effort: a localStorage failure (quota, private
 * browsing, disabled storage) must never break the chat itself, so every
 * function swallows its own errors rather than throwing.
 */

export interface ChatSessionMeta {
  id:        string;
  title:     string;
  preview:   string;
  timestamp: number;
  msgCount:  number;
}

// Keep in sync with chat-history/page.tsx's own SESSION_KEY — duplicated
// there rather than imported to avoid a circular/coupling dependency on a
// client page from a lib file; both must produce the identical key format.
const metaKey    = (addr: string) => `salden_agent_sessions_${addr.toLowerCase()}`;
const messagesKey = (addr: string, id: string) => `salden_agent_session_${addr.toLowerCase()}_${id}`;

const MAX_SESSIONS = 50; // prevent unbounded localStorage growth over long-term use

export function generateSessionId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // crypto.randomUUID() requires a secure context — fall back for older/
    // non-HTTPS environments rather than crashing session creation.
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function loadSessionMessages<T>(walletAddress: string, sessionId: string): T[] | null {
  if (!walletAddress || !sessionId) return null;
  try {
    const raw = localStorage.getItem(messagesKey(walletAddress, sessionId));
    if (!raw) return null;
    return JSON.parse(raw) as T[];
  } catch {
    return null;
  }
}

/**
 * Persist the full message list for a session, and upsert its entry in the
 * metadata list that chat-history/page.tsx reads. `deriveTitle`/`derivePreview`
 * are computed from the messages here rather than passed in, so callers
 * don't need to duplicate that logic.
 */
export function saveSession(
  walletAddress: string,
  sessionId: string,
  messages: Array<{ role: string; content: string }>,
): void {
  if (!walletAddress || !sessionId || messages.length === 0) return;

  try {
    localStorage.setItem(messagesKey(walletAddress, sessionId), JSON.stringify(messages));
  } catch {
    return; // if we can't even write the messages, don't bother touching the metadata list
  }

  try {
    const firstUser = messages.find(m => m.role === 'user');
    const last      = messages[messages.length - 1];
    const title      = (firstUser?.content ?? 'New conversation').slice(0, 60);
    const preview    = (last?.content ?? '').slice(0, 100);

    const raw = localStorage.getItem(metaKey(walletAddress));
    const list: ChatSessionMeta[] = raw ? (JSON.parse(raw) as ChatSessionMeta[]) : [];
    const existingIdx = list.findIndex(s => s.id === sessionId);
    const entry: ChatSessionMeta = { id: sessionId, title, preview, timestamp: Date.now(), msgCount: messages.length };

    if (existingIdx >= 0) list[existingIdx] = entry;
    else list.unshift(entry);

    // Bound growth — drop the oldest sessions (by timestamp) beyond the cap.
    const trimmed = list.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_SESSIONS);
    localStorage.setItem(metaKey(walletAddress), JSON.stringify(trimmed));
  } catch {
    /* metadata list write failed — messages themselves are still saved above */
  }
}
