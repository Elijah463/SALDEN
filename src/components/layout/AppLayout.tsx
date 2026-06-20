'use client';
import { ReactNode, useState, useEffect } from 'react';
import { Menu } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { Footer } from './Footer';
import { useAccount } from 'wagmi';

interface AppLayoutProps {
  children: ReactNode;
  title?: string;
  companyName?: string;
}

export function AppLayout({ children, title, companyName }: AppLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mounted,     setMounted]     = useState(false);
  const { address } = useAccount();

  // Prevent hydration mismatch — wallet state is only available client-side
  useEffect(() => { setMounted(true); }, []);

  return (
    <div style={{ minHeight: '100vh', background: '#F8F9FA', display: 'flex', flexDirection: 'column' }}>
      {/* Top nav */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 30,
        background: '#fff',
        borderBottom: '1px solid #E2E8F0',
        padding: '0 24px',
        height: 60,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      }}>
        <button
          onClick={() => setSidebarOpen(true)}
          style={{
            width: 38, height: 38, borderRadius: 8, border: '1px solid #E2E8F0',
            background: '#F8F9FA', cursor: 'pointer', display: 'flex',
            alignItems: 'center', justifyContent: 'center', color: '#475569',
          }}
          aria-label="Open menu"
        >
          <Menu size={18} />
        </button>

        {title && (
          <span style={{
            fontSize: 15, fontWeight: 600, color: '#4F46E5',
            marginLeft: 4,
          }}>
            {title}
          </span>
        )}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Only render wallet address after mount — prevents hydration mismatch */}
        {mounted && address && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 12px',
            background: '#EEF2FF', borderRadius: 8,
            fontSize: 12, fontWeight: 500, color: '#4F46E5',
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%',
              background: '#14B8A6', boxShadow: '0 0 6px #14B8A6',
              display: 'inline-block',
            }} />
            {address.slice(0, 6)}…{address.slice(-4)}
          </div>
        )}
      </header>

      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        userAddress={address}
        companyName={companyName}
      />

      {/* Page content */}
      <main className="app-main">
        {children}
      </main>

      <Footer />
    </div>
  );
}
