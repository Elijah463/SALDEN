'use client';
/**
 * @file app/auth/otp/OTPForm.tsx
 * - Resend cooldown: 30 seconds (spec requirement)
 * - Paste works on ANY box — fills from that position forward
 * - Auto-submits when all 6 digits are filled
 */

import { useState, useRef, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { SaldenLogo }        from '@/components/shared/Logo';
import { Button }            from '@/components/shared/Button';
import Image                 from 'next/image';
import { Mail, ArrowLeft, RefreshCw } from 'lucide-react';

const OTP_LENGTH      = 6;
const RESEND_COOLDOWN = 30; // seconds — per spec

export function OTPForm() {
  const router  = useRouter();
  const params  = useSearchParams();
  const email   = params.get('email') ?? '';
  const wallet  = params.get('wallet') ?? '';
  const token   = params.get('token') ?? '';

  const [digits,    setDigits]    = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const [error,     setError]     = useState('');
  const [verifying, setVerifying] = useState(false);
  const [cooldown,  setCooldown]  = useState(RESEND_COOLDOWN);
  const [resending, setResending] = useState(false);

  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Count down the resend timer
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown(c => c - 1), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  // Focus first box on mount
  useEffect(() => { inputRefs.current[0]?.focus(); }, []);

  function handleChange(idx: number, val: string) {
    const cleaned = val.replace(/\D/g, '').slice(0, 1);
    const next    = [...digits];
    next[idx]     = cleaned;
    setDigits(next);
    setError('');
    if (cleaned && idx < OTP_LENGTH - 1) inputRefs.current[idx + 1]?.focus();
    if (cleaned && idx === OTP_LENGTH - 1 && !next.includes('')) submitCode(next.join(''));
  }

  function handleKeyDown(idx: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace'  && !digits[idx] && idx > 0)           inputRefs.current[idx - 1]?.focus();
    if (e.key === 'ArrowLeft'  && idx > 0)                           inputRefs.current[idx - 1]?.focus();
    if (e.key === 'ArrowRight' && idx < OTP_LENGTH - 1)              inputRefs.current[idx + 1]?.focus();
  }

  // Paste handler — works on every box, fills from that position forward
  function handlePaste(idx: number, e: React.ClipboardEvent) {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!pasted) return;

    const next = [...digits];
    let filled = 0;
    for (let i = idx; i < OTP_LENGTH && filled < pasted.length; i++, filled++) {
      next[i] = pasted[filled];
    }
    setDigits(next);
    setError('');

    const lastFilled = Math.min(idx + pasted.length - 1, OTP_LENGTH - 1);
    const nextEmpty  = next.findIndex((d, i) => i >= idx && !d);
    inputRefs.current[nextEmpty === -1 ? lastFilled : nextEmpty]?.focus();

    if (!next.includes('')) submitCode(next.join(''));
  }

  async function submitCode(code?: string) {
    const otp = code ?? digits.join('');
    if (otp.length < OTP_LENGTH) { setError('Enter all 6 digits.'); return; }
    if (!token) { setError('Session expired — go back and request a new code.'); return; }

    setVerifying(true); setError('');
    try {
      const res = await fetch('/api/auth/verify-otp', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, otp, token, walletAddress: wallet }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Verification failed');
      try {
        localStorage.setItem('salden_session', JSON.stringify({
          email, walletAddress: wallet, loginMethod: 'email-otp', createdAt: Date.now(),
        }));
      } catch { /* ignore storage errors */ }
      router.push('/dashboard');
    } catch (err) {
      setError((err as Error).message);
      setDigits(Array(OTP_LENGTH).fill(''));
      inputRefs.current[0]?.focus();
    } finally { setVerifying(false); }
  }

  async function handleResend() {
    if (cooldown > 0 || resending) return;
    setResending(true);
    try {
      const res = await fetch('/api/auth/send-otp', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, walletAddress: wallet }),
      });
      const data = await res.json() as { token?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to resend');
      const next = `/auth/otp?email=${encodeURIComponent(email)}${wallet ? `&wallet=${wallet}` : ''}&token=${encodeURIComponent(data.token ?? '')}`;
      router.replace(next);
      setCooldown(RESEND_COOLDOWN);
      setDigits(Array(OTP_LENGTH).fill(''));
      inputRefs.current[0]?.focus();
    } catch { /* silently fail — user will see the timer */ }
    finally { setResending(false); }
  }

  const boxStyle = (filled: boolean): React.CSSProperties => ({
    width: 52, height: 60,
    borderRadius: 12,
    border: `2px solid ${error ? '#FCA5A5' : filled ? '#4F46E5' : '#E2E8F0'}`,
    background: filled ? '#EEF2FF' : '#fff',
    fontSize: 24, fontWeight: 800, textAlign: 'center',
    color: '#0F172A', fontFamily: 'inherit',
    outline: 'none',
    transition: 'border-color 0.15s, background 0.15s',
    cursor: 'text',
  });

  return (
    <div style={{ minHeight: '100vh', background: '#F8F9FA', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ marginBottom: 32 }}>
        <SaldenLogo size={34} />
      </div>

      <div style={{ background: '#fff', borderRadius: 24, padding: '40px 36px', border: '1px solid #E2E8F0', boxShadow: '0 8px 32px rgba(0,0,0,0.07)', width: '100%', maxWidth: 440, textAlign: 'center' }}>
        <Image src="/images/login-illustration.png" alt="Login" width={160} height={160} style={{ objectFit: 'contain', margin: '0 auto' }} />

        <h2 style={{ fontSize: 22, fontWeight: 800, color: '#0F172A', marginTop: 16, marginBottom: 6 }}>
          Check your email
        </h2>
        <p style={{ fontSize: 14, color: '#64748B', marginBottom: 28, lineHeight: 1.65 }}>
          We sent a 6-digit code to{' '}
          <strong style={{ color: '#0F172A' }}>{email || 'your email'}</strong>.
          <br />It expires in 10 minutes.
        </p>

        {/* OTP boxes — paste works on any of them */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 20 }}>
          {digits.map((d, idx) => (
            <input
              key={idx}
              ref={el => { inputRefs.current[idx] = el; }}
              type="text"
              inputMode="numeric"
              pattern="\d*"
              maxLength={1}
              value={d}
              onChange={e => handleChange(idx, e.target.value)}
              onKeyDown={e => handleKeyDown(idx, e)}
              onPaste={e => handlePaste(idx, e)}
              onFocus={e => (e.target.style.borderColor = '#4F46E5')}
              onBlur={e => (e.target.style.borderColor = d ? '#4F46E5' : error ? '#FCA5A5' : '#E2E8F0')}
              style={boxStyle(!!d)}
              aria-label={`Digit ${idx + 1}`}
            />
          ))}
        </div>

        {error && (
          <p style={{ fontSize: 13, color: '#DC2626', marginBottom: 14 }}>{error}</p>
        )}

        <Button
          variant="brand"
          loading={verifying}
          onClick={() => submitCode()}
          disabled={digits.join('').length < OTP_LENGTH}
          style={{ width: '100%', padding: '13px 0', fontSize: 15 }}
        >
          Verify Code
        </Button>

        <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <Mail size={13} color="#94A3B8" />
          <span style={{ fontSize: 13, color: '#64748B' }}>Didn&apos;t receive it?</span>
          <button
            onClick={handleResend}
            disabled={cooldown > 0 || resending}
            style={{ background: 'none', border: 'none', cursor: cooldown > 0 ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600, color: cooldown > 0 ? '#94A3B8' : '#4F46E5', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4 }}
          >
            {resending && <RefreshCw size={12} style={{ animation: 'spin 0.7s linear infinite' }} />}
            {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
          </button>
        </div>

        <button
          onClick={() => router.push('/')}
          style={{ marginTop: 24, background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#94A3B8', display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'inherit', margin: '24px auto 0' }}
        >
          <ArrowLeft size={13} /> Back to login
        </button>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
