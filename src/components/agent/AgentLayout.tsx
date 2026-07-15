'use client';
/**
 * @file components/agent/AgentLayout.tsx
 *
 * Wraps all AI Agent section pages.
 * The SlidersHorizontal icon (top-right of header) opens a RIGHT-side drawer.
 * This drawer is the AI Agent sidebar — only visible on AI Agent pages.
 * All other pages are completely unaffected.
 *
 * Drawer content (ImportantUpdate #13):
 *   - AI agent avatar + "AI Agent" name + active status dot + truncated wallet
 *   - Agent Wallet  →  /ai-agent/agent-wallet
 *   - Manage AI Agent → /ai-agent/manage
 *   - Chat History   → /ai-agent/chat-history
 *   - + New Chat button at bottom
 */

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  SlidersHorizontal, X, Wallet, Settings2,
  MessageSquare, PlusCircle,
} from 'lucide-react';
import { AppLayout }     from '@/components/layout/AppLayout';
import { useAgentStatus } from '@/lib/useAgentStatus';

interface AgentLayoutProps {
  title:    string;
  children: React.ReactNode;
}

const AGENT_NAV = [
  { href: '/ai-agent/agent-wallet', icon: Wallet,        label: 'Agent Wallet'    },
  { href: '/ai-agent/manage',       icon: Settings2,     label: 'Manage AI Agent' },
  { href: '/ai-agent/chat-history', icon: MessageSquare, label: 'Chat History'    },
];

function truncAddr(addr: string) {
  return addr.length > 12 ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : addr;
}

export function AgentLayout({ title, children }: AgentLayoutProps) {
  const pathname = usePathname();
  const router   = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { status, agentInfo } = useAgentStatus();
  const isActive  = status === 'active';
  const agentAddr = agentInfo?.agentWallet ?? '';

  function handleNewChat() {
    setDrawerOpen(false);
    router.push('/ai-agent?new=' + Date.now());
  }

  // ── Sliders icon — passed as headerRight to AppLayout ────────────────────
  const slidersBtn = (
    <button
      onClick={() => setDrawerOpen(true)}
      aria-label="Open AI Agent menu"
      style={{
        width: 38, height: 38, borderRadius: 8,
        border: '1px solid #E2E8F0', background: '#F8F9FA',
        cursor: 'pointer', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        color: '#475569',
      }}
    >
      <SlidersHorizontal size={18} />
    </button>
  );

  return (
    <>
      <AppLayout title={title} headerRight={slidersBtn} showWalletAddress>
        {children}
      </AppLayout>

      {/* ── Right-side drawer ─────────────────────────────────────────────── */}

      {/* Backdrop */}
      {drawerOpen && (
        <div
          onClick={() => setDrawerOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 50,
            background: 'rgba(15,23,42,0.35)',
            backdropFilter: 'blur(2px)',
          }}
        />
      )}

      {/* Drawer panel */}
      <div
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 280, zIndex: 51,
          background: '#fff',
          boxShadow: '-8px 0 32px rgba(0,0,0,0.12)',
          transform: drawerOpen ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.25s cubic-bezier(0.4,0,0.2,1)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* Drawer header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '18px 20px', borderBottom: '1px solid #F1F5F9',
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>AI Agent</span>
          <button
            onClick={() => setDrawerOpen(false)}
            style={{
              width: 32, height: 32, borderRadius: '50%', border: 'none',
              background: '#F1F5F9', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <X size={16} color="#475569" />
          </button>
        </div>

        {/* Agent card */}
        <div style={{ padding: '20px', borderBottom: '1px solid #F1F5F9' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            {/* Avatar */}
            <div style={{
              width: 48, height: 48, borderRadius: '50%', flexShrink: 0,
              background: '#FAFAF8',
              border: '1px solid #F1F5F9',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              overflow: 'hidden',
            }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/images/ai-avatar.png" alt="" width={34} height={34} style={{ objectFit: 'contain' }} />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: '#0F172A', marginBottom: 4 }}>
                AI Agent
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: isActive ? '#14B8A6' : '#94A3B8',
                  boxShadow: isActive ? '0 0 6px #14B8A6' : 'none',
                  display: 'inline-block',
                }} />
                <span style={{
                  fontSize: 12, fontWeight: 600,
                  color: isActive ? '#059669' : '#94A3B8',
                }}>
                  {isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
            </div>
          </div>

          {/* Truncated agent wallet address */}
          {isActive && agentAddr ? (
            <div style={{
              padding: '7px 10px',
              background: '#F8F9FA', borderRadius: 9,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12, color: '#475569', wordBreak: 'break-all',
            }}>
              {truncAddr(agentAddr)}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: '#94A3B8' }}>
              {status === 'none' ? 'Not activated yet' : 'Loading…'}
            </div>
          )}
        </div>

        {/* Nav links */}
        <nav style={{ padding: '12px 10px', flex: 1 }}>
          {AGENT_NAV.map(item => {
            const active = pathname === item.href;
            const Icon   = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setDrawerOpen(false)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '12px 12px', borderRadius: 10,
                  marginBottom: 2, textDecoration: 'none',
                  background: active ? '#EEF2FF' : 'transparent',
                  color: active ? '#4F46E5' : '#475569',
                  fontWeight: active ? 700 : 500,
                  fontSize: 14, transition: 'background 0.12s',
                }}
              >
                <Icon size={17} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* + New Chat */}
        <div style={{ padding: '12px 10px 20px', borderTop: '1px solid #F1F5F9' }}>
          <button
            onClick={handleNewChat}
            style={{
              width: '100%', display: 'flex', alignItems: 'center',
              justifyContent: 'center', gap: 8,
              padding: '12px 0', borderRadius: 12,
              background: '#14B8A6', border: 'none',
              color: '#fff', fontSize: 14, fontWeight: 700,
              cursor: 'pointer', fontFamily: 'inherit',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#0D9488'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#4F46E5'; }}
          >
            <PlusCircle size={16} /> New Chat
          </button>
        </div>
      </div>
    </>
  );
}
