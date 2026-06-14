'use client';
/**
 * @file components/auth/LoginModal.tsx
 *
 * Login options:
 *  1. Email OTP  — unchanged flow
 *  2. Google     — Google Identity Services → Circle User-Controlled Wallet
 *  3. WalletConnect — unchanged external wallet flow
 *
 * Google + Circle flow:
 *  a) Load Google Identity Services (GIS) script once.
 *  b) User clicks "Continue with Google" → GIS shows One Tap / popup.
 *  c) On credential, POST to /api/auth/google.
 *  d) If new user  → load @circle-fin/w3s-pw-web-sdk and execute PIN-setup challenge.
 *  e) After PIN set → fetch wallet address from /api/auth/wallet-address.
 *  f) Store session in localStorage → redirect to /dashboard.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/shared/Modal';
import { Button } from '@/components/shared/Button';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import { Mail, ArrowRight, Loader2 } from 'lucide-react';

// ── Google icon ───────────────────────────────────────────────────────────────
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M17.64 9.20455C17.64 8.56637 17.5827 7.95273 17.4764 7.36364H9V10.845H13.8436C13.635 11.97 13.0009 12.9232 12.0477 13.5614V15.8196H14.9564C16.6582 14.2527 17.64 11.9455 17.64 9.20455Z" fill="#4285F4"/>
      <path d="M9 18C11.43 18 13.4673 17.1941 14.9564 15.8195L12.0477 13.5613C11.2418 14.1013 10.2109 14.4204 9 14.4204C6.65591 14.4204 4.67182 12.8372 3.96409 10.71H0.957275V13.0418C2.43818 15.9831 5.48182 18 9 18Z" fill="#34A853"/>
      <path d="M3.96409 10.71C3.78409 10.17 3.68182 9.59319 3.68182 9.00001C3.68182 8.40683 3.78409 7.83001 3.96409 7.29001V4.95819H0.957273C0.347727 6.17319 0 7.54773 0 9.00001C0 10.4523 0.347727 11.8268 0.957273 13.0418L3.96409 10.71Z" fill="#FBBC05"/>
      <path d="M9 3.57955C10.3214 3.57955 11.5077 4.03364 12.4405 4.92545L15.0218 2.34409C13.4632 0.891818 11.4259 0 9 0C5.48182 0 2.43818 2.01682 0.957275 4.95818L3.96409 7.29C4.67182 5.16273 6.65591 3.57955 9 3.57955Z" fill="#EA4335"/>
    </svg>
  );
}

// ── Types ──────────────────────────────────────────────────────────────────────
interface LoginModalProps {
  open:    boolean;
  onClose: () => void;
}

type Step =
  | 'choose'
  | 'email-otp'
  | 'wallet-verify'
  | 'google-loading'
  | 'google-wallet-setup';

// ── Declare Google Identity Services global ───────────────────────────────────
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (cfg: {
            client_id:          string;
            callback:           (res: { credential: string }) => void;
            auto_select?:       boolean;
            cancel_on_tap_outside?: boolean;
          }) => void;
          prompt: (cb?: (notification: { isNotDisplayed: () => boolean; isSkippedMoment: () => boolean }) => void) => void;
          renderButton: (el: HTMLElement, cfg: Record<string, unknown>) => void;
          cancel: () => void;
        };
      };
    };
    // Circle Web SDK (loaded dynamically)
    W3SSdk?: new (cfg: { appSettings: { appId: string } }) => {
      setAuthentication: (auth: { userToken: string; encryptionKey: string }) => void;
      execute: (challengeId: string, cb: (err: unknown, result: unknown) => void) => void;
    };
  }
}

// ── Session helpers ────────────────────────────────────────────────────────────
function storeSession(email: string, walletAddress: string) {
  try {
    localStorage.setItem('salden_session', JSON.stringify({
      email,
      walletAddress,
      loginMethod: 'google',
      createdAt: Date.now(),
    }));
  } catch { /* ignore */ }
}

// ── Load a <script> tag once (idempotent) ─────────────────────────────────────
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const script  = document.createElement('script');
    script.src    = src;
    script.async  = true;
    script.onload  = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
export function LoginModal({ open, onClose }: LoginModalProps) {
  const [step,      setStep]      = useState<Step>('choose');
  const [email,     setEmail]     = useState('');
  const [emailErr,  setEmailErr]  = useState('');
  const [loading,   setLoading]   = useState(false);
  const [googleMsg, setGoogleMsg] = useState('Connecting with Google…');
  const [mounted,   setMounted]   = useState(false);
  const router = useRouter();
  const { isConnected, address } = useAccount();

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (mounted && isConnected && address && step === 'choose') {
      setStep('wallet-verify');
    }
  }, [mounted, isConnected, address, step]);

  // Preload GIS script when modal opens
  useEffect(() => {
    if (open) {
      loadScript('https://accounts.google.com/gsi/client').catch(() => null);
    }
  }, [open]);

  // ── Execute Circle Web SDK challenge ────────────────────────────────────────
  const executeCircleChallenge = useCallback(
    async (
      challengeId: string,
      userToken: string,
      encryptionKey: string,
      email: string
    ) => {
      const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID ?? '';

      try {
        setGoogleMsg('Setting up your secure wallet…');

        // Dynamically import the Circle Web SDK
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        // @ts-ignore — dynamic import; types vary by SDK version
        const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk") as any;

        const sdk = new W3SSdk({ appSettings: { appId } });
        sdk.setAuthentication({ userToken, encryptionKey });

        await new Promise<void>((resolve, reject) => {
          sdk.execute(challengeId, async (err: unknown) => {
            if (err) { reject(err); return; }

            try {
              setGoogleMsg('Fetching your wallet address…');

              // Poll for the wallet address (Circle needs a moment after challenge)
              let walletAddress: string | null = null;
              for (let i = 0; i < 10; i++) {
                const res = await fetch(
                  `/api/auth/wallet-address?userId=${encodeURIComponent(email)}`
                );
                if (res.ok) {
                  const data = await res.json();
                  walletAddress = data.walletAddress;
                  break;
                }
                await new Promise(r => setTimeout(r, 1500));
              }

              if (!walletAddress) throw new Error('Wallet not ready after PIN setup');

              storeSession(email, walletAddress);
              resolve();
            } catch (e) { reject(e); }
          });
        });

        router.push('/dashboard');
      } catch (err) {
        const msg = (err as Error)?.message ?? 'Wallet setup failed';
        setEmailErr(msg);
        setStep('choose');
      }
    },
    [router]
  );

  // ── Handle the Google credential returned by GIS ───────────────────────────
  const handleGoogleCredential = useCallback(
    async (credential: string) => {
      setStep('google-loading');
      setGoogleMsg('Verifying your Google account…');
      setEmailErr('');

      try {
        const res = await fetch('/api/auth/google', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ credential }),
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error ?? 'Google sign-in failed');

        if (!data.isNewUser && data.walletAddress) {
          // Returning user — wallet already exists
          storeSession(data.email, data.walletAddress);
          router.push('/dashboard');
          return;
        }

        // New user — run Circle wallet-setup challenge
        setStep('google-wallet-setup');
        await executeCircleChallenge(
          data.challengeId,
          data.userToken,
          data.encryptionKey,
          data.email
        );
      } catch (err) {
        const msg = (err as Error)?.message ?? 'Sign-in failed';
        setEmailErr(msg);
        setStep('choose');
      }
    },
    [router, executeCircleChallenge]
  );

  // ── Trigger Google Sign-In popup ────────────────────────────────────────────
  async function handleGoogleLogin() {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId) { setEmailErr('Google Sign-In is not configured'); return; }

    try {
      await loadScript('https://accounts.google.com/gsi/client');

      window.google!.accounts.id.initialize({
        client_id:              clientId,
        callback:               (res) => handleGoogleCredential(res.credential),
        auto_select:            false,
        cancel_on_tap_outside:  true,
      });

      window.google!.accounts.id.prompt((notification) => {
        if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
          // One-tap was suppressed — open a full popup instead
          window.google!.accounts.id.renderButton(
            document.getElementById('google-signin-container')!,
            { theme: 'outline', size: 'large', width: 360 }
          );
          document.getElementById('google-signin-container')?.querySelector<HTMLElement>('[role="button"]')?.click();
        }
      });
    } catch (err) {
      setEmailErr((err as Error).message ?? 'Failed to load Google Sign-In');
    }
  }

  // ── Email OTP submit ────────────────────────────────────────────────────────
  function validateEmail(val: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val);
  }

  async function handleEmailSubmit() {
    if (!validateEmail(email)) { setEmailErr('Please enter a valid email address'); return; }
    setEmailErr('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/send-otp', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to send code');
      onClose();
      router.push(
        `/auth/otp?email=${encodeURIComponent(email)}&token=${encodeURIComponent(data.token)}`
      );
    } catch (err) {
      setEmailErr((err as Error).message ?? 'Failed to send code. Please try again.');
    } finally { setLoading(false); }
  }

  async function handleWalletEmailVerify() {
    if (!validateEmail(email)) { setEmailErr('Please enter a valid email address'); return; }
    setEmailErr('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/send-otp', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, walletAddress: address }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to send code');
      onClose();
      router.push(
        `/auth/otp?email=${encodeURIComponent(email)}&wallet=${address}&token=${encodeURIComponent(data.token)}`
      );
    } catch (err) {
      setEmailErr((err as Error).message ?? 'Failed to send code. Please try again.');
    } finally { setLoading(false); }
  }

  function reset() {
    setStep('choose');
    setEmail('');
    setEmailErr('');
    setLoading(false);
    setGoogleMsg('Connecting with Google…');
  }

  const methodBtn = (
    onClick: () => void,
    icon: React.ReactNode,
    iconBg: string,
    title: string,
    subtitle: string,
    hoverBorder: string
  ) => (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '14px 18px', borderRadius: 12,
        border: '1.5px solid #E2E8F0', background: '#fff',
        cursor: 'pointer', width: '100%', textAlign: 'left',
        fontFamily: 'inherit', transition: 'border-color 0.15s',
      }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = hoverBorder)}
      onMouseLeave={e => (e.currentTarget.style.borderColor = '#E2E8F0')}
    >
      <div style={{
        width: 38, height: 38, borderRadius: 10, background: iconBg,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        {icon}
      </div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A' }}>{title}</div>
        <div style={{ fontSize: 12, color: '#64748B' }}>{subtitle}</div>
      </div>
      <ArrowRight size={16} color="#94A3B8" style={{ marginLeft: 'auto' }} />
    </button>
  );

  return (
    <Modal
      open={open}
      onClose={() => { onClose(); reset(); }}
      title={
        step === 'choose'              ? 'Login to Salden'  :
        step === 'email-otp'           ? 'Enter your email' :
        step === 'wallet-verify'       ? 'Verify your email' :
        step === 'google-loading'      ? 'Signing in…'      :
                                         'Wallet setup'
      }
      maxWidth={420}
    >
      {/* Hidden GIS button container (fallback for One Tap suppression) */}
      <div id="google-signin-container" style={{ display: 'none' }} />

      {/* ── Choose ──────────────────────────────────────────────────────── */}
      {step === 'choose' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {emailErr && (
            <div style={{
              background: '#FEF2F2', border: '1px solid #FECACA',
              borderRadius: 10, padding: '10px 14px',
              fontSize: 13, color: '#DC2626',
            }}>
              {emailErr}
            </div>
          )}

          {methodBtn(
            () => setStep('email-otp'),
            <Mail size={18} color="#4F46E5" />,
            '#EEF2FF',
            'Email Address',
            'Receive a one-time code',
            '#4F46E5'
          )}

          {methodBtn(
            handleGoogleLogin,
            <GoogleIcon />,
            '#F8F9FA',
            'Continue with Google',
            'Sign in & create your Circle wallet',
            '#4285F4'
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0' }}>
            <hr style={{ flex: 1, border: 'none', borderTop: '1px solid #E2E8F0' }} />
            <span style={{ fontSize: 12, color: '#94A3B8', fontWeight: 500 }}>OR</span>
            <hr style={{ flex: 1, border: 'none', borderTop: '1px solid #E2E8F0' }} />
          </div>

          <ConnectButton.Custom>
            {({ openConnectModal }) => (
              <button
                onClick={openConnectModal}
                style={{
                  display: 'flex', alignItems: 'center', gap: 14,
                  padding: '14px 18px', borderRadius: 12,
                  border: '1.5px solid #14B8A6', background: '#F0FDFA',
                  cursor: 'pointer', width: '100%', textAlign: 'left',
                  fontFamily: 'inherit',
                }}
              >
                <div style={{
                  width: 38, height: 38, borderRadius: 10, background: '#14B8A6',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                    <rect x="2" y="6" width="20" height="14" rx="3" stroke="white" strokeWidth="2"/>
                    <path d="M2 10h20" stroke="white" strokeWidth="2"/>
                    <circle cx="17" cy="15" r="1.5" fill="white"/>
                  </svg>
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A' }}>Connect Wallet</div>
                  <div style={{ fontSize: 12, color: '#64748B' }}>MetaMask, WalletConnect &amp; more</div>
                </div>
                <ArrowRight size={16} color="#14B8A6" style={{ marginLeft: 'auto' }} />
              </button>
            )}
          </ConnectButton.Custom>
        </div>
      )}

      {/* ── Email OTP ───────────────────────────────────────────────────── */}
      {step === 'email-otp' && (
        <div>
          <label className="label">Email Address</label>
          <input
            className="input"
            type="email"
            placeholder="Enter your email address"
            value={email}
            onChange={e => { setEmail(e.target.value); setEmailErr(''); }}
            onKeyDown={e => e.key === 'Enter' && handleEmailSubmit()}
            autoFocus
          />
          {emailErr && <div style={{ fontSize: 12, color: '#DC2626', marginTop: 6 }}>{emailErr}</div>}
          <Button variant="primary" loading={loading} onClick={handleEmailSubmit}
            style={{ width: '100%', marginTop: 16 }}>
            Send Code
          </Button>
          <button onClick={() => setStep('choose')} style={{
            width: '100%', marginTop: 10, background: 'none', border: 'none',
            fontSize: 13, color: '#64748B', cursor: 'pointer', fontFamily: 'inherit',
          }}>Back</button>
        </div>
      )}

      {/* ── Wallet email verify ─────────────────────────────────────────── */}
      {step === 'wallet-verify' && (
        <div>
          <div style={{
            background: '#F0FDFA', borderRadius: 10, padding: '12px 16px',
            marginBottom: 20, fontSize: 13, color: '#0D9488',
          }}>
            Wallet connected:{' '}
            <strong style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              {address?.slice(0, 8)}…{address?.slice(-6)}
            </strong>
            <br />Link an email to receive invoice receipts.
          </div>
          <label className="label">Email Address</label>
          <input
            className="input"
            type="email"
            placeholder="Enter your email address"
            value={email}
            onChange={e => { setEmail(e.target.value); setEmailErr(''); }}
            onKeyDown={e => e.key === 'Enter' && handleWalletEmailVerify()}
            autoFocus
          />
          {emailErr && <div style={{ fontSize: 12, color: '#DC2626', marginTop: 6 }}>{emailErr}</div>}
          <Button variant="primary" loading={loading} onClick={handleWalletEmailVerify}
            style={{ width: '100%', marginTop: 16 }}>
            Verify Email
          </Button>
          <button onClick={() => router.push('/dashboard')} style={{
            width: '100%', marginTop: 10, background: 'none', border: 'none',
            fontSize: 13, color: '#64748B', cursor: 'pointer', fontFamily: 'inherit',
          }}>
            Skip for now
          </button>
        </div>
      )}

      {/* ── Google loading / wallet setup ───────────────────────────────── */}
      {(step === 'google-loading' || step === 'google-wallet-setup') && (
        <div style={{ padding: '24px 0', textAlign: 'center' }}>
          <div style={{ marginBottom: 20 }}>
            <Loader2 size={40} color="#4F46E5" style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
          </div>
          <p style={{ fontSize: 15, fontWeight: 600, color: '#0F172A', marginBottom: 8 }}>
            {googleMsg}
          </p>
          {step === 'google-wallet-setup' && (
            <p style={{ fontSize: 13, color: '#64748B', lineHeight: 1.6 }}>
              Circle will prompt you to set a PIN to protect your wallet.
              <br />Complete the setup in the popup to continue.
            </p>
          )}
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}
    </Modal>
  );
}
