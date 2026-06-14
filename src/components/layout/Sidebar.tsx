'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';
import {
  LayoutDashboard, History, Bot, Shield,
  Zap, Settings, X, ChevronRight, LogOut,
} from 'lucide-react';
import { SaldenLogo } from '@/components/shared/Logo';
import { useDisconnect } from 'wagmi';

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  userAddress?: string;
  companyName?: string;
}

const NAV = [
  { href: '/dashboard',           icon: LayoutDashboard, label: 'Dashboard'           },
  { href: '/transaction-history', icon: History,         label: 'Transaction History' },
  { href: '/ai-agent',            icon: Bot,             label: 'AI Agent'            },
  { href: '/compliance',          icon: Shield,          label: 'Compliance'          },
  { href: '/pricing',             icon: Zap,             label: 'Pricing'             },
  { href: '/settings',            icon: Settings,        label: 'Settings'            },
];

export function Sidebar({ open, onClose, userAddress, companyName }: SidebarProps) {
  const pathname = usePathname();
  const { disconnect } = useDisconnect();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const truncate = (addr: string) =>
    addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '';

  return (
    <>
      {/* Overlay */}
      {open && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)',
            zIndex: 40, backdropFilter: 'blur(2px)',
          }}
        />
      )}

      {/* Sidebar panel */}
      <aside
        style={{
          position: 'fixed',
          top: 0, left: 0, bottom: 0,
          width: 260,
          background: '#fff',
          borderRight: '1px solid #E2E8F0',
          zIndex: 50,
          display: 'flex',
          flexDirection: 'column',
          transform: open ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.25s cubic-bezier(0.4,0,0.2,1)',
          boxShadow: open ? '4px 0 24px rgba(0,0,0,0.08)' : 'none',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '20px 20px 16px',
          borderBottom: '1px solid #F1F5F9',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <SaldenLogo size={28} />
          <button
            onClick={onClose}
            style={{
              width: 32, height: 32, borderRadius: 8, border: 'none',
              background: '#F8F9FA', cursor: 'pointer', display: 'flex',
              alignItems: 'center', justifyContent: 'center', color: '#64748B',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Company info */}
        {(companyName || userAddress) && (
          <div style={{ padding: '14px 20px', borderBottom: '1px solid #F1F5F9' }}>
            {companyName && (
              <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 2 }}>
                {companyName}
              </div>
            )}
            {userAddress && (
              <div style={{
                fontSize: 12, color: '#64748B',
                fontFamily: "'JetBrains Mono', monospace",
              }}>
                {truncate(userAddress)}
              </div>
            )}
          </div>
        )}

        {/* Nav items */}
        <nav style={{ flex: 1, padding: '12px 12px', overflowY: 'auto' }}>
          {NAV.map(({ href, icon: Icon, label }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '11px 14px',
                  borderRadius: 10,
                  marginBottom: 2,
                  background: active ? '#EEF2FF' : 'transparent',
                  color: active ? '#4F46E5' : '#475569',
                  fontWeight: active ? 600 : 500,
                  fontSize: 14,
                  textDecoration: 'none',
                  transition: 'all 0.12s ease',
                }}
              >
                <Icon size={18} strokeWidth={active ? 2.5 : 2} />
                {label}
                {active && (
                  <ChevronRight size={14} style={{ marginLeft: 'auto', opacity: 0.6 }} />
                )}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div style={{ padding: '16px 12px', borderTop: '1px solid #F1F5F9' }}>
          <div style={{
            padding: '8px 14px 12px',
            fontSize: 11,
            color: '#94A3B8',
          }}>
            <Link href="/privacy" style={{ color: '#94A3B8', marginRight: 10 }}>Privacy</Link>
            <Link href="/terms" style={{ color: '#94A3B8', marginRight: 10 }}>Terms</Link>
            <a href="https://salden.xyz" target="_blank" rel="noreferrer" style={{ color: '#94A3B8' }}>salden.xyz</a>
          </div>
          {mounted && userAddress && (
            <button
              onClick={() => { disconnect(); onClose(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                width: '100%', padding: '10px 14px',
                background: 'transparent', border: '1px solid #E2E8F0',
                borderRadius: 10, cursor: 'pointer',
                fontSize: 13, fontWeight: 500, color: '#DC2626',
                fontFamily: 'inherit',
              }}
            >
              <LogOut size={16} />
              Disconnect
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
