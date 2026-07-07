'use client';
/**
 * @file app/ai-agent/chat-history/page.tsx
 * Lists saved AI Agent chat sessions from IndexedDB.
 * Tapping a session navigates to /ai-agent?session=<id>
 */

import { useState, useEffect } from 'react';
import { useRouter }           from 'next/navigation';
import {
  MessageSquare, Clock, Trash2, Loader2, PlusCircle,
} from 'lucide-react';
import { AgentLayout }         from '@/components/agent/AgentLayout';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { format }              from 'date-fns';

interface ChatSession {
  id:        string;
  title:     string;
  preview:   string;
  timestamp: number;
  msgCount:  number;
}

const SESSION_KEY = (addr: string) => `salden_agent_sessions_${addr.toLowerCase()}`;

export default function ChatHistoryPage() {
  const router       = useRouter();
  const { address }  = useEffectiveAddress();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    if (!address) { setLoading(false); return; }
    try {
      const raw = localStorage.getItem(SESSION_KEY(address));
      if (raw) {
        const parsed = (JSON.parse(raw) as ChatSession[])
          .sort((a, b) => b.timestamp - a.timestamp);
        setSessions(parsed);
      }
    } catch { /* empty */ }
    setLoading(false);
  }, [address]);

  function openSession(id: string) {
    router.push(`/ai-agent?session=${id}`);
  }

  function deleteSession(id: string) {
    setDeleting(id);
    try {
      const next = sessions.filter(s => s.id !== id);
      setSessions(next);
      if (address) {
        localStorage.setItem(SESSION_KEY(address), JSON.stringify(next));
      }
    } finally { setDeleting(null); }
  }

  return (
    <AgentLayout title="Chat History">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', marginBottom: 4 }}>Chat History</h2>
            <p style={{ fontSize: 13, color: '#64748B' }}>All previous AI Agent conversations.</p>
          </div>
          <button
            onClick={() => router.push('/ai-agent?new=' + Date.now())}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '9px 16px', borderRadius: 10,
              background: '#4F46E5', border: 'none',
              color: '#fff', fontSize: 13, fontWeight: 700,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <PlusCircle size={14} /> New Chat
          </button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Loader2 size={28} color="#4F46E5" style={{ animation: 'spin 0.7s linear infinite', margin: '0 auto' }} />
          </div>
        ) : sessions.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: '60px 20px',
            background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16,
          }}>
            <MessageSquare size={40} color="#E2E8F0" style={{ margin: '0 auto 16px' }} />
            <h3 style={{ fontSize: 16, fontWeight: 700, color: '#0F172A', marginBottom: 8 }}>No chats yet</h3>
            <p style={{ fontSize: 13, color: '#64748B' }}>
              Start a conversation with your AI Agent and it will appear here.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {sessions.map(session => (
              <div
                key={session.id}
                style={{
                  background: '#fff', border: '1px solid #E2E8F0',
                  borderRadius: 14, padding: '16px 18px',
                  display: 'flex', alignItems: 'center', gap: 14,
                  cursor: 'pointer', transition: 'border-color 0.15s',
                }}
                onClick={() => openSession(session.id)}
                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor = '#4F46E5'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = '#E2E8F0'; }}
              >
                {/* Icon */}
                <div style={{
                  width: 40, height: 40, borderRadius: 12, flexShrink: 0,
                  background: '#EEF2FF',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <MessageSquare size={18} color="#4F46E5" />
                </div>

                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 3 }}>
                    {session.title || 'Untitled chat'}
                  </div>
                  <div style={{ fontSize: 12, color: '#94A3B8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {session.preview}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 4 }}>
                    <Clock size={11} color="#94A3B8" />
                    <span style={{ fontSize: 11, color: '#94A3B8' }}>
                      {format(new Date(session.timestamp), 'dd MMM yyyy · HH:mm')}
                    </span>
                    <span style={{ fontSize: 11, color: '#CBD5E1' }}>·</span>
                    <span style={{ fontSize: 11, color: '#94A3B8' }}>{session.msgCount} messages</span>
                  </div>
                </div>

                {/* Delete */}
                <button
                  onClick={e => { e.stopPropagation(); deleteSession(session.id); }}
                  disabled={deleting === session.id}
                  style={{
                    flexShrink: 0, background: 'none', border: 'none',
                    cursor: 'pointer', color: '#CBD5E1', padding: 6, borderRadius: 8,
                    display: 'flex', alignItems: 'center',
                    transition: 'color 0.12s',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#DC2626'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#CBD5E1'; }}
                >
                  {deleting === session.id
                    ? <Loader2 size={15} style={{ animation: 'spin 0.7s linear infinite' }} />
                    : <Trash2 size={15} />
                  }
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </AgentLayout>
  );
}
