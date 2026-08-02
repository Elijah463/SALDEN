'use client';
/**
 * @file app/wallet/deposit/page.tsx
 * Deposit options: From Other Wallet (QR + address), With Cards (soon), Via Bank Transfer (soon).
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Copy, CheckCircle2, CreditCard, Building2, Wallet } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { copyToClipboard } from '@/lib/clipboard';

function QRCode({ address }: { address: string }) {
  // Real, scannable QR code (previously a hand-drawn decorative SVG that
  // wasn't actually encoding the address at all — scanning it with any
  // real QR reader would return nothing usable). Generated client-side via
  // the `qrcode` package (pure JS, no native deps, MIT licensed, the
  // standard choice for this — github.com/soldair/node-qrcode).
  const size = 200;
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    setDataUrl(null);
    import('qrcode')
      .then(QRCodeLib => QRCodeLib.toDataURL(address, {
        width: (size - 32) * 2, // 2x for crisp rendering on high-DPI screens
        margin: 1,
        color: { dark: '#0F172A', light: '#FFFFFF' },
        errorCorrectionLevel: 'M',
      }))
      .then(url => { if (!cancelled) setDataUrl(url); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [address]);

  return (
    <div style={{
      width: size, height: size, margin: '0 auto',
      background: '#fff', border: '2px solid #E2E8F0', borderRadius: 12,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 8, padding: 16,
    }}>
      {error ? (
        <p style={{ fontSize: 12, color: '#94A3B8', textAlign: 'center' }}>
          Couldn&apos;t generate QR code — use the address below instead.
        </p>
      ) : dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={dataUrl} alt={`QR code for ${address}`} width={size - 32} height={size - 32} />
      ) : (
        <div style={{ width: size - 32, height: size - 32, background: '#F8FAFC', borderRadius: 8 }} />
      )}
    </div>
  );
}

function OptionTile({
  icon, label, subtitle, onClick, soon,
}: {
  icon: React.ReactNode; label: string; subtitle?: string;
  onClick?: () => void; soon?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={soon}
      style={{
        width: '100%', textAlign: 'left',
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '18px 20px', borderRadius: 14,
        border: '1.5px solid #E2E8F0', background: '#fff',
        cursor: soon ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
        position: 'relative', opacity: soon ? 0.7 : 1,
        transition: 'border-color 0.15s',
      }}
      onMouseEnter={e => { if (!soon) (e.currentTarget as HTMLButtonElement).style.borderColor = '#14B8A6'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#E2E8F0'; }}
    >
      {soon && (
        <span style={{
          position: 'absolute', top: 10, right: 12,
          background: '#4F46E5', color: '#fff',
          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
          letterSpacing: '0.04em',
        }}>SOON</span>
      )}
      <div style={{
        width: 44, height: 44, borderRadius: 12,
        background: '#EEF2FF', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {icon}
      </div>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>{label}</div>
        {subtitle && <div style={{ fontSize: 13, color: '#64748B', marginTop: 2 }}>{subtitle}</div>}
      </div>
    </button>
  );
}

export default function DepositPage() {
  const router = useRouter();
  const { address } = useEffectiveAddress();
  const [view, setView] = useState<'options' | 'qr'>('options');
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!address) return;
    const ok = await copyToClipboard(address);
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
  }

  return (
    <AppLayout title="Deposit">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Back — styled to match wallet/swap and wallet/bridge's back button */}
        <button onClick={() => view === 'qr' ? setView('options') : router.push('/wallet')}
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500, color: '#64748B', fontFamily: 'inherit', padding: 0 }}>
          <ArrowLeft size={15} /> {view === 'qr' ? 'Back' : 'Back to Wallet'}
        </button>

        {view === 'options' ? (
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 20, padding: 24 }}>
            <h2 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', marginBottom: 6 }}>Deposit Funds</h2>
            <p style={{ fontSize: 14, color: '#64748B', marginBottom: 24 }}>Choose how to add funds to your wallet.</p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <OptionTile
                icon={<Wallet size={20} color="#4F46E5" />}
                label="From Other Wallet"
                subtitle="Send USDC from any EVM wallet"
                onClick={() => setView('qr')}
              />
              <OptionTile
                icon={<CreditCard size={20} color="#4F46E5" />}
                label="With Cards"
                subtitle="Pay with debit or credit card"
                soon
              />
              <OptionTile
                icon={<Building2 size={20} color="#4F46E5" />}
                label="Via Bank Transfer"
                subtitle="ACH / SWIFT bank transfer"
                soon
              />
            </div>
          </div>
        ) : (
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 20, padding: 24, textAlign: 'center' }}>
            <h2 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', marginBottom: 6 }}>Your Deposit Address</h2>
            <p style={{ fontSize: 14, color: '#64748B', marginBottom: 24 }}>
              Send USDC on Arc Testnet to this address. Only send supported assets.
            </p>

            {address ? (
              <>
                <QRCode address={address} />
                <div style={{
                  marginTop: 20, padding: '12px 16px',
                  background: '#F8F9FA', borderRadius: 10,
                  border: '1px solid #E2E8F0',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 13, color: '#0F172A',
                  wordBreak: 'break-all', lineHeight: 1.6,
                }}>
                  {address}
                </div>
                <button
                  onClick={handleCopy}
                  style={{
                    marginTop: 14, display: 'inline-flex', alignItems: 'center', gap: 8,
                    padding: '11px 24px', borderRadius: 10,
                    background: copied ? '#ECFDF5' : '#14B8A6',
                    border: 'none', color: copied ? '#059669' : '#fff',
                    fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                    transition: 'all 0.2s',
                  }}
                >
                  {copied ? <CheckCircle2 size={16} /> : <Copy size={16} />}
                  {copied ? 'Copied!' : 'Copy Address'}
                </button>
              </>
            ) : (
              <p style={{ color: '#94A3B8', fontSize: 14 }}>Connect your wallet to get your deposit address.</p>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
