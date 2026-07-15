'use client';
/**
 * @file app/auth/otp/OTPForm.tsx
 *
 * Handles both use-cases:
 *   A) External-wallet users linking their email (wallet param in URL)
 *   B) Email-OTP social login (no wallet param)
 *
 * For case B, after OTP verification:
 *   1. POST /api/auth/email-wallet to get or create a Circle wallet.
 *   2. If returning user → wallet address returned directly → store & redirect.
 *   3. If new user → Circle challengeId returned → execute Circle SDK challenge
 *      (user sets PIN) → poll /api/auth/wallet-address → store & redirect.
 */

import { useState, useRef, useEffect } from 'react';
import { useRouter, useSearchParams }  from 'next/navigation';
import { SaldenLogo }    from '@/components/shared/Logo';
import { Mail, ArrowLeft, RefreshCw, Loader2 } from 'lucide-react';
import { executeCircleChallenge } from '@/lib/circle/executeChallenge';

const OTP_LENGTH      = 6;
const RESEND_COOLDOWN = 30;

// Stores a complete, verified session in localStorage.
function storeSession(email: string, walletAddress: string) {
  try {
    localStorage.setItem('salden_session', JSON.stringify({
      email,
      walletAddress,
      loginMethod: 'email',
      createdAt:   Date.now(),
    }));
  } catch { /* ignore write errors */ }
}

export function OTPForm() {
  const router  = useRouter();
  const params  = useSearchParams();
  const email   = params.get('email') ?? '';
  const wallet  = params.get('wallet') ?? '';   // set for external-wallet link flow
  const token   = params.get('token') ?? '';

  const [code,      setCode]      = useState('');
  const [error,     setError]     = useState('');
  const [verifying, setVerifying] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');  // shown during wallet setup steps
  const [cooldown,  setCooldown]  = useState(RESEND_COOLDOWN);
  const [resending, setResending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Countdown timer for resend cooldown
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown(c => c - 1), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  function handleChange(val: string) {
    const cleaned = val.replace(/\D/g, '').slice(0, OTP_LENGTH);
    setCode(cleaned);
    setError('');
    if (cleaned.length === OTP_LENGTH) submitCode(cleaned);
  }

  async function submitCode(codeToSubmit?: string) {
    const finalCode = (codeToSubmit ?? code).trim();
    if (finalCode.length < OTP_LENGTH) {
      setError('Please enter the full 6-digit code.');
      return;
    }
    setVerifying(true);
    setError('');
    setStatusMsg('Verifying code…');

    try {
      // ── Step 1: Verify the OTP ──────────────────────────────────────────────
      const res = await fetch('/api/auth/verify-otp', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          email,
          otp:           finalCode,
          token,
          walletAddress: wallet || undefined,
        }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'Invalid code. Please try again.');
        return;
      }

      // ── Case A: Linking email to an external wallet ─────────────────────────
      if (wallet) {
        try {
          const existing = localStorage.getItem('salden_session');
          const parsed   = existing ? JSON.parse(existing) : {};
          localStorage.setItem('salden_session', JSON.stringify({
            ...parsed,
            email,
            walletAddress: wallet,
            loginMethod:   'external',
          }));
        } catch { /* ignore */ }
        router.push('/dashboard');
        return;
      }

      // ── Case B: Email-OTP social login ─────────────────────────────────────
      setStatusMsg('Setting up your wallet…');

      const walletRes = await fetch('/api/auth/email-wallet', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email }),
      });
      const walletData = await walletRes.json() as {
        success?:       boolean;
        isNewUser?:     boolean;
        walletAddress?: string;
        challengeId?:   string;
        userToken?:     string;
        encryptionKey?: string;
        error?:         string;
      };

      if (!walletRes.ok) {
        // Non-critical: store a partial session and continue.
        // User will be prompted to set up a wallet on first payroll action.
        try {
          localStorage.setItem('salden_session', JSON.stringify({
            email, walletAddress: null, loginMethod: 'email', createdAt: Date.now(),
          }));
        } catch { /* ignore */ }
        router.push('/dashboard');
        return;
      }

      // Returning user — wallet already exists
      if (!walletData.isNewUser && walletData.walletAddress) {
        storeSession(email, walletData.walletAddress);
        router.push('/dashboard');
        return;
      }

      // New user — execute Circle SDK challenge (user sets PIN)
      if (
        walletData.isNewUser &&
        walletData.challengeId &&
        walletData.userToken &&
        walletData.encryptionKey
      ) {
        setStatusMsg('Opening wallet setup… please follow the prompts.');
        try {
          const address = await executeCircleChallenge({
            challengeId:   walletData.challengeId,
            userToken:     walletData.userToken,
            encryptionKey: walletData.encryptionKey,
            email,
          });
          storeSession(email, address);
          router.push('/dashboard');
        } catch (challengeErr) {
          // Challenge failed or user cancelled. Store partial session.
          // They can retry wallet setup later from Settings.
          console.warn('[OTPForm] Circle challenge failed:', challengeErr);
          try {
            localStorage.setItem('salden_session', JSON.stringify({
              email, walletAddress: null, loginMethod: 'email', createdAt: Date.now(),
            }));
          } catch { /* ignore */ }
          router.push('/dashboard');
        }
        return;
      }

      // Fallback — store partial session
      try {
        localStorage.setItem('salden_session', JSON.stringify({
          email, walletAddress: null, loginMethod: 'email', createdAt: Date.now(),
        }));
      } catch { /* ignore */ }
      router.push('/dashboard');

    } catch (err) {
      setError((err as Error).message ?? 'Verification failed. Please try again.');
    } finally {
      setVerifying(false);
      setStatusMsg('');
    }
  }

  async function handleResend() {
    if (cooldown > 0 || resending) return;
    setResending(true);
    setError('');
    try {
      const res = await fetch('/api/auth/send-otp', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, walletAddress: wallet || undefined }),
      });
      if (!res.ok) {
        setError('Could not resend code. Please try again.');
        return;
      }
      const newData = await res.json() as { token?: string };
      // Update the URL token without a full page reload
      if (newData.token) {
        const url = new URL(window.location.href);
        url.searchParams.set('token', newData.token);
        router.replace(url.pathname + url.search);
      }
      setCooldown(RESEND_COOLDOWN);
      setCode('');
      inputRef.current?.focus();
    } catch {
      setError('Could not resend code. Please try again.');
    } finally {
      setResending(false);
    }
  }

  const isBusy = verifying || resending;

  return (
    <div style={{
      minHeight: '100vh', background: '#F8F9FA',
      padding: '28px 24px',
    }}>
      {/* Logo — top-left, not centered */}
      <div style={{ marginBottom: 48 }}>
        <SaldenLogo size={30} />
      </div>

      {/* Everything else: pinned near the top, horizontally centered */}
      <div style={{
        maxWidth: 440, margin: '0 auto', textAlign: 'center',
      }}>
        <h2 style={{ fontSize: 22, fontWeight: 800, color: '#0F172A', marginTop: 0, marginBottom: 6 }}>
          Check your email
        </h2>
        <p style={{ fontSize: 14, color: '#64748B', marginBottom: 28, lineHeight: 1.65 }}>
          We sent a 6-digit code for verification
        </p>

        {/* Single input field */}
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          pattern="\d*"
          placeholder="Enter Code"
          value={code}
          onChange={e => handleChange(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !isBusy && submitCode()}
          disabled={isBusy}
          className="otp-input"
          style={{
            width: '100%', padding: '14px 18px',
            fontSize: 22, fontWeight: 700,
            letterSpacing: '0.25em', textAlign: 'left',
            border: `2px solid ${error ? '#FCA5A5' : code.length === OTP_LENGTH ? '#4F46E5' : '#E2E8F0'}`,
            borderRadius: 12, outline: 'none',
            fontFamily: 'inherit', color: '#0F172A',
            background: isBusy ? '#F8F9FA' : '#fff',
            transition: 'border-color 0.15s', marginBottom: 8,
            boxSizing: 'border-box',
          }}
          onFocus={e => { e.target.style.borderColor = '#4F46E5'; }}
          onBlur={e => {
            e.target.style.borderColor = error
              ? '#FCA5A5'
              : code.length === OTP_LENGTH ? '#4F46E5' : '#E2E8F0';
          }}
        />

        {error && (
          <p style={{ fontSize: 13, color: '#DC2626', marginBottom: 14, textAlign: 'left' }}>{error}</p>
        )}

        {/* Status message during multi-step wallet setup */}
        {statusMsg && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14,
            padding: '9px 12px', background: '#EEF2FF', borderRadius: 9 }}>
            <Loader2 size={14} color="#4F46E5" style={{ animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />
            <span style={{ fontSize: 13, color: '#4F46E5', fontWeight: 500 }}>{statusMsg}</span>
          </div>
        )}

        <button
          onClick={() => submitCode()}
          disabled={isBusy || code.length < OTP_LENGTH}
          style={{
            width: '100%', padding: '13px 0', fontSize: 15, fontWeight: 700,
            borderRadius: 12, border: 'none',
            background: isBusy || code.length < OTP_LENGTH ? '#E2E8F0' : '#14B8A6',
            color: isBusy || code.length < OTP_LENGTH ? '#94A3B8' : '#fff',
            cursor: isBusy || code.length < OTP_LENGTH ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit', display: 'flex', alignItems: 'center',
            justifyContent: 'center', gap: 8, marginTop: 8,
          }}
        >
          {verifying && <Loader2 size={15} style={{ animation: 'spin 0.7s linear infinite' }} />}
          {verifying ? 'Verifying…' : 'Verify Code'}
        </button>

        <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <Mail size={13} color="#94A3B8" />
          <span style={{ fontSize: 13, color: '#64748B' }}>Didn&apos;t receive it?</span>
          <button
            onClick={handleResend}
            disabled={cooldown > 0 || resending}
            style={{
              background: 'none', border: 'none',
              cursor: cooldown > 0 ? 'not-allowed' : 'pointer',
              fontSize: 13, fontWeight: 600,
              color: cooldown > 0 ? '#94A3B8' : '#14B8A6',
              fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            {resending && <RefreshCw size={12} style={{ animation: 'spin 0.7s linear infinite' }} />}
            {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
          </button>
        </div>

        <button
          onClick={() => router.push('/')}
          style={{
            marginTop: 24, background: 'none', border: 'none',
            cursor: 'pointer', fontSize: 13, color: '#94A3B8',
            display: 'flex', alignItems: 'center', gap: 6,
            fontFamily: 'inherit', margin: '24px auto 0',
          }}
        >
          <ArrowLeft size={13} /> Back to login
        </button>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .otp-input::placeholder { font-size: 17px; letter-spacing: normal; font-weight: 500; color: #94A3B8; }
      `}</style>
    </div>
  );
}
