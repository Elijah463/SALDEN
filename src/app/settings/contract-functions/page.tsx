'use client';

/**
 * @file app/settings/contract-functions/page.tsx
 *
 * Premium payroll contract functions — moved out of Settings into its own
 * page (previously a single inline section covering only Add Agent, Add
 * Token, and Emergency Withdrawal).
 *
 * Cross-checked against contracts/SaldenMultiTokenPayrollFactory.sol (the
 * SaldenMultiTokenPayroll clone every Premium user deploys) for every
 * function actually available on the contract. Three were already defined
 * in lib/contracts/abis.ts but never had UI built for them:
 *   - removeAgent      — addAgent existed with no way to undo it
 *   - withdraw(token)  — the routine "pull my balance" call, distinct from
 *                        emergencyWithdraw (Employer + Agent, supported
 *                        tokens only, blocked while paused)
 *   - pause / unpause  — the circuit breaker that halts batchPay/withdraw
 *
 * Token removal is NOT a contract function — SaldenMultiTokenPayroll's own
 * comments are explicit that token support is permanent by design ("Token
 * registration is permanent. A registered token can never be removed to
 * prevent stranding balances."). The "Remove" action on a token below only
 * ever touches this app's own local display registry, never the contract
 * — worded accordingly, instead of the previous copy which incorrectly
 * implied an on-chain "removeToken" call existed.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { usePublicClient } from 'wagmi';
import {
  ArrowLeft, Plus, X, Copy, ExternalLink, AlertTriangle,
  Pause, Play, UserPlus, UserMinus, Download, ShieldAlert, Zap,
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/shared/Button';
import { Modal } from '@/components/shared/Modal';
import { useApp } from '@/context/AppContext';
import { CONTRACTS, addressLink } from '@/lib/contracts/config';
import { MULTI_TOKEN_PAYROLL_ABI, REGISTRY_ABI } from '@/lib/contracts/abis';
import { truncAddr, isValidEthAddress, sanitizeString } from '@/lib/validation';
import { upsertToken, removeToken, TOKEN_ICON_PATHS, tokenIconRenderSize } from '@/lib/token-registry';
import { copyToClipboard } from '@/lib/clipboard';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { useUniversalWrite } from '@/lib/circle/useUniversalWrite';
import { useCachedSignMessage } from '@/lib/circle/useCachedSignMessage';
import { usePayrollSync } from '@/lib/usePayrollSync';
import { waitForSuccessfulReceipt } from '@/lib/txReceipt';

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, overflow: 'hidden' }}>
      <div style={{ padding: '16px 24px', borderBottom: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', gap: 8 }}>
        {icon}
        <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', margin: 0 }}>{title}</h3>
      </div>
      <div style={{ padding: '20px 24px' }}>
        {children}
      </div>
    </div>
  );
}

export default function ContractFunctionsPage() {
  const { address }  = useEffectiveAddress();
  const publicClient = usePublicClient();
  const { state, dispatch, addToast, syncData } = useApp();
  const { isPremiumUser, payrollClone, registryClone, tokenRegistry } = state;
  usePayrollSync({ registryClone, address, publicClient });

  const { writeContract: universalWrite, canWrite } = useUniversalWrite();
  const sign = useCachedSignMessage();

  // ── Shared sync+anchor (same pattern as Settings — see that file for the
  //    full writeup on why this exists) ─────────────────────────────────────
  async function syncAndAnchor() {
    const { cid } = await syncData({ walletAddress: address ?? '', signMessage: sign });
    if (!cid || !registryClone || !canWrite || !publicClient) return;
    try {
      const hash = await universalWrite({
        address: registryClone as `0x${string}`, abi: REGISTRY_ABI,
        functionName: 'updateCID', args: [cid],
      });
      await waitForSuccessfulReceipt(publicClient, hash);
    } catch (err) {
      console.error('[ContractFunctions] Failed to anchor CID onchain:', err);
    }
  }

  // ── Circuit breaker ──────────────────────────────────────────────────────
  const [paused, setPaused]           = useState<boolean | null>(null);
  const [pauseLoading, setPauseLoading] = useState(false);

  const loadPausedState = useCallback(async () => {
    if (!publicClient || !payrollClone) return;
    try {
      const result = await publicClient.readContract({
        address: payrollClone as `0x${string}`, abi: MULTI_TOKEN_PAYROLL_ABI, functionName: 'paused',
      });
      setPaused(Boolean(result));
    } catch { /* non-fatal — just leaves the toggle in its loading state */ }
  }, [publicClient, payrollClone]);

  useEffect(() => { loadPausedState(); }, [loadPausedState]);

  async function handleTogglePause() {
    if (!canWrite || !payrollClone || !publicClient || paused === null) return;
    setPauseLoading(true);
    try {
      const hash = await universalWrite({
        address: payrollClone as `0x${string}`, abi: MULTI_TOKEN_PAYROLL_ABI,
        functionName: paused ? 'unpause' : 'pause',
      });
      await waitForSuccessfulReceipt(publicClient, hash);
      addToast(paused ? 'Contract unpaused — payments and withdrawals resumed.' : 'Contract paused — payments and withdrawals halted.', 'success');
      await loadPausedState();
    } catch (err) { addToast((err as Error).message, 'error'); }
    finally { setPauseLoading(false); }
  }

  // ── Agent roles ──────────────────────────────────────────────────────────
  const [agentAddr,        setAgentAddr]        = useState('');
  const [agentLoading,     setAgentLoading]     = useState(false);
  const [removeAgentAddr,  setRemoveAgentAddr]  = useState('');
  const [removeAgentLoading, setRemoveAgentLoading] = useState(false);

  async function handleAddAgent() {
    if (!canWrite || !payrollClone || !publicClient || !isValidEthAddress(agentAddr)) {
      addToast('Enter a valid Ethereum address.', 'error'); return;
    }
    setAgentLoading(true);
    try {
      const hash = await universalWrite({
        address: payrollClone as `0x${string}`, abi: MULTI_TOKEN_PAYROLL_ABI,
        functionName: 'addAgent', args: [agentAddr as `0x${string}`],
      });
      await waitForSuccessfulReceipt(publicClient, hash);
      addToast(`Agent added. Tx: ${hash.slice(0, 12)}…`, 'success');
      setAgentAddr('');
    } catch (err) { addToast((err as Error).message, 'error'); }
    finally { setAgentLoading(false); }
  }

  async function handleRemoveAgent() {
    if (!canWrite || !payrollClone || !publicClient || !isValidEthAddress(removeAgentAddr)) {
      addToast('Enter a valid Ethereum address.', 'error'); return;
    }
    setRemoveAgentLoading(true);
    try {
      const hash = await universalWrite({
        address: payrollClone as `0x${string}`, abi: MULTI_TOKEN_PAYROLL_ABI,
        functionName: 'removeAgent', args: [removeAgentAddr as `0x${string}`],
      });
      await waitForSuccessfulReceipt(publicClient, hash);
      addToast(`Agent removed. Tx: ${hash.slice(0, 12)}…`, 'success');
      setRemoveAgentAddr('');
    } catch (err) { addToast((err as Error).message, 'error'); }
    finally { setRemoveAgentLoading(false); }
  }

  // ── Payment tokens ───────────────────────────────────────────────────────
  const [tokenForm, setTokenForm] = useState({ address: '', name: '', symbol: '', decimals: '6' });
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenError,   setTokenError]   = useState('');
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null);

  async function handleAddToken() {
    setTokenError('');
    const { address: tAddr, name, symbol, decimals } = tokenForm;

    const { registry: updated, error } = upsertToken(tokenRegistry, {
      address:  tAddr.trim(),
      name:     sanitizeString(name),
      symbol:   symbol.trim().toUpperCase(),
      decimals: Number(decimals),
      addedBy:  address ?? undefined,
    });
    if (error) { setTokenError(error); return; }

    setTokenLoading(true);
    try {
      if (canWrite && payrollClone && publicClient) {
        const hash = await universalWrite({
          address: payrollClone as `0x${string}`, abi: MULTI_TOKEN_PAYROLL_ABI,
          functionName: 'addSupportedToken', args: [tAddr.trim() as `0x${string}`],
        });
        await waitForSuccessfulReceipt(publicClient, hash);
        addToast(`Token added onchain. Tx: ${hash.slice(0, 12)}…`, 'success');
      }
      dispatch({ type: 'SET_TOKEN_REGISTRY', payload: updated });
      await syncAndAnchor();
      setTokenForm({ address: '', name: '', symbol: '', decimals: '6' });
      addToast(`${symbol.toUpperCase()} added to token registry.`, 'success');
    } catch (err) {
      setTokenError((err as Error).message);
    } finally {
      setTokenLoading(false);
    }
  }

  async function handleRemoveToken(addr: string) {
    const { registry: updated, error } = removeToken(tokenRegistry, addr);
    if (error) { addToast(error, 'error'); return; }
    dispatch({ type: 'SET_TOKEN_REGISTRY', payload: updated });
    await syncAndAnchor().catch(() => {});
    setRemoveConfirm(null);
    addToast('Removed from your local token list.', 'success');
  }

  // ── Withdrawals ──────────────────────────────────────────────────────────
  const [withdrawToken,   setWithdrawToken]   = useState('');
  const [withdrawing,     setWithdrawing]     = useState(false);
  const [emergencyOpen,   setEmergencyOpen]   = useState(false);
  const [emergencyToken,  setEmergencyToken]  = useState('');
  const [emergencyBusy,   setEmergencyBusy]   = useState(false);

  async function handleWithdraw() {
    if (!canWrite || !payrollClone || !publicClient || !isValidEthAddress(withdrawToken)) {
      addToast('Select a token to withdraw.', 'error'); return;
    }
    setWithdrawing(true);
    try {
      const hash = await universalWrite({
        address: payrollClone as `0x${string}`, abi: MULTI_TOKEN_PAYROLL_ABI,
        functionName: 'withdraw', args: [withdrawToken as `0x${string}`],
      });
      await waitForSuccessfulReceipt(publicClient, hash);
      addToast(`Withdrawal submitted. Tx: ${hash.slice(0, 12)}…`, 'success');
      setWithdrawToken('');
    } catch (err) { addToast((err as Error).message, 'error'); }
    finally { setWithdrawing(false); }
  }

  async function handleEmergencyWithdraw() {
    if (!canWrite || !payrollClone || !publicClient || !isValidEthAddress(emergencyToken)) {
      addToast('Enter a valid token address.', 'error'); return;
    }
    setEmergencyBusy(true);
    try {
      const hash = await universalWrite({
        address: payrollClone as `0x${string}`, abi: MULTI_TOKEN_PAYROLL_ABI,
        functionName: 'emergencyWithdraw', args: [emergencyToken as `0x${string}`],
      });
      await waitForSuccessfulReceipt(publicClient, hash);
      addToast(`Emergency withdrawal submitted. Tx: ${hash.slice(0, 12)}…`, 'success');
      setEmergencyOpen(false);
      setEmergencyToken('');
    } catch (err) { addToast((err as Error).message, 'error'); }
    finally { setEmergencyBusy(false); }
  }

  const inputStyle: React.CSSProperties = {
    padding: '9px 14px', border: '1.5px solid #E2E8F0',
    borderRadius: 10, fontSize: 14, fontFamily: 'inherit',
    color: '#0F172A', background: '#fff', outline: 'none', width: '100%',
  };

  // ── Not premium — same upgrade prompt the old inline section showed ──────
  if (!isPremiumUser) {
    return (
      <AppLayout title="Contract Functions">
        <div style={{ maxWidth: 780 }}>
          <Link href="/settings" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#64748B', textDecoration: 'none', marginBottom: 16 }}>
            <ArrowLeft size={14} /> Back to Settings
          </Link>
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, padding: '40px 24px', textAlign: 'center' }}>
            <Zap size={28} color="#E2E8F0" style={{ margin: '0 auto 14px' }} />
            <p style={{ fontSize: 14, color: '#94A3B8', marginBottom: 16 }}>
              Contract functions require the Premium plan and a private payroll contract.
            </p>
            <a href="/pricing" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '9px 18px', borderRadius: 10,
              background: '#14B8A6', color: '#fff',
              fontSize: 13, fontWeight: 600, textDecoration: 'none',
            }}>
              <Zap size={14} /> Upgrade to Premium
            </a>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout title="Contract Functions">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 780 }}>
        <div>
          <Link href="/settings" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#64748B', textDecoration: 'none', marginBottom: 10 }}>
            <ArrowLeft size={14} /> Back to Settings
          </Link>
          {payrollClone && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, color: '#94A3B8' }}>Your payroll contract:</span>
              <button
                onClick={() => copyToClipboard(payrollClone)}
                title="Copy address"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#4F46E5',
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {truncAddr(payrollClone)} <Copy size={10} />
              </button>
              <a href={addressLink(payrollClone)} target="_blank" rel="noreferrer" style={{ display: 'flex', color: '#94A3B8' }}>
                <ExternalLink size={10} />
              </a>
            </div>
          )}
        </div>

        {/* ── Circuit Breaker ──────────────────────────────────────────────── */}
        <Section title="Circuit Breaker" icon={paused ? <Pause size={16} color="#DC2626" /> : <Play size={16} color="#059669" />}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <p style={{ fontSize: 13, color: '#64748B', margin: 0, lineHeight: 1.6 }}>
                {paused === null
                  ? 'Checking current status…'
                  : paused
                    ? 'Your contract is currently paused — batchPay and withdraw are both halted.'
                    : 'Your contract is active. Pausing immediately halts batchPay and withdraw until you unpause.'}
              </p>
            </div>
            <Button
              variant={paused ? 'brand' : 'danger'}
              icon={paused ? <Play size={14} /> : <Pause size={14} />}
              loading={pauseLoading}
              disabled={paused === null}
              onClick={handleTogglePause}
              size="sm"
            >
              {paused ? 'Unpause' : 'Pause'}
            </Button>
          </div>
        </Section>

        {/* ── Agent Roles ──────────────────────────────────────────────────── */}
        <Section title="Agent Roles">
          <p style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 8 }}>
            Authorise AI Agent Wallet
          </p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
            <input
              value={agentAddr}
              onChange={e => setAgentAddr(e.target.value)}
              placeholder="Agent wallet address (0x…)"
              style={{ ...inputStyle, flex: 1, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
              maxLength={42}
              onFocus={e => (e.target.style.borderColor = '#4F46E5')}
              onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
            />
            <Button variant="brand" icon={<UserPlus size={14} />} loading={agentLoading} onClick={handleAddAgent} size="sm">
              Add
            </Button>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid #F1F5F9', margin: '16px 0' }} />

          <p style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 8 }}>
            Revoke Agent Wallet
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={removeAgentAddr}
              onChange={e => setRemoveAgentAddr(e.target.value)}
              placeholder="Agent wallet address (0x…)"
              style={{ ...inputStyle, flex: 1, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
              maxLength={42}
              onFocus={e => (e.target.style.borderColor = '#4F46E5')}
              onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
            />
            <Button variant="danger" icon={<UserMinus size={14} />} loading={removeAgentLoading} onClick={handleRemoveAgent} size="sm">
              Revoke
            </Button>
          </div>
        </Section>

        {/* ── Payment Tokens ───────────────────────────────────────────────── */}
        <Section title="Payment Tokens">
          <p style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 12 }}>
            Add Payment Token
          </p>
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>
              Contract Address
            </label>
            <input
              value={tokenForm.address}
              onChange={e => { setTokenForm(p => ({ ...p, address: e.target.value })); setTokenError(''); }}
              placeholder="0x… (ERC-20 contract address)"
              maxLength={42}
              style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
              onFocus={e => (e.target.style.borderColor = '#4F46E5')}
              onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>
                Token Name
              </label>
              <input
                value={tokenForm.name}
                onChange={e => { setTokenForm(p => ({ ...p, name: e.target.value })); setTokenError(''); }}
                placeholder="e.g. USD Coin"
                maxLength={40}
                style={inputStyle}
                onFocus={e => (e.target.style.borderColor = '#4F46E5')}
                onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
              />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>
                Symbol
              </label>
              <input
                value={tokenForm.symbol}
                onChange={e => { setTokenForm(p => ({ ...p, symbol: e.target.value.toUpperCase() })); setTokenError(''); }}
                placeholder="e.g. USDC"
                maxLength={12}
                style={inputStyle}
                onFocus={e => (e.target.style.borderColor = '#4F46E5')}
                onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
              />
            </div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>
              Decimals
            </label>
            <input
              type="number" min={0} max={18}
              value={tokenForm.decimals}
              onChange={e => { setTokenForm(p => ({ ...p, decimals: e.target.value })); setTokenError(''); }}
              style={{ ...inputStyle, width: 120 }}
              onFocus={e => (e.target.style.borderColor = '#4F46E5')}
              onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
            />
            <span style={{ fontSize: 11, color: '#94A3B8', marginLeft: 8 }}>
              (6 for USDC, 18 for most ERC-20s — this is only used for on-chain amount math, not shown to your team)
            </span>
          </div>
          {tokenError && (
            <p style={{ fontSize: 12, color: '#DC2626', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 5 }}>
              <AlertTriangle size={12} /> {tokenError}
            </p>
          )}
          <Button variant="brand" icon={<Plus size={14} />} loading={tokenLoading} onClick={handleAddToken} size="sm"
            disabled={!tokenForm.address || !tokenForm.name || !tokenForm.symbol}>
            Add Token
          </Button>

          {Object.keys(tokenRegistry).length > 0 && (
            <>
              <hr style={{ border: 'none', borderTop: '1px solid #F1F5F9', margin: '20px 0 16px' }} />
              <p style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 10 }}>
                Supported Tokens
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {Object.values(tokenRegistry).map(token => (
                  <div key={token.address} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 14px', borderRadius: 10,
                    border: '1px solid #E2E8F0', background: '#F8F9FA',
                  }}>
                    {TOKEN_ICON_PATHS[token.symbol] ? (
                      <div style={{ width: 34, height: 34, borderRadius: '50%', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={TOKEN_ICON_PATHS[token.symbol]} alt={token.symbol}
                          width={tokenIconRenderSize(token.symbol, 34)} height={tokenIconRenderSize(token.symbol, 34)}
                          style={{ display: 'block', objectFit: 'cover' }} />
                      </div>
                    ) : (
                      <div style={{ width: 34, height: 34, borderRadius: 8, background: '#EEF2FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <span style={{ fontSize: 10, fontWeight: 800, color: '#4F46E5' }}>{token.symbol.slice(0, 4)}</span>
                      </div>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>
                        {token.name}
                        <span style={{ marginLeft: 6, fontSize: 11, color: '#94A3B8', fontWeight: 400 }}>{token.symbol}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button onClick={() => copyToClipboard(token.address)} title="Copy address"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#4F46E5', fontFamily: "'JetBrains Mono', monospace" }}>
                          {truncAddr(token.address)} <Copy size={10} />
                        </button>
                        <a href={addressLink(token.address)} target="_blank" rel="noreferrer" title="View on explorer" style={{ display: 'flex', alignItems: 'center', color: '#94A3B8' }}>
                          <ExternalLink size={10} />
                        </a>
                      </div>
                    </div>
                    {(!CONTRACTS.USDC || token.address.toLowerCase() !== CONTRACTS.USDC.toLowerCase()) && (
                      <button onClick={() => setRemoveConfirm(token.address)} title="Remove from your list"
                        style={{ width: 28, height: 28, borderRadius: 7, border: 'none', background: '#FEF2F2', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <X size={13} color="#DC2626" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </Section>

        {/* ── Withdraw Funds ───────────────────────────────────────────────── */}
        <Section title="Withdraw Funds" icon={<ShieldAlert size={16} color="#DC2626" />}>
          <p style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 8 }}>
            Withdraw a Supported Token
          </p>
          <p style={{ fontSize: 12, color: '#94A3B8', marginBottom: 10, lineHeight: 1.6 }}>
            Pulls the full balance of one supported token from your payroll contract to your wallet.
          </p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
            <select
              value={withdrawToken}
              onChange={e => setWithdrawToken(e.target.value)}
              style={{ ...inputStyle, flex: 1, minWidth: 180 }}
            >
              <option value="">Select a token…</option>
              {Object.values(tokenRegistry).map(t => (
                <option key={t.address} value={t.address}>{t.name} ({t.symbol})</option>
              ))}
            </select>
            <Button variant="brand" icon={<Download size={14} />} loading={withdrawing} onClick={handleWithdraw} size="sm" disabled={!withdrawToken}>
              Withdraw
            </Button>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid #F1F5F9', margin: '16px 0' }} />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <p style={{ fontSize: 14, fontWeight: 600, color: '#0F172A', margin: '0 0 2px' }}>Emergency Withdrawal</p>
              <p style={{ fontSize: 12, color: '#64748B', margin: 0 }}>
                Recover any ERC-20 token — including ones not in your supported list — even while paused.
              </p>
            </div>
            <Button variant="danger" icon={<Download size={14} />} onClick={() => setEmergencyOpen(true)} size="sm">
              Recover
            </Button>
          </div>
        </Section>
      </div>

      {/* Emergency withdraw modal */}
      <Modal open={emergencyOpen} onClose={() => setEmergencyOpen(false)} title="Emergency Withdrawal" maxWidth={400}>
        <p style={{ fontSize: 14, color: '#64748B', marginBottom: 16, lineHeight: 1.65 }}>
          This will drain all tokens of the specified type from your payroll contract to your wallet.
          This action cannot be undone.
        </p>
        <label style={{ fontSize: 12, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 6 }}>Token Contract Address</label>
        <input
          value={emergencyToken}
          onChange={e => setEmergencyToken(e.target.value)}
          placeholder="0x… (use USDC address for USDC)"
          style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, marginBottom: 16 }}
          maxLength={42}
          onFocus={e => (e.target.style.borderColor = '#4F46E5')}
          onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
        />
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => setEmergencyOpen(false)} style={{
            flex: 1, padding: '10px 0', borderRadius: 10,
            border: '1.5px solid #E2E8F0', background: 'transparent',
            fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: '#475569',
          }}>Cancel</button>
          <Button variant="danger" loading={emergencyBusy} onClick={handleEmergencyWithdraw} style={{ flex: 1 }}>
            Confirm Withdrawal
          </Button>
        </div>
      </Modal>

      {/* Remove token confirmation modal */}
      {removeConfirm && (
        <Modal open={!!removeConfirm} onClose={() => setRemoveConfirm(null)} maxWidth={380}>
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: 52, height: 52, borderRadius: '50%',
              background: '#FEF2F2', border: '1px solid #FCA5A5',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 16px',
            }}>
              <X size={22} color="#DC2626" />
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', marginBottom: 8 }}>
              Remove from your list?
            </h3>
            <p style={{ fontSize: 14, color: '#64748B', marginBottom: 6, lineHeight: 1.6 }}>
              This only removes the token from this app&apos;s display list. Token support on your
              payroll contract is permanent by design and cannot be revoked on-chain — this token
              will still work if referenced directly.
            </p>
            <p style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: '#475569', marginBottom: 24 }}>
              {truncAddr(removeConfirm, 10, 8)}
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setRemoveConfirm(null)} style={{
                flex: 1, padding: '10px 0', borderRadius: 10,
                border: '1.5px solid #E2E8F0', background: 'transparent',
                fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: '#475569',
              }}>Cancel</button>
              <Button variant="danger" onClick={() => handleRemoveToken(removeConfirm)} style={{ flex: 1 }}>
                Remove
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </AppLayout>
  );
}
