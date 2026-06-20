'use client';
/**
 * @file app/settings/page.tsx
 * Settings — company profile, contract functions, premium tools, danger zone.
 * Cooldown removed per spec. Restructured to match new design.
 */

import { useState, useRef } from 'react';
import { useAccount, useWalletClient, usePublicClient } from 'wagmi';
import { type PayrollSetup } from '@/context/AppContext';
import {
  Zap, Trash2, Download, ExternalLink,
  AlertTriangle, Loader2, Plus, X,
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/shared/Button';
import { useApp } from '@/context/AppContext';
import { Modal } from '@/components/shared/Modal';
import { CONTRACTS, addressLink } from '@/lib/contracts/config';
import { MULTI_TOKEN_PAYROLL_ABI, REGISTRY_ABI } from '@/lib/contracts/abis';
import { truncAddr, isValidEthAddress, sanitizeString } from '@/lib/validation';
import { upsertToken, removeToken, tokenLabel, type TokenEntry } from '@/lib/token-registry';
import { SettingsIllustration } from '@/components/shared/Illustrations';

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, overflow: 'hidden' }}>
      <div style={{ padding: '16px 24px', borderBottom: '1px solid #F1F5F9' }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', margin: 0 }}>{title}</h3>
      </div>
      <div style={{ padding: '20px 24px' }}>
        {children}
      </div>
    </div>
  );
}

// ── Field row ─────────────────────────────────────────────────────────────────

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', alignItems: 'center', gap: 16, marginBottom: 18 }}>
      <label style={{ fontSize: 13, fontWeight: 600, color: '#475569' }}>{label}</label>
      {children}
    </div>
  );
}

// ── Main settings page ────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { address }      = useAccount();
  const { data: wallet } = useWalletClient();
  const publicClient     = usePublicClient();
  const { state, dispatch, addToast, syncData } = useApp();
  const { payrollSetup, isPremiumUser, payrollClone, registryClone, groups } = state;

  // Latest CID we've successfully anchored Onchain — lets anchorCid skip a
  // redundant transaction if the data hasn't actually changed since.
  // (IPFS "previousCid" bookkeeping for Pinata cleanup is handled centrally
  // by AppContext's syncData/loadData — no need to duplicate it here.)
  const lastAnchoredCidRef = useRef<string | null>(null);

  /** Anchors a freshly-synced IPFS CID Onchain. Mirrors the dashboard's
   *  anchorCid — without this, group/profile/token-registry edits made here
   *  would sync to IPFS but never update the Onchain pointer, so they'd be
   *  invisible after a reload or from another device. */
  const anchorCid = async (cid?: string) => {
    if (!cid || cid === lastAnchoredCidRef.current) return;
    if (!registryClone || !wallet || !publicClient) return;
    try {
      const hash = await wallet.writeContract({
        address:      registryClone as `0x${string}`,
        abi:          REGISTRY_ABI,
        functionName: 'updateCID',
        args:         [cid],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      lastAnchoredCidRef.current = cid;
    } catch (err) {
      console.error('[Settings] Failed to anchor CID Onchain:', err);
      addToast('Saved, but the Onchain record could not be updated. Please try again.', 'warning');
    }
  };

  const signMsg = wallet ? (msg: string) => wallet.signMessage({ message: msg }) : undefined;

  /** Sync current state to IPFS, then anchor the resulting CID Onchain. */
  async function syncAndAnchor() {
    const { cid } = await syncData({ walletAddress: address ?? '', signMessage: signMsg });
    await anchorCid(cid);
  }

  // Profile form
  const [companyName, setCompanyName] = useState(payrollSetup?.companyName ?? '');
  const [email,       setEmail]       = useState(payrollSetup?.email       ?? '');
  const [savingProfile, setSavingProfile] = useState(false);

  // Group management
  const [newGroup,     setNewGroup]     = useState('');
  const [groupError,   setGroupError]   = useState('');
  const [groupSaving,  setGroupSaving]  = useState(false);

  // Agent management
  const [agentAddr,      setAgentAddr]      = useState('');
  const [agentLoading,   setAgentLoading]   = useState(false);

  // Token management — full form: address + name + symbol + decimals
  const [tokenForm, setTokenForm] = useState({
    address:  '',
    name:     '',
    symbol:   '',
    decimals: '6',
  });
  const [tokenLoading,  setTokenLoading]  = useState(false);
  const [tokenError,    setTokenError]    = useState('');
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null); // address to remove

  // Emergency withdraw modal
  const [withdrawOpen,  setWithdrawOpen]  = useState(false);
  const [withdrawToken, setWithdrawToken] = useState('');
  const [withdrawing,   setWithdrawing]   = useState(false);

  // Delete all data modal
  const [deleteOpen,    setDeleteOpen]    = useState(false);

  // ── Save profile ────────────────────────────────────────────────────────────

  async function handleSaveProfile() {
    setSavingProfile(true);
    try {
      const updated: PayrollSetup = {
        companyName:   sanitizeString(companyName),
        email:         email.trim(),
        registryClone: payrollSetup?.registryClone,
        payrollClone:  payrollSetup?.payrollClone,
      };
      dispatch({ type: 'SET_PAYROLL_DATA', payload: { payrollSetup: updated } });
      dispatch({ type: 'SET_COMPANY_NAME', payload: updated.companyName });
      await syncAndAnchor();
      addToast('Profile saved.', 'success');
    } catch { addToast('Failed to save profile.', 'error'); }
    finally { setSavingProfile(false); }
  }

  // ── Group management ────────────────────────────────────────────────────────

  async function handleAddGroup() {
    const g = sanitizeString(newGroup);
    if (!g) { setGroupError('Group name cannot be empty.'); return; }
    if (groups.includes(g)) { setGroupError('Group already exists.'); return; }
    const next = [...groups, g];
    dispatch({ type: 'SET_GROUPS', payload: next });
    setNewGroup('');
    setGroupError('');
    setGroupSaving(true);
    try {
      const { cid } = await syncData({ walletAddress: address ?? '', signMessage: signMsg });
      await anchorCid(cid);
      addToast(`Group "${g}" created.`, 'success');
    } catch { addToast('Saved locally — sync failed.', 'warning'); }
    finally { setGroupSaving(false); }
  }

  async function handleRemoveGroup(g: string) {
    const next = groups.filter(x => x !== g);
    dispatch({ type: 'SET_GROUPS', payload: next });
    setGroupSaving(true);
    try {
      const { cid } = await syncData({ walletAddress: address ?? '', signMessage: signMsg });
      await anchorCid(cid);
      addToast(`Group "${g}" removed.`, 'success');
    } catch { addToast('Saved locally — sync failed.', 'warning'); }
    finally { setGroupSaving(false); }
  }

  // ── Add agent (premium only) ────────────────────────────────────────────────

  async function handleAddAgent() {
    if (!wallet || !payrollClone || !isValidEthAddress(agentAddr)) {
      addToast('Enter a valid Ethereum address.', 'error'); return;
    }
    setAgentLoading(true);
    try {
      const hash = await wallet.writeContract({
        address:      payrollClone as `0x${string}`,
        abi:          MULTI_TOKEN_PAYROLL_ABI,
        functionName: 'addAgent',
        args:         [agentAddr as `0x${string}`],
      });
      addToast(`Agent added. Tx: ${hash.slice(0, 12)}…`, 'success');
      setAgentAddr('');
    } catch (err) { addToast((err as Error).message, 'error'); }
    finally { setAgentLoading(false); }
  }

  // ── Add token to registry + Onchain ─────────────────────────────────────

  async function handleAddToken() {
    setTokenError('');
    const { address: tAddr, name, symbol, decimals } = tokenForm;

    // Client-side validation via registry helper
    const { registry: updated, error } = upsertToken(state.tokenRegistry, {
      address:   tAddr.trim(),
      name:      sanitizeString(name),
      symbol:    symbol.trim().toUpperCase(),
      decimals:  Number(decimals),
      addedBy:   address ?? undefined,
    });
    if (error) { setTokenError(error); return; }

    setTokenLoading(true);
    try {
      // 1. Register on smart contract (premium only)
      if (wallet && payrollClone) {
        const hash = await wallet.writeContract({
          address:      payrollClone as `0x${string}`,
          abi:          MULTI_TOKEN_PAYROLL_ABI,
          functionName: 'addSupportedToken',
          args:         [tAddr.trim() as `0x${string}`],
        });
        addToast(`Token added Onchain. Tx: ${hash.slice(0, 12)}…`, 'success');
      }
      // 2. Save name+symbol to registry (all plans — used for display)
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

  // ── Remove token from registry ────────────────────────────────────────────

  async function handleRemoveToken(addr: string) {
    const { registry: updated, error } = removeToken(state.tokenRegistry, addr);
    if (error) { addToast(error, 'error'); return; }

    dispatch({ type: 'SET_TOKEN_REGISTRY', payload: updated });
    await syncAndAnchor().catch(() => {});
    setRemoveConfirm(null);
    addToast('Token removed from registry.', 'success');
  }

  // ── Emergency withdraw ─────────────────────────────────────────────────────

  async function handleWithdraw() {
    if (!wallet || !payrollClone || !isValidEthAddress(withdrawToken)) {
      addToast('Enter a valid token address.', 'error'); return;
    }
    setWithdrawing(true);
    try {
      const hash = await wallet.writeContract({
        address:      payrollClone as `0x${string}`,
        abi:          MULTI_TOKEN_PAYROLL_ABI,
        functionName: 'emergencyWithdraw',
        args:         [withdrawToken as `0x${string}`],
      });
      addToast(`Emergency withdrawal submitted. Tx: ${hash.slice(0, 12)}…`, 'success');
      setWithdrawOpen(false);
      setWithdrawToken('');
    } catch (err) { addToast((err as Error).message, 'error'); }
    finally { setWithdrawing(false); }
  }

  // ── Delete all local data ─────────────────────────────────────────────────

  function handleDeleteAllData() {
    dispatch({ type: 'RESET' });
    setDeleteOpen(false);
    addToast('All local data cleared.', 'success');
  }

  const inputStyle: React.CSSProperties = {
    padding: '9px 14px', border: '1.5px solid #E2E8F0',
    borderRadius: 10, fontSize: 14, fontFamily: 'inherit',
    color: '#0F172A', background: '#fff', outline: 'none', width: '100%',
  };

  return (
    <AppLayout title="Settings">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 780 }}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: '#0F172A', marginBottom: 4 }}>Settings</h1>
            <p style={{ fontSize: 14, color: '#64748B' }}>Manage your profile, groups, and contract configuration.</p>
          </div>
          <SettingsIllustration width={100} height={75} />
        </div>

        {/* ── Company Profile ─────────────────────────────────────────────── */}
        <Section title="Company Profile">
          <FieldRow label="Company Name">
            <input
              value={companyName}
              onChange={e => setCompanyName(e.target.value)}
              placeholder="Acme Corp"
              maxLength={100}
              style={inputStyle}
              onFocus={e => (e.target.style.borderColor = '#4F46E5')}
              onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
            />
          </FieldRow>
          <FieldRow label="Invoice Email">
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="payroll@yourcompany.com"
              style={inputStyle}
              onFocus={e => (e.target.style.borderColor = '#4F46E5')}
              onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
            />
          </FieldRow>
          <FieldRow label="Wallet Address">
            <div style={{
              padding: '9px 14px', background: '#F8F9FA',
              border: '1px solid #E2E8F0', borderRadius: 10,
              fontSize: 13, fontFamily: "'JetBrains Mono', monospace",
              color: '#475569',
            }}>
              {address ? (
                <a href={addressLink(address)} target="_blank" rel="noreferrer"
                  style={{ color: '#4F46E5', display: 'flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
                  {truncAddr(address, 12, 8)}
                  <ExternalLink size={12} />
                </a>
              ) : 'Not connected'}
            </div>
          </FieldRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="brand" loading={savingProfile} onClick={handleSaveProfile} size="sm">
              Save Profile
            </Button>
          </div>
        </Section>

        {/* ── Contract Info ───────────────────────────────────────────────── */}
        <Section title="Contract Information">
          {(() => {
            const rows = [
              ...(payrollClone  ? [{ label: 'Your Payroll Contract',  addr: payrollClone }]  : []),
              ...(registryClone ? [{ label: 'Your Registry Contract', addr: registryClone }] : []),
            ];
            if (rows.length === 0) {
              return (
                <p style={{ fontSize: 13, color: '#94A3B8', padding: '8px 0' }}>
                  You do not have any available smart contract.
                </p>
              );
            }
            return rows.map(({ label, addr }) => (
              <FieldRow key={label} label={label}>
                <a href={addressLink(addr)} target="_blank" rel="noreferrer"
                  style={{
                    padding: '8px 14px', background: '#F8F9FA',
                    border: '1px solid #E2E8F0', borderRadius: 10,
                    fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
                    color: '#4F46E5', textDecoration: 'none',
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                  {truncAddr(addr, 14, 8)}
                  <ExternalLink size={12} />
                </a>
              </FieldRow>
            ));
          })()}
        </Section>

        {/* ── Group Management ────────────────────────────────────────────── */}
        <Section title="Employee Groups">
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input
              value={newGroup}
              onChange={e => { setNewGroup(e.target.value); setGroupError(''); }}
              placeholder="e.g. Remote Workers, Contractors…"
              maxLength={50}
              style={{ ...inputStyle, flex: 1 }}
              onFocus={e => (e.target.style.borderColor = '#4F46E5')}
              onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
              onKeyDown={e => e.key === 'Enter' && handleAddGroup()}
            />
            <Button variant="brand" icon={groupSaving ? <Loader2 size={14} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Plus size={14} />} onClick={handleAddGroup} size="sm" disabled={groupSaving}>
              Add Group
            </Button>
          </div>
          {groupError && <p style={{ fontSize: 12, color: '#DC2626', marginBottom: 12 }}>{groupError}</p>}


          {groups.length === 0 ? (
            <p style={{ fontSize: 13, color: '#94A3B8', textAlign: 'center', padding: '16px 0' }}>
              No groups yet. Add a group to organise employees.
            </p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {groups.map(g => (
                <div key={g} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '5px 12px', borderRadius: 99,
                  background: '#EEF2FF', border: '1px solid #C7D2FE',
                }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#4F46E5' }}>{g}</span>
                  <button onClick={() => handleRemoveGroup(g)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', color: '#818CF8' }}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* ── Premium Contract Functions ──────────────────────────────────── */}
        <Section title="Premium Contract Functions">
          {!isPremiumUser ? (
            <div style={{
              background: '#F8F9FA', borderRadius: 12, padding: '20px',
              textAlign: 'center',
            }}>
              <Zap size={24} color="#E2E8F0" style={{ margin: '0 auto 10px' }} />
              <p style={{ fontSize: 14, color: '#94A3B8', marginBottom: 14 }}>
                These functions require the Premium plan and a private payroll contract.
              </p>
              <a href="/pricing" style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '9px 18px', borderRadius: 10,
                background: '#4F46E5', color: '#fff',
                fontSize: 13, fontWeight: 600, textDecoration: 'none',
              }}>
                <Zap size={14} /> Upgrade to Premium
              </a>
            </div>
          ) : (
            <>
              {/* Add agent */}
              <div style={{ marginBottom: 20 }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 8 }}>
                  Authorise AI Agent Wallet
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={agentAddr}
                    onChange={e => setAgentAddr(e.target.value)}
                    placeholder="Agent wallet address (0x…)"
                    style={{ ...inputStyle, flex: 1, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
                    maxLength={42}
                    onFocus={e => (e.target.style.borderColor = '#4F46E5')}
                    onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
                  />
                  <Button variant="brand" loading={agentLoading} onClick={handleAddAgent} size="sm">
                    Add Agent
                  </Button>
                </div>
              </div>

              <hr style={{ border: 'none', borderTop: '1px solid #F1F5F9', margin: '16px 0' }} />

              {/* Add token form */}
              <div style={{ marginBottom: 20 }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 12 }}>
                  Add Payment Token
                </p>

                {/* Token contract address */}
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

                {/* Name + Symbol row */}
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

                {/* Decimals */}
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>
                    Decimals
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={18}
                    value={tokenForm.decimals}
                    onChange={e => { setTokenForm(p => ({ ...p, decimals: e.target.value })); setTokenError(''); }}
                    style={{ ...inputStyle, width: 120 }}
                    onFocus={e => (e.target.style.borderColor = '#4F46E5')}
                    onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
                  />
                  <span style={{ fontSize: 11, color: '#94A3B8', marginLeft: 8 }}>
                    (6 for USDC, 18 for most ERC-20s)
                  </span>
                </div>

                {tokenError && (
                  <p style={{ fontSize: 12, color: '#DC2626', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <AlertTriangle size={12} /> {tokenError}
                  </p>
                )}

                <Button
                  variant="brand"
                  icon={<Plus size={14} />}
                  loading={tokenLoading}
                  onClick={handleAddToken}
                  size="sm"
                  disabled={!tokenForm.address || !tokenForm.name || !tokenForm.symbol}
                >
                  Add Token
                </Button>
              </div>

              {/* Token registry table */}
              {Object.keys(state.tokenRegistry).length > 0 && (
                <>
                  <hr style={{ border: 'none', borderTop: '1px solid #F1F5F9', margin: '16px 0' }} />
                  <p style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 10 }}>
                    Token Registry
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {Object.values(state.tokenRegistry).map(token => (
                      <div key={token.address} style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '10px 14px', borderRadius: 10,
                        border: '1px solid #E2E8F0', background: '#F8F9FA',
                      }}>
                        {/* Token badge */}
                        <div style={{
                          width: 34, height: 34, borderRadius: 8,
                          background: '#EEF2FF', display: 'flex', alignItems: 'center',
                          justifyContent: 'center', flexShrink: 0,
                        }}>
                          <span style={{ fontSize: 10, fontWeight: 800, color: '#4F46E5' }}>
                            {token.symbol.slice(0, 4)}
                          </span>
                        </div>

                        {/* Name + address */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>
                            {token.name}
                            <span style={{ marginLeft: 6, fontSize: 11, color: '#94A3B8', fontWeight: 400 }}>
                              {token.symbol}
                            </span>
                            <span style={{ marginLeft: 6, fontSize: 11, color: '#94A3B8' }}>
                              · {token.decimals} decimals
                            </span>
                          </div>
                          {/* Address — always shown in settings per spec */}
                          <a
                            href={addressLink(token.address)}
                            target="_blank" rel="noreferrer"
                            style={{
                              fontSize: 11, color: '#4F46E5',
                              fontFamily: "'JetBrains Mono', monospace",
                              textDecoration: 'none',
                              display: 'flex', alignItems: 'center', gap: 4,
                            }}
                          >
                            {token.address}
                            <ExternalLink size={10} />
                          </a>
                        </div>

                        {/* Remove button — USDC cannot be removed */}
                        {(!CONTRACTS.USDC || token.address.toLowerCase() !== CONTRACTS.USDC.toLowerCase()) && (
                          <button
                            onClick={() => setRemoveConfirm(token.address)}
                            title="Remove token"
                            style={{
                              width: 28, height: 28, borderRadius: 7, border: 'none',
                              background: '#FEF2F2', cursor: 'pointer',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              flexShrink: 0,
                            }}
                          >
                            <X size={13} color="#DC2626" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </Section>

        {/* ── Danger Zone ─────────────────────────────────────────────────── */}
        <div style={{
          background: '#FFFAFA', border: '1px solid #FCA5A5',
          borderRadius: 16, overflow: 'hidden',
        }}>
          <div style={{ padding: '16px 24px', borderBottom: '1px solid #FEE2E2' }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: '#DC2626', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={16} /> Danger Zone
            </h3>
          </div>
          <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {isPremiumUser && payrollClone && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <p style={{ fontSize: 14, fontWeight: 600, color: '#0F172A', margin: '0 0 2px' }}>Emergency Withdrawal</p>
                  <p style={{ fontSize: 12, color: '#64748B', margin: 0 }}>Drain all tokens from your payroll contract to your wallet.</p>
                </div>
                <Button variant="danger" icon={<Download size={14} />} onClick={() => setWithdrawOpen(true)} size="sm">
                  Withdraw
                </Button>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <p style={{ fontSize: 14, fontWeight: 600, color: '#0F172A', margin: '0 0 2px' }}>Clear All Local Data</p>
                <p style={{ fontSize: 12, color: '#64748B', margin: 0 }}>Removes all employees, groups, and settings from this device. On-chain data is unaffected.</p>
              </div>
              <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => setDeleteOpen(true)} size="sm">
                Clear Data
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Emergency withdraw modal */}
      <Modal open={withdrawOpen} onClose={() => setWithdrawOpen(false)} title="Emergency Withdrawal" maxWidth={400}>
        <p style={{ fontSize: 14, color: '#64748B', marginBottom: 16, lineHeight: 1.65 }}>
          This will drain all tokens of the specified type from your payroll contract to your wallet.
          This action cannot be undone.
        </p>
        <label className="label">Token Contract Address</label>
        <input
          value={withdrawToken}
          onChange={e => setWithdrawToken(e.target.value)}
          placeholder="0x… (use USDC address for USDC)"
          style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace", fontSize: 12, marginBottom: 16 }}
          maxLength={42}
          onFocus={e => (e.target.style.borderColor = '#4F46E5')}
          onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
        />
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => setWithdrawOpen(false)} style={{
            flex: 1, padding: '10px 0', borderRadius: 10,
            border: '1.5px solid #E2E8F0', background: 'transparent',
            fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: '#475569',
          }}>Cancel</button>
          <Button variant="danger" loading={withdrawing} onClick={handleWithdraw} style={{ flex: 1 }}>
            Confirm Withdrawal
          </Button>
        </div>
      </Modal>

      {/* Delete data confirm modal */}
      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} maxWidth={380}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: 52, height: 52, borderRadius: '50%',
            background: '#FEF2F2', border: '1px solid #FCA5A5',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
          }}>
            <Trash2 size={22} color="#DC2626" />
          </div>
          <h3 style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', marginBottom: 8 }}>Clear all data?</h3>
          <p style={{ fontSize: 14, color: '#64748B', marginBottom: 24, lineHeight: 1.6 }}>
            All local employees, groups, and settings will be erased. Your Onchain contracts and IPFS data remain intact.
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => setDeleteOpen(false)} style={{
              flex: 1, padding: '10px 0', borderRadius: 10,
              border: '1.5px solid #E2E8F0', background: 'transparent',
              fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: '#475569',
            }}>Cancel</button>
            <Button variant="danger" onClick={handleDeleteAllData} style={{ flex: 1 }}>
              Yes, Clear All
            </Button>
          </div>
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
              Remove token?
            </h3>
            <p style={{ fontSize: 14, color: '#64748B', marginBottom: 6, lineHeight: 1.6 }}>
              This removes the token name from your registry. The token address will remain
              on your payroll contract until you call <code>removeToken</code> Onchain.
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
