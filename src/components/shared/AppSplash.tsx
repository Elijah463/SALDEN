'use client';
/**
 * @file components/shared/AppSplash.tsx
 * Shows briefly when the app opens in standalone (installed PWA) mode.
 * Fades out after 1.4 seconds then renders children.
 */

import { useState, useEffect } from 'react';
import { SaldenLogo } from '@/components/shared/Logo';

interface AppSplashProps {
  children: React.ReactNode;
}

export function AppSplash({ children }: AppSplashProps) {
  const [visible,  setVisible]  = useState(false);
  const [fading,   setFading]   = useState(false);
  const [done,     setDone]     = useState(false);

  useEffect(() => {
    // Only show splash in standalone / installed PWA mode
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      ('standalone' in navigator && (navigator as { standalone?: boolean }).standalone === true);

    if (!isStandalone) { setDone(true); return; }

    setVisible(true);

    const fadeTimer = setTimeout(() => setFading(true), 1400);
    const doneTimer = setTimeout(() => { setVisible(false); setDone(true); }, 1900);
    return () => { clearTimeout(fadeTimer); clearTimeout(doneTimer); };
  }, []);

  if (done) return <>{children}</>;

  return (
    <>
      {visible && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: '#fff',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 16,
          opacity: fading ? 0 : 1,
          transition: 'opacity 0.5s ease',
          pointerEvents: 'none',
        }}>
          <SaldenLogo size={56} />
          <span style={{
            fontSize: 28, fontWeight: 900, letterSpacing: '0.12em',
            color: '#4F46E5', fontFamily: "'Plus Jakarta Sans', sans-serif",
          }}>
            SALDEN
          </span>
        </div>
      )}
      <div style={{ opacity: fading || done ? 1 : 0, transition: 'opacity 0.3s ease 0.2s' }}>
        {children}
      </div>
    </>
  );
}
