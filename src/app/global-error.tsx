'use client';
/**
 * @file app/global-error.tsx
 * Catches unhandled errors that bubble past all route-level boundaries.
 * Renders a safe fallback that doesn't depend on any providers.
 */

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[GlobalError]', error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#F8F9FA' }}>
        <div style={{
          minHeight: '100vh',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: 24, textAlign: 'center',
        }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14,
            background: '#FEF2F2', border: '1px solid #FCA5A5',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: 20, fontSize: 24,
          }}>
            ⚠
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: '#0F172A', marginBottom: 10 }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: 14, color: '#64748B', maxWidth: 400, lineHeight: 1.65, marginBottom: 28 }}>
            An unexpected error occurred. Your wallet and Onchain data are not affected.
            {error.digest && (
              <><br /><code style={{ fontSize: 11, color: '#94A3B8' }}>Error ID: {error.digest}</code></>
            )}
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={reset}
              style={{
                padding: '10px 22px', borderRadius: 10, border: 'none',
                background: '#14B8A6', color: '#fff',
                fontSize: 14, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Try Again
            </button>
            <a href="/"
              style={{
                padding: '10px 22px', borderRadius: 10,
                border: '1.5px solid #E2E8F0', background: 'transparent',
                color: '#475569', fontSize: 14, fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              Go Home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
