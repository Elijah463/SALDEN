'use client';
/**
 * @file app/wallet/deposit/page.tsx
 * Deposit options: From Other Wallet (QR + address), With Cards (soon), Via Bank Transfer (soon).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Copy, CheckCircle2, CreditCard, Building2, Wallet } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { copyToClipboard } from '@/lib/clipboard';

function QRCode({ address }: { address: string }) {
  // Simple SVG QR placeholder — in production integrate qrcode.react
  const size = 200;
  return (
    <div style={{
      width: size, height: size, margin: '0 auto',
      background: '#fff', border: '2px solid #E2E8F0', borderRadius: 12,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 8, padding: 16,
    }}>
      <svg width={size - 32} height={size - 32} viewBox="0 0 160 160">
        {/* Top-left finder */}
        <rect x="10" y="10" width="40" height="40" rx="4" fill="none" stroke="#4F46E5" strokeWidth="4"/>
        <rect x="18" y="18" width="24" height="24" rx="2" fill="#4F46E5"/>
        {/* Top-right finder */}
        <rect x="110" y="10" width="40" height="40" rx="4" fill="none" stroke="#4F46E5" strokeWidth="4"/>
        <rect x="118" y="18" width="24" height="24" rx="2" fill="#4F46E5"/>
        {/* Bottom-left finder */}
        <rect x="10" y="110" width="40" height="40" rx="4" fill="none" stroke="#4F46E5" strokeWidth="4"/>
        <rect x="18" y="118" width="24" height="24" rx="2" fill="#4F46E5"/>
        {/* Data dots (visual only) */}
        {Array.from({ length: 64 }).map((_, i) => {
          const seed = (parseInt(address.slice(2 + (i % 40), 4 + (i % 40)), 16) + i) % 3;
          if (seed === 0) return null;
          const col = (i % 8) * 10 + 60;
          const row = Math.floor(i / 8) * 10 + 10;
          if (col > 100 && row < 60) return null;
          if (col < 60 && row > 100) return null;
          return <rect key={i} x={col} y={row} width="8" height="8" rx="1.5" fill="#4F46E5" />;
        })}
      </svg>
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
      onMouseEnter={e => { if (!soon) (e.currentTarget as HTMLButtonElement).style.borderColor = '#4F46E5'; }}
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
        {/* Back */}
        <button onClick={() => view === 'qr' ? setView('options') : router.back()}
          style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#4F46E5', fontFamily: 'inherit', padding: 0 }}>
          <ArrowLeft size={16} /> Back
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
