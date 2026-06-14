'use client';
/**
 * @file app/error.tsx
 * Route-level error boundary for the root segment.
 * Catches runtime errors in any page below the root layout.
 */

import { useEffect } from 'react';
import { SaldenLogo } from '@/components/shared/Logo';
import { RefreshCw, Home } from 'lucide-react';

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[RouteError]', error);
  }, [error]);

  return (
    <div style={{
      minHeight: '100vh', background: '#F8F9FA',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: 24, textAlign: 'center',
    }}>
      <div style={{ marginBottom: 32 }}>
        <SaldenLogo size={30} />
      </div>

      <div style={{
        width: 60, height: 60, borderRadius: 16,
        background: '#FEF2F2', border: '1px solid #FCA5A5',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 20,
        fontSize: 26,
      }}>
        ⚠
      </div>

      <h2 style={{ fontSize: 22, fontWeight: 800, color: '#0F172A', marginBottom: 8 }}>
        This page ran into an error
      </h2>
      <p style={{ fontSize: 14, color: '#64748B', maxWidth: 420, lineHeight: 1.65, marginBottom: 8 }}>
        An unexpected error occurred on this page. Your wallet and Onchain data are not affected.
        Try refreshing, or go back to the dashboard.
      </p>
      {error.digest && (
        <p style={{ fontSize: 11, color: '#94A3B8', marginBottom: 28 }}>
          Error ID: <code>{error.digest}</code>
        </p>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button
          onClick={reset}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '10px 20px', borderRadius: 10, border: 'none',
            background: '#4F46E5', color: '#fff',
            fontSize: 14, fontWeight: 600, cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <RefreshCw size={14} /> Try Again
        </button>
        <a href="/dashboard"
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '10px 20px', borderRadius: 10,
            border: '1.5px solid #E2E8F0', background: '#fff',
            color: '#475569', fontSize: 14, fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          <Home size={14} /> Dashboard
        </a>
      </div>
    </div>
  );
}
