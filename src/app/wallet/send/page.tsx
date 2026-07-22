'use client';
/**
 * @file app/wallet/send/page.tsx
 * Send USDC, EURC, or cirBTC to any EVM address with an optional memo.
 *
 * Memo strategy — CHANGED: the previous version fired a SEPARATE
 * writeContract() call to the Arc Memo contract right after the transfer
 * confirmed, purely to log the remark on-chain. Every writeContract call
 * prompts a real wallet signature — so a successful send was immediately
 * followed by a second, unexplained signature request for a purely
 * informational side-effect. That's confusing by design, not a bug in the
 * mechanism itself, so it's removed rather than reworked: the remark is
 * now only stored in the local tx record (see saveTxRecord below), which
 * is enough for the transaction history UI without a second on-chain write
 * and a second signature prompt.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { usePublicClient, useReadContract } from 'wagmi';
import { getAddress } from 'viem';
import { ArrowLeft, ExternalLink, CheckCircle2, X, Loader2, Send, ChevronDown } from 'lucide-react';
import { AppLayout }  from '@/components/layout/AppLayout';
import { NetworkGuard } from '@/components/shared/NetworkGuard';
import { useApp } from '@/context/AppContext';
import { useEffectiveAddress, walletRequiredMessage } from '@/lib/useEffectiveAddress';
import { ERC20_ABI } from '@/lib/contracts/abis';
import { CONTRACTS, arcTestnet, txLink } from '@/lib/contracts/config';
import { waitForSuccessfulReceipt } from '@/lib/txReceipt';
import { TOKEN_ICON_PATHS, tokenIconRenderSize } from '@/lib/token-registry';
import { useUniversalWrite } from '@/lib/circle/useUniversalWrite';

function genRef() { return 'SLD-' + Math.random().toString(36).slice(2, 8).toUpperCase(); }

/** Renders a token's real logo clipped to a size x size circle, zooming
 *  EURC's <img> in slightly to compensate for its source SVG's padding so
 *  every token icon reads as the same visual size (see
 *  lib/token-registry.ts's tokenIconRenderSize for why). Renders nothing
 *  if there's no real logo for the symbol. */
function TokenIconImg({ symbol, size }: { symbol: string; size: number }) {
  const path = TOKEN_ICON_PATHS[symbol];
  if (!path) return null;
  const renderSize = tokenIconRenderSize(symbol, size);
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%', overflow: 'hidden',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={path} alt="" width={renderSize} height={renderSize} style={{ display: 'block', objectFit: 'cover' }} />
    </span>
  );
}

// Next.js only statically replaces `process.env.NEXT_PUBLIC_X` when it sees
// that exact literal — see wallet/page.tsx for the fuller note. Same
// pattern here, kept in sync with that file's token list.
const ENV_TOKEN_ADDRESSES: Record<string, string | undefined> = {
  NEXT_PUBLIC_EURC_ADDRESS:   process.env.NEXT_PUBLIC_EURC_ADDRESS,
  NEXT_PUBLIC_CIRBTC_ADDRESS: process.env.NEXT_PUBLIC_CIRBTC_ADDRESS,
};

interface SendToken {
  symbol: string;
  name: string;
  address: string | undefined;
  decimals: number;
}

const SEND_TOKENS: SendToken[] = [
  { symbol: 'USDC',   name: 'USD Coin',        address: CONTRACTS.USDC,                                  decimals: 6 },
  { symbol: 'EURC',   name: 'Euro Coin',       address: ENV_TOKEN_ADDRESSES.NEXT_PUBLIC_EURC_ADDRESS,   decimals: 6 },
  { symbol: 'cirBTC', name: 'Circle Bitcoin',  address: ENV_TOKEN_ADDRESSES.NEXT_PUBLIC_CIRBTC_ADDRESS, decimals: 8 },
].filter((t): t is SendToken & { address: string } => !!t.address);

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
  const { address, loginMethod } = useEffectiveAddress();
  const pc           = usePublicClient({ chainId: arcTestnet.id });
  const { saveTxRecord } = useApp();
  const { writeContract: universalWrite, canWrite } = useUniversalWrite();

  const [tokenSymbol, setTokenSymbol] = useState(SEND_TOKENS[0]?.symbol ?? 'USDC');
  const [tokenMenuOpen, setTokenMenuOpen] = useState(false);
  const token = useMemo(
    () => SEND_TOKENS.find(t => t.symbol === tokenSymbol) ?? SEND_TOKENS[0],
    [tokenSymbol],
  );

  const [to,       setTo]       = useState('');
  const [amount,   setAmount]   = useState('');
  const [remark,   setRemark]   = useState('');
  const [toErr,    setToErr]    = useState('');
  const [amtErr,   setAmtErr]   = useState('');
  const [sending,  setSending]  = useState(false);
  const [status,   setStatus]   = useState<SendStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [successTx, setSuccessTx] = useState<string | null>(null);

  // Real ERC-20 balance of the SELECTED token — the previous version read
  // wagmi's native-token useBalance() unconditionally and labeled it
  // "USDC", but Arc's native balance (18 decimals) and the ERC-20 USDC
  // interface actually transferred here (6 decimals) are two different
  // balances (see lib/contracts/config.ts's own note on this). Reading the
  // real balance of whichever token is actually being sent fixes both the
  // mismatch and the single-token limitation in one pass.
  const { data: rawBalance, refetch: refetchBalance } = useReadContract({
    address: token?.address as `0x${string}` | undefined,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address as `0x${string}`] : undefined,
    query: { enabled: !!address && !!token?.address },
  });
  const formattedBalance = token && rawBalance != null
    ? (Number(rawBalance) / 10 ** token.decimals).toString()
    : undefined;

  useEffect(() => { refetchBalance(); }, [tokenSymbol, refetchBalance]);

  const handleSend = useCallback(async () => {
    const tErr = validateAddress(to);
    const aErr = validateAmount(amount, formattedBalance);
    setToErr(tErr); setAmtErr(aErr);
    if (tErr || aErr || !canWrite || !pc || !address || !token) {
      if (!canWrite) setAmtErr(walletRequiredMessage(loginMethod));
      return;
    }

    setSending(true);
    try {
      const checksumTo = getAddress(to) as `0x${string}`;
      const tokenAddr  = token.address as `0x${string}`;
      const rawAmt     = BigInt(Math.round(parseFloat(amount) * 10 ** token.decimals));
      const ref = genRef();

      setStatus('sending');
      // Direct ERC-20 transfer — msg.sender is the user's wallet (correct)
      const txHash = await universalWrite({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [checksumTo, rawAmt],
      }, msg => setStatusMessage(msg));

      setStatus('confirming');
      await waitForSuccessfulReceipt(pc, txHash);
      setSuccessTx(txHash);
      refetchBalance();

      // Record locally so it shows up in Transaction History — this was
      // never being saved anywhere before, which is why sent transfers
      // never appeared there.
      await saveTxRecord({
        id: txHash, hash: txHash, ref,
        type: 'other', status: 'success',
        amount, token: token.symbol,
        remark: remark.trim() || undefined,
        recipientCount: 1,
        timestamp: Date.now(),
        invoiceEmailStatus: null,
        executedBy: 'manual',
      }, address);

    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (/reject|cancel|denied/i.test(msg)) setAmtErr('Transaction cancelled.');
      else setAmtErr('Send failed — please try again.');
    } finally {
      setSending(false);
      setStatus('idle');
      setStatusMessage('');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, amount, remark, canWrite, universalWrite, pc, address, token, formattedBalance, saveTxRecord, refetchBalance, loginMethod]);

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
          <button onClick={() => router.back()} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#14B8A6', fontFamily: 'inherit', padding: 0 }}>
            <ArrowLeft size={16} /> Back
          </button>

          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 20, padding: 24 }}>
            <h2 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', marginBottom: 6 }}>Send {token?.symbol ?? 'Tokens'}</h2>
            <p style={{ fontSize: 14, color: '#64748B', marginBottom: 24 }}>Transfer tokens to any wallet on Arc Testnet.</p>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Recipient Address *</label>
              <input value={to} onChange={e => { setTo(e.target.value); setToErr(''); }}
                placeholder="0x…" style={{ ...inp, borderColor: toErr ? '#FCA5A5' : '#E2E8F0', fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}
                onFocus={e => { e.target.style.borderColor = '#14B8A6'; }}
                onBlur={e => { e.target.style.borderColor = toErr ? '#FCA5A5' : '#E2E8F0'; }} />
              {toErr && <p style={{ fontSize: 12, color: '#DC2626', marginTop: 4 }}>{toErr}</p>}
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Amount *</label>
              <div style={{ position: 'relative', display: 'flex', border: `1.5px solid ${amtErr ? '#FCA5A5' : '#E2E8F0'}`, borderRadius: 10, overflow: 'visible' }}>
                {/* Token selector — left side of the amount field */}
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => setTokenMenuOpen(v => !v)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '0 12px', height: '100%', minHeight: 46,
                      background: '#F8FAFC', border: 'none',
                      borderRight: '1.5px solid #E2E8F0',
                      borderRadius: '10px 0 0 10px',
                      cursor: SEND_TOKENS.length > 1 ? 'pointer' : 'default',
                      fontFamily: 'inherit', fontSize: 13, fontWeight: 700, color: '#0F172A',
                    }}
                    disabled={SEND_TOKENS.length <= 1}
                  >
                    <TokenIconImg symbol={token?.symbol ?? ''} size={18} />
                    {token?.symbol ?? '—'}
                    {SEND_TOKENS.length > 1 && <ChevronDown size={13} color="#94A3B8" />}
                  </button>

                  {tokenMenuOpen && SEND_TOKENS.length > 1 && (
                    <>
                      <div onClick={() => setTokenMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 10 }} />
                      <div style={{
                        position: 'absolute', top: '110%', left: 0, zIndex: 11,
                        background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12,
                        boxShadow: '0 8px 24px rgba(15,23,42,0.12)', minWidth: 180, overflow: 'hidden',
                      }}>
                        {SEND_TOKENS.map(t => (
                          <button
                            key={t.symbol}
                            type="button"
                            onClick={() => { setTokenSymbol(t.symbol); setTokenMenuOpen(false); setAmtErr(''); }}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                              padding: '10px 14px', background: t.symbol === tokenSymbol ? '#F0FDFA' : 'transparent',
                              border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                            }}
                          >
                            <TokenIconImg symbol={t.symbol} size={22} />
                            <span>
                              <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{t.symbol}</div>
                              <div style={{ fontSize: 11, color: '#94A3B8' }}>{t.name}</div>
                            </span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                <input type="number" value={amount} onChange={e => { setAmount(e.target.value); setAmtErr(''); }}
                  placeholder="0.00" min="0" step="0.01"
                  style={{ flex: 1, border: 'none', outline: 'none', padding: '12px 14px', fontFamily: 'inherit', fontSize: 14, color: '#0F172A', borderRadius: '0 10px 10px 0' }} />
              </div>
              {formattedBalance && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                  <span style={{ fontSize: 12, color: '#94A3B8' }}>Balance: {parseFloat(formattedBalance).toLocaleString('en-US', { minimumFractionDigits: 2 })} {token?.symbol}</span>
                  <button onClick={() => setAmount(formattedBalance)} style={{ fontSize: 12, fontWeight: 700, color: '#14B8A6', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>Max</button>
                </div>
              )}
              {amtErr && <p style={{ fontSize: 12, color: '#DC2626', marginTop: 4 }}>{amtErr}</p>}
            </div>

            <div style={{ marginBottom: 24 }}>
              <label style={labelStyle}>Remark <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: '#94A3B8' }}>(optional — shown in transaction history)</span></label>
              <textarea value={remark} onChange={e => setRemark(e.target.value)}
                placeholder="e.g. Freelance payment, October" rows={2}
                style={{ ...inp, resize: 'vertical', minHeight: 72 }}
                onFocus={e => { e.target.style.borderColor = '#14B8A6'; }}
                onBlur={e => { e.target.style.borderColor = '#E2E8F0'; }} />
            </div>

            <button onClick={handleSend} disabled={sending || !address}
              style={{ width: '100%', padding: '14px 0', borderRadius: 12, background: sending || !address ? '#E2E8F0' : '#14B8A6', border: 'none', color: sending || !address ? '#94A3B8' : '#fff', fontSize: 15, fontWeight: 700, cursor: sending || !address ? 'not-allowed' : 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              {sending ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />{statusMessage || statusLabel[status]}</> : <><Send size={16} /> Send {token?.symbol}</>}
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
              {/* Filled green circle, white check, faded glow — was an
                  outlined check on a pale background before. */}
              <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#059669', boxShadow: '0 0 0 8px rgba(5,150,105,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <CheckCircle2 size={34} color="#fff" fill="#059669" />
              </div>
              <h3 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', marginBottom: 8 }}>Sent Successfully</h3>
              <p style={{ fontSize: 13, color: '#64748B', marginBottom: 16 }}>{amount} {token?.symbol} sent to {to.slice(0, 8)}…{to.slice(-6)}</p>
              <a href={txLink(successTx)} target="_blank" rel="noreferrer"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#14B8A6', fontFamily: "'JetBrains Mono', monospace" }}>
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
