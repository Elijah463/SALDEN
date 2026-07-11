'use client';
/**
 * @file app/wallet/send/page.tsx
 * Send USDC to any EVM address with an optional on-chain memo.
 *
 * Decimal note: USDC ERC-20 transfer uses 6 decimals.
 *
 * Memo strategy:
 *   Direct ERC-20 transfer(to, amount) is called from the user's wallet.
 *   AFTER the transfer confirms, we fire-and-forget a separate call to the
 *   Arc Memo contract (zero-address target, empty calldata) just to anchor
 *   the JSON memo as an on-chain event. This keeps the actual transfer clean
 *   and avoids the msg.sender problem that would occur if we routed the
 *   transfer THROUGH the Memo contract.
 */

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useWalletClient, usePublicClient, useBalance } from 'wagmi';
import { getAddress, keccak256 } from 'viem';
import { ArrowLeft, ExternalLink, CheckCircle2, X, Loader2, Send } from 'lucide-react';
import { AppLayout }  from '@/components/layout/AppLayout';
import { NetworkGuard } from '@/components/shared/NetworkGuard';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { ERC20_ABI, MEMO_ABI, MEMO_CONTRACT_ADDRESS } from '@/lib/contracts/abis';
import { CONTRACTS, arcTestnet, txLink } from '@/lib/contracts/config';
import { waitForSuccessfulReceipt } from '@/lib/txReceipt';

function genRef() { return 'SLD-' + Math.random().toString(36).slice(2, 8).toUpperCase(); }

// Converts a string to its 0x-prefixed hex representation for viem bytes args
function strToHex(s: string): `0x${string}` {
  const bytes = new TextEncoder().encode(s);
  return ('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

// Pure validators — defined outside component so they are stable references
function validateAddress(val: string): string {
  try { getAddress(val); return ''; }
  catch { return 'Invalid wallet address.'; }
}
function validateAmount(val: string, formattedBalance?: string): string {
  const n = parseFloat(val);
  if (isNaN(n) || n <= 0) return 'Enter a valid amount.';
  if (formattedBalance && n > parseFloat(formattedBalance)) return 'Insufficient balance.';
  return '';
}

type SendStatus = 'idle' | 'sending' | 'confirming';

export default function SendPage() {
  const router       = useRouter();
  const { address }  = useEffectiveAddress();
  const { data: wc } = useWalletClient();
  const pc           = usePublicClient({ chainId: arcTestnet.id });

  const [to,       setTo]       = useState('');
  const [amount,   setAmount]   = useState('');
  const [remark,   setRemark]   = useState('');
  const [toErr,    setToErr]    = useState('');
  const [amtErr,   setAmtErr]   = useState('');
  const [sending,  setSending]  = useState(false);
  const [status,   setStatus]   = useState<SendStatus>('idle');
  const [successTx, setSuccessTx] = useState<string | null>(null);

  const { data: balance } = useBalance({
    address: address as `0x${string}` | undefined,
    query: { enabled: !!address },
  });

  const handleSend = useCallback(async () => {
    const tErr = validateAddress(to);
    const aErr = validateAmount(amount, balance?.formatted);
    setToErr(tErr); setAmtErr(aErr);
    if (tErr || aErr || !wc || !pc || !address) return;

    setSending(true);
    try {
      const checksumTo = getAddress(to) as `0x${string}`;
      const usdcAddr   = CONTRACTS.USDC as `0x${string}`;
      // ERC-20 USDC: 6 decimals for transfer args
      const rawAmt     = BigInt(Math.round(parseFloat(amount) * 1_000_000));

      setStatus('sending');
      // Direct ERC-20 transfer — msg.sender is the user's wallet (correct)
      const txHash = await wc.writeContract({
        address: usdcAddr,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [checksumTo, rawAmt],
      });

      setStatus('confirming');
      await waitForSuccessfulReceipt(pc, txHash);
      setSuccessTx(txHash);

      // After confirmation: fire-and-forget memo log to Arc Memo contract.
      // Uses zero-address target with empty calldata — just emits the Memo event.
      // Failure is intentionally silent; the transfer already succeeded.
      const memoHex = strToHex(JSON.stringify({
        ref: genRef(), date: new Date().toISOString(),
        remark: remark.trim() || 'Transfer',
        type: 'send', from: address, to: checksumTo,
        amount, token: 'USDC',
      }));
      wc.writeContract({
        address: MEMO_CONTRACT_ADDRESS, abi: MEMO_ABI,
        functionName: 'memo',
        args: ['0x0000000000000000000000000000000000000000', '0x', keccak256(memoHex), memoHex],
      }).catch(() => {});

    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (/reject|cancel|denied/i.test(msg)) setAmtErr('Transaction cancelled.');
      else setAmtErr('Send failed — please try again.');
    } finally {
      setSending(false);
      setStatus('idle');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, amount, remark, wc, pc, address, balance]);

  const statusLabel: Record<SendStatus, string> = {
    idle: '', sending: 'Sending…', confirming: 'Confirming on-chain…',
  };

  const inp: React.CSSProperties = {
    width: '100%', padding: '12px 14px', border: '1.5px solid #E2E8F0',
    borderRadius: 10, fontFamily: 'inherit', fontSize: 14,
    color: '#0F172A', background: '#fff', outline: 'none', boxSizing: 'border-box',
  };
  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: 12, fontWeight: 600, color: '#475569',
    marginBottom: 6, letterSpacing: '0.04em', textTransform: 'uppercase',
  };

  return (
    <NetworkGuard>
      <AppLayout title="Send">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <button onClick={() => router.back()} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#4F46E5', fontFamily: 'inherit', padding: 0 }}>
            <ArrowLeft size={16} /> Back
          </button>

          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 20, padding: 24 }}>
            <h2 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', marginBottom: 6 }}>Send USDC</h2>
            <p style={{ fontSize: 14, color: '#64748B', marginBottom: 24 }}>Transfer USDC to any wallet on Arc Testnet.</p>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Recipient Address *</label>
              <input value={to} onChange={e => { setTo(e.target.value); setToErr(''); }}
                placeholder="0x…" style={{ ...inp, borderColor: toErr ? '#FCA5A5' : '#E2E8F0', fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}
                onFocus={e => { e.target.style.borderColor = '#4F46E5'; }}
                onBlur={e => { e.target.style.borderColor = toErr ? '#FCA5A5' : '#E2E8F0'; }} />
              {toErr && <p style={{ fontSize: 12, color: '#DC2626', marginTop: 4 }}>{toErr}</p>}
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Amount (USDC) *</label>
              <div style={{ position: 'relative' }}>
                <input type="number" value={amount} onChange={e => { setAmount(e.target.value); setAmtErr(''); }}
                  placeholder="0.00" min="0" step="0.01"
                  style={{ ...inp, borderColor: amtErr ? '#FCA5A5' : '#E2E8F0', paddingRight: 60 }}
                  onFocus={e => { e.target.style.borderColor = '#4F46E5'; }}
                  onBlur={e => { e.target.style.borderColor = amtErr ? '#FCA5A5' : '#E2E8F0'; }} />
                <span style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', fontSize: 12, fontWeight: 700, color: '#94A3B8' }}>USDC</span>
              </div>
              {balance && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                  <span style={{ fontSize: 12, color: '#94A3B8' }}>Balance: {parseFloat(balance.formatted).toLocaleString('en-US', { minimumFractionDigits: 2 })} USDC</span>
                  <button onClick={() => setAmount(balance.formatted)} style={{ fontSize: 12, fontWeight: 700, color: '#14B8A6', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>Max</button>
                </div>
              )}
              {amtErr && <p style={{ fontSize: 12, color: '#DC2626', marginTop: 4 }}>{amtErr}</p>}
            </div>

            <div style={{ marginBottom: 24 }}>
              <label style={labelStyle}>Remark <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: '#94A3B8' }}>(optional — logged on-chain)</span></label>
              <textarea value={remark} onChange={e => setRemark(e.target.value)}
                placeholder="e.g. Freelance payment, October" rows={2}
                style={{ ...inp, resize: 'vertical', minHeight: 72 }}
                onFocus={e => { e.target.style.borderColor = '#4F46E5'; }}
                onBlur={e => { e.target.style.borderColor = '#E2E8F0'; }} />
            </div>

            <button onClick={handleSend} disabled={sending || !address}
              style={{ width: '100%', padding: '14px 0', borderRadius: 12, background: sending || !address ? '#E2E8F0' : '#14B8A6', border: 'none', color: sending || !address ? '#94A3B8' : '#fff', fontSize: 15, fontWeight: 700, cursor: sending || !address ? 'not-allowed' : 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              {sending ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />{statusLabel[status]}</> : <><Send size={16} /> Send USDC</>}
            </button>
          </div>
        </div>

        {successTx && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <div style={{ background: '#fff', borderRadius: 20, padding: 32, maxWidth: 380, width: '100%', textAlign: 'center', position: 'relative' }}>
              <button onClick={() => { setSuccessTx(null); setTo(''); setAmount(''); setRemark(''); }}
                style={{ position: 'absolute', top: 16, right: 16, background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8' }}>
                <X size={20} />
              </button>
              <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#ECFDF5', border: '2px solid #6EE7B7', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <CheckCircle2 size={32} color="#059669" />
              </div>
              <h3 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', marginBottom: 8 }}>Sent Successfully</h3>
              <p style={{ fontSize: 13, color: '#64748B', marginBottom: 16 }}>{amount} USDC sent to {to.slice(0, 8)}…{to.slice(-6)}</p>
              <a href={txLink(successTx)} target="_blank" rel="noreferrer"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#4F46E5', fontFamily: "'JetBrains Mono', monospace" }}>
                {successTx.slice(0, 10)}…{successTx.slice(-6)} <ExternalLink size={13} />
              </a>
            </div>
          </div>
        )}
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </AppLayout>
    </NetworkGuard>
  );
}
