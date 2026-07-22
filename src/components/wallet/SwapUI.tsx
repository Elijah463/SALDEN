/**
 * @file components/wallet/SwapUI.tsx
 * Presentational components for the swap page (token icon/selector/input
 * box, step progress). Extracted from app/wallet/swap/page.tsx so a
 * rendering/styling bug has one obvious place to look, independent of
 * quote-fetching or execution logic.
 */

'use client';

import { useState } from 'react';
import { ChevronDown, Loader2, CheckCircle2 } from 'lucide-react';
import { TOKEN_ICON_PATHS, tokenIconRenderSize } from '@/lib/token-registry';
import { TOKENS, type TokenMeta, type ChainToken } from '@/lib/swap/tokens';

export function TokenIcon({ token, size = 28 }: { token: TokenMeta; size?: number }) {
  const iconPath = TOKEN_ICON_PATHS[token.symbol];
  if (iconPath) {
    const renderSize = tokenIconRenderSize(token.symbol, size);
    return (
      <div style={{
        width: size, height: size, borderRadius: '50%', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={iconPath} alt={token.symbol} width={renderSize} height={renderSize}
          style={{ display: 'block', objectFit: 'cover' }} />
      </div>
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: token.color,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, color: '#fff', fontWeight: 800,
      fontSize: size * 0.42,
    }}>
      {token.icon}
    </div>
  );
}

export function TokenSelector({
  value, exclude, onChange,
}: { value: TokenMeta | null; exclude?: ChainToken; onChange: (t: TokenMeta) => void }) {
  const [open, setOpen] = useState(false);
  const options = TOKENS.filter(t => t.symbol !== exclude);

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(p => !p)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '8px 12px', borderRadius: 99,
          background: '#fff', border: '1.5px solid #E2E8F0',
          cursor: 'pointer', fontFamily: 'inherit',
          fontWeight: 700, fontSize: 14, color: '#0F172A',
          minWidth: 130,
        }}
      >
        {value
          ? <><TokenIcon token={value} size={20} /> {value.symbol}</>
          : <span style={{ color: '#14B8A6' }}>Select</span>}
        <ChevronDown size={13} color="#94A3B8" style={{ marginLeft: 'auto' }} />
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 10 }} />
          <div style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 8, zIndex: 20,
            background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12,
            boxShadow: '0 8px 24px rgba(0,0,0,0.10)', minWidth: 180, overflow: 'hidden',
          }}>
            {options.map(t => (
              <button key={t.symbol}
                onClick={() => { onChange(t); setOpen(false); }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                  padding: '12px 16px', background: 'none', border: 'none',
                  cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#F8F9FA'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
              >
                <TokenIcon token={t} size={22} />
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{t.symbol}</div>
                  <div style={{ fontSize: 11, color: '#94A3B8' }}>{t.name}</div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function TokenBox({
  label, token, excludeToken, amount, editable,
  onTokenChange, onAmountChange, loading,
}: {
  label:          string;
  token:          TokenMeta | null;
  excludeToken?:  ChainToken;
  amount:         string;
  editable:       boolean;
  onTokenChange:  (t: TokenMeta) => void;
  onAmountChange?: (v: string) => void;
  loading?:       boolean;
}) {
  return (
    <div style={{
      background: '#F8F9FA', borderRadius: 16, padding: '16px 18px',
      border: '1.5px solid #F1F5F9',
    }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#94A3B8',
        textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 10 }}>
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <TokenSelector value={token} exclude={excludeToken} onChange={onTokenChange} />
        <div style={{ flex: 1, textAlign: 'right' }}>
          {editable ? (
            <input
              type="number" value={amount} min="0" step="any"
              onChange={e => onAmountChange?.(e.target.value)}
              placeholder="0.00"
              style={{
                width: '100%', background: 'none', border: 'none', outline: 'none',
                fontSize: 24, fontWeight: 800, color: '#0F172A',
                textAlign: 'right', fontFamily: "'JetBrains Mono', monospace",
              }}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', minHeight: 36 }}>
              {loading
                ? <Loader2 size={20} color="#94A3B8" style={{ animation: 'spin 0.7s linear infinite' }} />
                : <span style={{ fontSize: 24, fontWeight: 800, color: '#0F172A',
                    fontFamily: "'JetBrains Mono', monospace" }}>
                    {amount || '—'}
                  </span>
              }
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const SWAP_STEPS = [
  { key: 'approve', label: 'Approve token spending' },
  { key: 'swap',    label: 'Execute swap on-chain'  },
  { key: 'confirm', label: 'Confirm transaction'    },
] as const;

export function StepProgress({ currentStep }: { currentStep: string }) {
  return (
    <div style={{ marginTop: 16 }}>
      {SWAP_STEPS.map((step, i) => {
        const done    = SWAP_STEPS.findIndex(s => s.key === currentStep) > i;
        const active  = step.key === currentStep;
        return (
          <div key={step.key} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <div style={{
              width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
              background: done ? '#14B8A6' : active ? '#4F46E5' : '#E2E8F0',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {done
                ? <CheckCircle2 size={13} color="#fff" />
                : active
                  ? <Loader2 size={13} color="#fff" style={{ animation: 'spin 0.7s linear infinite' }} />
                  : <span style={{ fontSize: 10, color: '#94A3B8', fontWeight: 700 }}>{i + 1}</span>
              }
            </div>
            <span style={{ fontSize: 13, color: done ? '#14B8A6' : active ? '#4F46E5' : '#94A3B8', fontWeight: active ? 700 : 500 }}>
              {step.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
