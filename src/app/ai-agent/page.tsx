'use client';
/**
 * @file app/ai-agent/page.tsx
 *
 * Custom full-screen layout (no AppLayout wrapper):
 *  Top-left   — ArrowLeft  → opens main nav sidebar overlay
 *  Top-center — "AI Agent" title
 *  Top-right  — LayoutGrid → opens bento overlay panel
 *
 * Agent authorization uses addAgent(address) from:
 *  SaldenMultiTokenPayroll (payrollClone)  — onlyOwner
 *  SaldenRegistry (registryClone)          — onlyOwner (hrAdmin)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAccount, useWalletClient, usePublicClient } from 'wagmi';
import {
  Send, User, Loader2, Power, PowerOff,
  Clock, Shield, List, CheckCircle2, AlertTriangle,
  Plus, ArrowLeft, LayoutGrid, Copy, Check,
  X as XIcon, Settings2,
} from 'lucide-react';
import Image from 'next/image';
import { Button } from '@/components/shared/Button';
import { Sidebar } from '@/components/layout/Sidebar';
import { useApp } from '@/context/AppContext';
import { AgentIllustration } from '@/components/shared/Illustrations';
import { getAgentLogs, saveAgentLog, type AgentLog } from '@/lib/db/indexeddb';
import { buildTokenContext } from '@/lib/token-registry';
import { format } from 'date-fns';

// ── addAgent ABI — identical shape on both MultiTokenPayroll and Registry ─────
const ADD_AGENT_ABI = [
  {
    name:            'addAgent',
    type:            'function' as const,
    inputs:          [{ name: 'account', type: 'address' as const }],
    outputs:         [] as const,
    stateMutability: 'nonpayable' as const,
  },
] as const;

// ── isAgent read ABI ───────────────────────────────────────────────────────────
const IS_AGENT_ABI = [
  {
    name:            'isAgent',
    type:            'function' as const,
    inputs:          [{ name: '', type: 'address' as const }],
    outputs:         [{ name: '', type: 'bool' as const }],
    stateMutability: 'view' as const,
  },
] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  id:      string;
  role:    'user' | 'assistant' | 'system';
  content: string;
  ts:      number;
}

interface AgentStatus {
  active:          boolean;
  walletAddress?:  string;
  lastRun?:        number;
  schedules:       number;
}

interface ChatSession {
  id:        string;
  title:     string;
  messages:  Message[];
  createdAt: number;
}

// ── Chat bubble ───────────────────────────────────────────────────────────────

function ChatBubble({ msg }: { msg: Message }) {
  const [copied, setCopied] = useState(false);
  const isUser = msg.role === 'user';
  const isSys  = msg.role === 'system';

  if (isSys) {
    return (
      <div style={{ textAlign: 'center', padding: '6px 0' }}>
        <span style={{ display: 'inline-block', padding: '4px 14px', background: '#F1F5F9', borderRadius: 99, fontSize: 11, color: '#64748B' }}>
          {msg.content}
        </span>
      </div>
    );
  }

  function handleCopy() {
    navigator.clipboard?.writeText(msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div style={{ display: 'flex', flexDirection: isUser ? 'row-reverse' : 'row', alignItems: 'flex-end', gap: 8, marginBottom: 4 }}>
      <div style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0, background: isUser ? '#EEF2FF' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {isUser
          ? <User size={16} color="#4F46E5" />
          : <Image src="/images/ai-avatar.png" alt="Agent" width={32} height={32} style={{ objectFit: 'contain' }} onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
        }
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', maxWidth: '72%', gap: 4, alignItems: isUser ? 'flex-end' : 'flex-start' }}>
        <div style={{
          padding: '12px 16px',
          borderRadius: isUser ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
          background: isUser ? '#4F46E5' : '#fff',
          color:      isUser ? '#fff'    : '#0F172A',
          border:     isUser ? 'none'    : '1px solid #E2E8F0',
          fontSize: 14, lineHeight: 1.65, whiteSpace: 'pre-wrap',
        }}>
          {msg.content}
          <div style={{ fontSize: 10, color: isUser ? 'rgba(255,255,255,0.6)' : '#94A3B8', marginTop: 6, textAlign: isUser ? 'left' : 'right' }}>
            {format(new Date(msg.ts), 'HH:mm')}
          </div>
        </div>

        {!isUser && (
          <button onClick={handleCopy} title="Copy message"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied ? '#14B8A6' : '#94A3B8', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '0 4px', fontFamily: 'inherit' }}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied' : ''}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Typing indicator ──────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginBottom: 4 }}>
      <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <Image src="/images/ai-avatar.png" alt="Agent" width={32} height={32} style={{ objectFit: 'contain' }} onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
      </div>
      <div style={{ padding: '12px 16px', borderRadius: '18px 18px 18px 4px', background: '#fff', border: '1px solid #E2E8F0', display: 'flex', gap: 5, alignItems: 'center' }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: '#94A3B8', animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite` }} />
        ))}
      </div>
    </div>
  );
}

// ── Quick-action bento prompts ────────────────────────────────────────────────

const BENTO_ACTIONS = [
  { label: 'Run payroll now',      prompt: 'Execute the payroll for all active employees now.'         },
  { label: 'Schedule weekly run',  prompt: 'Set up a weekly recurring payroll run for all employees.'  },
  { label: 'Check compliance',     prompt: 'Check compliance status for all employee wallet addresses.' },
  { label: 'List scheduled jobs',  prompt: 'List all scheduled payroll jobs and their next run times.'  },
  { label: 'Pause agent',          prompt: 'Pause all agent activity and scheduled jobs.'               },
  { label: 'Show payment summary', prompt: 'Show a summary of all payments processed this month.'      },
];

function BentoMenu({ onSelect }: { onSelect: (p: string) => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, padding: '12px 16px', borderTop: '1px solid #F1F5F9' }}>
      {BENTO_ACTIONS.map(({ label, prompt }) => (
        <button key={label} onClick={() => onSelect(prompt)}
          style={{ padding: '10px 12px', borderRadius: 10, border: '1.5px solid #E2E8F0', background: '#F8F9FA', fontSize: 12, fontWeight: 500, color: '#475569', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#4F46E5'; (e.currentTarget as HTMLButtonElement).style.background = '#EEF2FF'; (e.currentTarget as HTMLButtonElement).style.color = '#4F46E5'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#E2E8F0'; (e.currentTarget as HTMLButtonElement).style.background = '#F8F9FA'; (e.currentTarget as HTMLButtonElement).style.color = '#475569'; }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function AIAgentPage() {
  const { state }              = useApp();
  const { address }            = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient           = usePublicClient();
  const router                 = useRouter();

  const { employees, groups, isPremiumUser, payrollClone, registryClone, tokenRegistry } = state;

  // ── Layout overlays ────────────────────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [bentoOpen,   setBentoOpen]   = useState(false);

  // ── Chat ───────────────────────────────────────────────────────────────────
  const [messages,          setMessages]          = useState<Message[]>([]);
  const [input,             setInput]             = useState('');
  const [isStreaming,       setIsStreaming]        = useState(false);
  const [showBento,         setShowBento]          = useState(false);
  const [activeTab,         setActiveTab]          = useState<'chat' | 'logs' | 'schedule'>('chat');
  const [logs,              setLogs]               = useState<AgentLog[]>([]);
  const [chatSessions,      setChatSessions]       = useState<ChatSession[]>([]);
  const [currentSessionId,  setCurrentSessionId]   = useState<string>(() => crypto.randomUUID());

  // ── Agent ──────────────────────────────────────────────────────────────────
  const [agentStatus,      setAgentStatus]      = useState<AgentStatus | null>(null);
  const [activating,       setActivating]       = useState(false);
  const [showAuthChecklist, setShowAuthChecklist] = useState(false);
  const [payrollGranted,   setPayrollGranted]   = useState(false);
  const [registryGranted,  setRegistryGranted]  = useState(false);
  const [grantingPayroll,  setGrantingPayroll]  = useState(false);
  const [grantingRegistry, setGrantingRegistry] = useState(false);
  const [grantError,       setGrantError]       = useState('');
  const [showPremiumError, setShowPremiumError] = useState(false);

  const inputRef  = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── Load logs ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (address) getAgentLogs(address).then(setLogs);
  }, [address]);

  // ── Load chat sessions ────────────────────────────────────────────────────
  useEffect(() => {
    try {
      const stored = localStorage.getItem('salden_chat_sessions');
      if (stored) setChatSessions(JSON.parse(stored));
    } catch { /* ignore */ }
  }, []);

  function saveSessions(sessions: ChatSession[]) {
    setChatSessions(sessions);
    try { localStorage.setItem('salden_chat_sessions', JSON.stringify(sessions.slice(-30))); } catch { /* ignore */ }
  }

  // ── Fetch agent status ────────────────────────────────────────────────────
  useEffect(() => {
    if (!address) return;
    fetch('/api/agent/status')
      .then(r => r.ok ? r.json() : null)
      .then((d: AgentStatus | null) => d && setAgentStatus(d))
      .catch(() => null);
  }, [address]);

  // ── Pre-check existing grants ─────────────────────────────────────────────
  useEffect(() => {
    if (!agentStatus?.walletAddress || !publicClient) return;
    const agentAddr = agentStatus.walletAddress as `0x${string}`;

    async function checkGrants() {
      if (payrollClone) {
        try {
          const g = await publicClient!.readContract({ address: payrollClone as `0x${string}`, abi: IS_AGENT_ABI, functionName: 'isAgent', args: [agentAddr] }) as boolean;
          setPayrollGranted(g);
        } catch { /* not granted or call failed */ }
      }
      if (registryClone) {
        try {
          const g = await publicClient!.readContract({ address: registryClone as `0x${string}`, abi: IS_AGENT_ABI, functionName: 'isAgent', args: [agentAddr] }) as boolean;
          setRegistryGranted(g);
        } catch { /* not granted or call failed */ }
      }
    }
    checkGrants();
  }, [agentStatus?.walletAddress, payrollClone, registryClone, publicClient]);

  // ── Initial greeting ───────────────────────────────────────────────────────
  const addMessage = useCallback((msg: Message) => {
    setMessages(prev => [...prev, msg]);
  }, []);

  useEffect(() => {
    if (!isPremiumUser) return;
    addMessage({
      id:      crypto.randomUUID(),
      role:    'assistant',
      content: `Hello! I'm your Salden AI Payroll Agent.\n\nI can run payroll, schedule recurring payments, check compliance, manage employee groups, and send invoice emails — all Onchain.\n\nYou have ${employees.length} employee${employees.length !== 1 ? 's' : ''} in the system. How can I help you today?`,
      ts:      Date.now(),
    });
  // addMessage is stable (empty deps useCallback); employees.length captured at mount only for greeting
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPremiumUser]);

  // ── Scroll to bottom ───────────────────────────────────────────────────────
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // ── Toggle agent ───────────────────────────────────────────────────────────
  async function handleToggleAgent() {
    if (!isPremiumUser) { setShowPremiumError(true); return; }

    setActivating(true);
    try {
      if (agentStatus?.active) {
        await fetch('/api/agent/deactivate', { method: 'POST' });
        setAgentStatus(prev => prev ? { ...prev, active: false } : null);
        addMessage({ id: crypto.randomUUID(), role: 'system', content: 'Agent deactivated.', ts: Date.now() });
      } else {
        const res  = await fetch('/api/agent/activate', { method: 'POST' });
        const data = await res.json() as { walletAddress?: string; error?: string };
        if (!res.ok) throw new Error(data.error ?? 'Activation failed');
        setAgentStatus({ active: true, walletAddress: data.walletAddress, schedules: 0 });
        setShowAuthChecklist(true);
        addMessage({ id: crypto.randomUUID(), role: 'system', content: 'Agent activated. Authorize its access below.', ts: Date.now() });
      }
    } catch (err) {
      addMessage({ id: crypto.randomUUID(), role: 'system', content: `Error: ${(err as Error).message}`, ts: Date.now() });
    } finally { setActivating(false); }
  }

  // ── Grant addAgent — payroll clone ─────────────────────────────────────────
  async function handleGrantPayroll() {
    if (!walletClient || !publicClient || !payrollClone || !agentStatus?.walletAddress) return;
    setGrantingPayroll(true); setGrantError('');
    try {
      const hash = await walletClient.writeContract({
        address:      payrollClone as `0x${string}`,
        abi:          ADD_AGENT_ABI,
        functionName: 'addAgent',
        args:         [agentStatus.walletAddress as `0x${string}`],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setPayrollGranted(true);
    } catch (err) {
      setGrantError(`Payroll grant failed: ${(err as Error).message}`);
    } finally { setGrantingPayroll(false); }
  }

  // ── Grant addAgent — registry clone ───────────────────────────────────────
  async function handleGrantRegistry() {
    if (!walletClient || !publicClient || !registryClone || !agentStatus?.walletAddress) return;
    setGrantingRegistry(true); setGrantError('');
    try {
      const hash = await walletClient.writeContract({
        address:      registryClone as `0x${string}`,
        abi:          ADD_AGENT_ABI,
        functionName: 'addAgent',
        args:         [agentStatus.walletAddress as `0x${string}`],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setRegistryGranted(true);
    } catch (err) {
      setGrantError(`Registry grant failed: ${(err as Error).message}`);
    } finally { setGrantingRegistry(false); }
  }

  // ── Send chat message ──────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming || !isPremiumUser) return;

    const userMsg:      Message = { id: crypto.randomUUID(), role: 'user',      content: text, ts: Date.now() };
    const assistantId = crypto.randomUUID();
    const assistantMsg: Message = { id: assistantId,         role: 'assistant', content: '',   ts: Date.now() };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInput('');
    setIsStreaming(true);
    setShowBento(false);

    setMessages(prev => {
      const session: ChatSession = {
        id:        currentSessionId,
        title:     text.slice(0, 50),
        messages:  prev.filter(m => m.role !== 'assistant' || m.content !== ''),
        createdAt: Date.now(),
      };
      const others = chatSessions.filter(s => s.id !== currentSessionId);
      saveSessions([session, ...others]);
      return prev;
    });

    try {
      const tokenCtx = buildTokenContext(tokenRegistry);
      const history  = messages.filter(m => m.role !== 'system' && m.content).map(m => ({ role: m.role, content: m.content }));

      const res = await fetch('/api/agent/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...history, { role: 'user', content: text }],
          context: {
            employeeCount: employees.length,
            groups,
            walletAddress: address ?? '',
            agentWallet:   agentStatus?.walletAddress ?? '',
            payrollClone:  payrollClone ?? '',
            registryClone: registryClone ?? '',
            tokenContext:  tokenCtx,
          },
        }),
      });

      if (!res.ok || !res.body) {
        setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: 'Request failed. Please try again.' } : m));
        return;
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let lineBuffer  = '';
      let streamDone  = false;
      let throttle:   ReturnType<typeof setTimeout> | null = null;

      const flush = (id: string, text: string) => {
        if (throttle) return;
        throttle = setTimeout(() => {
          setMessages(prev => prev.map(m => m.id === id ? { ...m, content: text } : m));
          throttle = null;
        }, 40);
      };

      while (!streamDone) {
        const { value, done } = await reader.read();
        if (done) break;
        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split('\n');
        lineBuffer  = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const raw = trimmed.slice(6).trim();
          if (raw === '[DONE]') { streamDone = true; break; }
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw) as { choices?: Array<{ delta?: { content?: string } }>; text?: string };
            const delta  = parsed.choices?.[0]?.delta?.content ?? parsed.text ?? '';
            if (delta) { accumulated += delta; flush(assistantId, accumulated); }
          } catch { /* incomplete SSE chunk */ }
        }
      }
      if (throttle) clearTimeout(throttle);
      setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: accumulated } : m));

      if (address && accumulated.includes('[ACTION LOG]')) {
        const match = accumulated.match(/\[ACTION LOG\]([\s\S]*?)\[\/ACTION LOG\]/);
        if (match) {
          const block  = match[1];
          const action = (block.match(/Action:\s*(.+)/)?.[1] ?? '').trim();
          const status = (block.match(/Status:\s*(.+)/)?.[1] ?? '').trim().toUpperCase();
          const reason = (block.match(/Reason:\s*(.+)/)?.[1] ?? '').trim();
          if (action) {
            await saveAgentLog({ id: crypto.randomUUID(), walletAddress: address, timestamp: Date.now(), action, details: reason || undefined, status: status === 'SUCCESS' ? 'success' : 'failed' });
            const refreshed = await getAgentLogs(address);
            setLogs(refreshed);
          }
        }
      }
    } catch {
      setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: 'Something went wrong. Please try again.' } : m));
    } finally {
      setIsStreaming(false);
      inputRef.current?.focus();
    }
  }, [input, isStreaming, isPremiumUser, messages, currentSessionId, chatSessions, tokenRegistry, employees.length, groups, address, agentStatus, payrollClone, registryClone]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  function startNewChat() {
    if (messages.length > 0) {
      const title   = messages.find(m => m.role === 'user')?.content.slice(0, 50) ?? 'Untitled chat';
      const others  = chatSessions.filter(s => s.id !== currentSessionId);
      saveSessions([{ id: currentSessionId, title, messages, createdAt: Date.now() }, ...others]);
    }
    setCurrentSessionId(crypto.randomUUID());
    setMessages([]);
    setBentoOpen(false);
  }

  function loadSession(session: ChatSession) {
    setCurrentSessionId(session.id);
    setMessages(session.messages);
    setBentoOpen(false);
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#F8F9FA', overflow: 'hidden' }}>

      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header style={{ height: 60, flexShrink: 0, background: '#fff', borderBottom: '1px solid #E2E8F0', display: 'flex', alignItems: 'center', padding: '0 16px', position: 'relative', zIndex: 20 }}>
        <button onClick={() => setSidebarOpen(true)} aria-label="Open navigation"
          style={{ width: 38, height: 38, borderRadius: 8, border: '1px solid #E2E8F0', background: '#F8F9FA', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#475569', flexShrink: 0 }}>
          <ArrowLeft size={18} />
        </button>

        <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 24, height: 24, borderRadius: 6, background: '#4F46E5', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: agentStatus?.active ? '#14B8A6' : '#94A3B8', boxShadow: agentStatus?.active ? '0 0 6px #14B8A6' : 'none' }} />
          </div>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>AI Agent</span>
        </div>

        <div style={{ flex: 1 }} />

        <button onClick={() => setBentoOpen(v => !v)} aria-label="Open agent menu"
          style={{ width: 38, height: 38, borderRadius: 8, border: '1px solid #E2E8F0', background: bentoOpen ? '#EEF2FF' : '#F8F9FA', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
          <LayoutGrid size={18} color={bentoOpen ? '#4F46E5' : '#475569'} />
        </button>
      </header>

      {/* ── Main sidebar overlay ─────────────────────────────────────────── */}
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} userAddress={address} companyName={state.payrollSetup?.companyName} />

      {/* ── Bento overlay panel ──────────────────────────────────────────── */}
      {bentoOpen && <div onClick={() => setBentoOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.3)', zIndex: 30, backdropFilter: 'blur(1px)' }} />}
      <div style={{
        position: 'fixed', top: 60, right: 0, bottom: 0, width: 300,
        background: '#fff', borderLeft: '1px solid #E2E8F0', zIndex: 31,
        display: 'flex', flexDirection: 'column',
        transform: bentoOpen ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.25s cubic-bezier(0.4,0,0.2,1)',
        boxShadow: bentoOpen ? '-4px 0 24px rgba(0,0,0,0.08)' : 'none',
      }}>
        <div style={{ padding: '20px 16px 14px', borderBottom: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'transparent', overflow: 'hidden', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Image src="/images/ai-avatar.png" alt="AI Agent" width={42} height={42} style={{ objectFit: 'contain' }} onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>AI Agent</div>
            <div style={{ fontSize: 12, color: agentStatus?.active ? '#059669' : '#94A3B8' }}>{agentStatus?.active ? '● Active' : '○ Inactive'}</div>
          </div>
          <button onClick={() => setBentoOpen(false)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', padding: 4 }}><XIcon size={16} /></button>
        </div>

        <div style={{ padding: '12px 12px 0' }}>
          <Link href="/ai-agent/manage" onClick={() => setBentoOpen(false)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: 10, background: '#F8F9FA', textDecoration: 'none', marginBottom: 8 }}
            onMouseEnter={e => (e.currentTarget.style.background = '#EEF2FF')}
            onMouseLeave={e => (e.currentTarget.style.background = '#F8F9FA')}>
            <Settings2 size={16} color="#4F46E5" />
            <span style={{ fontSize: 14, fontWeight: 600, color: '#0F172A' }}>Manage AI Agent</span>
          </Link>
          <button onClick={startNewChat}
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: 10, background: '#F0FDFA', border: 'none', cursor: 'pointer', marginBottom: 12, fontFamily: 'inherit' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#CCFBF1')}
            onMouseLeave={e => (e.currentTarget.style.background = '#F0FDFA')}>
            <Plus size={16} color="#14B8A6" />
            <span style={{ fontSize: 14, fontWeight: 600, color: '#0D9488' }}>New Chat</span>
          </button>
        </div>

        <div style={{ padding: '0 12px 8px', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Chat History</div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 16px' }}>
          {chatSessions.length === 0
            ? <div style={{ padding: '24px 12px', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No previous chats yet</div>
            : chatSessions.map(s => (
              <button key={s.id} onClick={() => loadSession(s)}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: 'none', background: s.id === currentSessionId ? '#EEF2FF' : 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', marginBottom: 2 }}
                onMouseEnter={e => { if (s.id !== currentSessionId) (e.currentTarget as HTMLButtonElement).style.background = '#F8F9FA'; }}
                onMouseLeave={e => { if (s.id !== currentSessionId) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</div>
                <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>{format(new Date(s.createdAt), 'dd MMM, HH:mm')}</div>
              </button>
            ))
          }
        </div>
      </div>

      {/* ── Page content ────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 900, width: '100%', margin: '0 auto' }}>

        {/* Status bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          {agentStatus && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderRadius: 10, background: agentStatus.active ? '#ECFDF5' : '#F8F9FA', border: `1px solid ${agentStatus.active ? '#A7F3D0' : '#E2E8F0'}` }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: agentStatus.active ? '#059669' : '#94A3B8', boxShadow: agentStatus.active ? '0 0 6px #059669' : 'none' }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: agentStatus.active ? '#059669' : '#64748B' }}>Agent {agentStatus.active ? 'Active' : 'Inactive'}</span>
            </div>
          )}
          <Button variant={agentStatus?.active ? 'ghost' : 'primary'}
            icon={activating ? <Loader2 size={14} style={{ animation: 'spin 0.7s linear infinite' }} /> : agentStatus?.active ? <PowerOff size={14} /> : <Power size={14} />}
            onClick={handleToggleAgent} loading={activating} size="sm">
            {agentStatus?.active ? 'Deactivate' : 'Activate AI Agent'}
          </Button>
        </div>

        {/* Non-premium error */}
        {showPremiumError && !isPremiumUser && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12, padding: '16px 20px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <p style={{ fontSize: 14, fontWeight: 600, color: '#DC2626', margin: '0 0 4px' }}>Could not Activate Agent</p>
              <p style={{ fontSize: 13, color: '#64748B', margin: 0, lineHeight: 1.6 }}>
                Please make sure you are on the premium plan.{' '}
                <Link href="/pricing" style={{ color: '#4F46E5', fontWeight: 600 }}>Go to pricing for more info</Link>
              </p>
            </div>
            <button onClick={() => setShowPremiumError(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', padding: 2, flexShrink: 0 }}><XIcon size={16} /></button>
          </div>
        )}

        {/* Non-premium upgrade banner */}
        {!isPremiumUser && (
          <div style={{ background: 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)', borderRadius: 16, padding: '24px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
            <div>
              <h3 style={{ color: '#fff', fontWeight: 800, fontSize: 17, marginBottom: 6 }}>Unlock Your AI Payroll Agent</h3>
              <p style={{ color: 'rgba(255,255,255,0.8)', fontSize: 14, lineHeight: 1.6 }}>Upgrade to Premium for autonomous payroll scheduling, AI-driven compliance checks, and 24/7 Onchain execution — one-time payment.</p>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <AgentIllustration width={100} height={80} />
              <Link href="/pricing" style={{ padding: '11px 22px', borderRadius: 10, background: '#14B8A6', color: '#fff', fontSize: 14, fontWeight: 700, textDecoration: 'none' }}>View Pricing</Link>
            </div>
          </div>
        )}

        {/* Authorization checklist */}
        {showAuthChecklist && agentStatus?.walletAddress && (
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: '#EEF2FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Shield size={18} color="#4F46E5" />
              </div>
              <div>
                <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', margin: 0 }}>Authorize Agent Access</h3>
                <p style={{ fontSize: 12, color: '#64748B', margin: 0 }}>Two Onchain transactions grant your agent execution rights</p>
              </div>
            </div>
            <div style={{ background: '#F8F9FA', borderRadius: 8, padding: '8px 14px', marginBottom: 16 }}>
              <span style={{ fontSize: 11, color: '#64748B', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>Agent Wallet </span>
              <code style={{ fontSize: 12, color: '#4F46E5', fontFamily: "'JetBrains Mono', monospace" }}>
                {agentStatus.walletAddress.slice(0, 10)}…{agentStatus.walletAddress.slice(-8)}
              </code>
            </div>
            {grantError && <div style={{ background: '#FEF2F2', borderRadius: 8, padding: '8px 14px', marginBottom: 12, fontSize: 13, color: '#DC2626' }}>{grantError}</div>}

            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
              {[
                { granted: payrollGranted, granting: grantingPayroll, onGrant: handleGrantPayroll, contract: payrollClone, label: 'Grant payroll access to Agent', sublabel: 'addAgent(agentAddress) on your Payroll clone', step: '1' },
                { granted: registryGranted, granting: grantingRegistry, onGrant: handleGrantRegistry, contract: registryClone, label: 'Grant registry access to Agent', sublabel: 'addAgent(agentAddress) on your Registry clone', step: '2' },
              ].map(({ granted, granting, onGrant, contract, label, sublabel, step }) => (
                <div key={step} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderRadius: 12, border: `1.5px solid ${granted ? '#A7F3D0' : '#E2E8F0'}`, background: granted ? '#ECFDF5' : '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 24, height: 24, borderRadius: '50%', background: granted ? '#059669' : '#E2E8F0', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {granted ? <Check size={14} color="#fff" /> : <span style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8' }}>{step}</span>}
                    </div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{label}</div>
                      <div style={{ fontSize: 11, color: '#64748B' }}><code style={{ fontFamily: 'monospace' }}>{sublabel}</code></div>
                    </div>
                  </div>
                  {!granted && contract ? (
                    <button onClick={onGrant} disabled={granting}
                      style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: '#4F46E5', color: '#fff', fontSize: 12, fontWeight: 600, cursor: granting ? 'not-allowed' : 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6 }}>
                      {granting ? <><Loader2 size={12} style={{ animation: 'spin 0.7s linear infinite' }} /> Signing…</> : 'Authorize'}
                    </button>
                  ) : !contract ? (
                    <span style={{ fontSize: 11, color: '#94A3B8' }}>Not needed</span>
                  ) : null}
                </div>
              ))}
            </div>

            {payrollGranted && (registryGranted || !registryClone) && (
              <div style={{ marginTop: 14, padding: '10px 16px', borderRadius: 10, background: '#ECFDF5', border: '1px solid #A7F3D0', fontSize: 13, fontWeight: 600, color: '#059669', display: 'flex', alignItems: 'center', gap: 8 }}>
                <CheckCircle2 size={16} /> Agent fully authorized and ready to execute payroll.
              </div>
            )}
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #E2E8F0', background: '#fff', borderRadius: '12px 12px 0 0', overflow: 'hidden' }}>
          {(['chat', 'logs', 'schedule'] as const).map(t => (
            <button key={t} onClick={() => setActiveTab(t)}
              style={{ padding: '10px 20px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: activeTab === t ? 700 : 500, color: activeTab === t ? '#4F46E5' : '#64748B', borderBottom: activeTab === t ? '2px solid #4F46E5' : '2px solid transparent', textTransform: 'capitalize' as const }}>
              {t === 'chat' ? 'Chat' : t === 'logs' ? 'Action Log' : 'Schedules'}
            </button>
          ))}
        </div>

        {/* Chat tab */}
        {activeTab === 'chat' && (
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: '0 0 16px 16px', display: 'flex', flexDirection: 'column' as const, minHeight: 440, flex: 1 }}>
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 20px 8px' }}>
              {messages.map(m => <ChatBubble key={m.id} msg={m} />)}
              {isStreaming && messages[messages.length - 1]?.content === '' && <TypingIndicator />}
              <div ref={bottomRef} />
            </div>
            {showBento && isPremiumUser && <BentoMenu onSelect={p => { setInput(p); setShowBento(false); inputRef.current?.focus(); }} />}
            <div style={{ padding: '12px 16px', borderTop: '1px solid #F1F5F9', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <button onClick={() => setShowBento(p => !p)} title="Quick actions"
                style={{ width: 36, height: 36, borderRadius: 8, flexShrink: 0, border: '1.5px solid #E2E8F0', background: showBento ? '#EEF2FF' : '#F8F9FA', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <List size={16} color={showBento ? '#4F46E5' : '#64748B'} />
              </button>
              <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
                placeholder={isPremiumUser ? 'Ask your agent anything… (Enter to send, Shift+Enter for new line)' : 'Upgrade to Premium to chat with the agent'}
                disabled={!isPremiumUser || isStreaming} rows={1}
                style={{ flex: 1, resize: 'none' as const, border: '1.5px solid #E2E8F0', borderRadius: 10, padding: '9px 14px', fontSize: 14, fontFamily: 'inherit', color: '#0F172A', background: isPremiumUser ? '#fff' : '#F8F9FA', outline: 'none', lineHeight: 1.5, maxHeight: 120, overflowY: 'auto' as const }}
                onFocus={e => (e.target.style.borderColor = '#4F46E5')}
                onBlur={e => (e.target.style.borderColor = '#E2E8F0')} />
              <button onClick={() => handleSend()} disabled={!input.trim() || isStreaming || !isPremiumUser}
                style={{ width: 36, height: 36, borderRadius: 8, flexShrink: 0, background: input.trim() && !isStreaming && isPremiumUser ? '#14B8A6' : '#E2E8F0', border: 'none', cursor: input.trim() && !isStreaming && isPremiumUser ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.15s' }}>
                {isStreaming ? <Loader2 size={16} color="#fff" style={{ animation: 'spin 0.7s linear infinite' }} /> : <Send size={16} color={input.trim() && isPremiumUser ? '#fff' : '#94A3B8'} />}
              </button>
            </div>
          </div>
        )}

        {/* Logs tab */}
        {activeTab === 'logs' && (
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: '0 0 16px 16px', overflow: 'hidden' }}>
            {logs.length === 0 ? (
              <div style={{ padding: '48px 20px', textAlign: 'center' }}>
                <List size={32} color="#E2E8F0" style={{ margin: '0 auto 12px' }} />
                <p style={{ color: '#94A3B8', fontSize: 14 }}>No agent actions logged yet.</p>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' as const }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #E2E8F0' }}>
                    {['Time', 'Action', 'Status', 'Tx Hash'].map(h => <th key={h} style={{ textAlign: 'left', padding: '10px 18px', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {logs.map(log => (
                    <tr key={log.id} style={{ borderBottom: '1px solid #F1F5F9' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#F8F9FA')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <td style={{ padding: '11px 18px', fontSize: 12, color: '#64748B', whiteSpace: 'nowrap' }}>{format(new Date(log.timestamp), 'dd MMM HH:mm')}</td>
                      <td style={{ padding: '11px 18px', fontSize: 13, color: '#0F172A' }}>{log.action}</td>
                      <td style={{ padding: '11px 18px' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 99, fontSize: 11, fontWeight: 600, background: log.status === 'success' ? '#ECFDF5' : '#FEF2F2', color: log.status === 'success' ? '#059669' : '#DC2626' }}>
                          {log.status === 'success' ? <CheckCircle2 size={10} /> : <AlertTriangle size={10} />} {log.status}
                        </span>
                      </td>
                      <td style={{ padding: '11px 18px' }}>
                        {log.txHash
                          ? <a href={`https://testnet.arcscan.app/tx/${log.txHash}`} target="_blank" rel="noreferrer" style={{ fontFamily: 'monospace', fontSize: 12, color: '#4F46E5' }}>{log.txHash.slice(0, 10)}…</a>
                          : <span style={{ color: '#E2E8F0' }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Schedule tab */}
        {activeTab === 'schedule' && (
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: '0 0 16px 16px', padding: 24 }}>
            {!isPremiumUser ? (
              <div style={{ textAlign: 'center', padding: '32px 0' }}>
                <Shield size={36} color="#E2E8F0" style={{ margin: '0 auto 12px' }} />
                <p style={{ color: '#94A3B8', fontSize: 14 }}>Schedules require Premium access.</p>
                <Link href="/pricing" style={{ display: 'inline-flex', marginTop: 12, padding: '9px 20px', borderRadius: 10, background: '#4F46E5', color: '#fff', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>View Pricing</Link>
              </div>
            ) : (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                  <h3 style={{ fontSize: 16, fontWeight: 700, color: '#0F172A' }}>Scheduled Jobs</h3>
                  <Button variant="primary" icon={<Plus size={14} />} size="sm"
                    onClick={() => { setActiveTab('chat'); setInput('Create a new weekly payroll schedule for all employees'); setTimeout(() => inputRef.current?.focus(), 50); }}>
                    New Schedule via Agent
                  </Button>
                </div>
                <div style={{ textAlign: 'center', padding: '32px 0', color: '#94A3B8' }}>
                  <Clock size={36} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
                  <p style={{ fontSize: 14 }}>No schedules yet. Ask the agent to create one.</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin   { to { transform: rotate(360deg); } }
        @keyframes bounce { 0%,80%,100% { transform:translateY(0); opacity:0.4; } 40% { transform:translateY(-6px); opacity:1; } }
      `}</style>
    </div>
  );
}
