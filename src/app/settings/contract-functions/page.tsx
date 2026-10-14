'use client';

/**
 * @file app/settings/contract-functions/page.tsx
 * Payroll contract controls for the employer.
 *
 * Actions are grouped by what they change: Team, Tokens, Funds and Safety.
 * Every group says who can run it. A change only appears in the list after the
 * chain confirms it, so the page never shows a state the contract does not have.
 */

import { useState, useEffect, useCallback } from 'react';
import type { ReactNode, CSSProperties } from 'react';
import Link from 'next/link';
import { usePublicClient } from 'wagmi';
import { formatUnits } from 'viem';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/shared/Button';
import { useApp } from '@/context/AppContext';
import { CONTRACTS, addressLink, arcChain } from '@/lib/contracts/config';
import { MULTI_TOKEN_PAYROLL_ABI, REGISTRY_ABI } from '@/lib/contracts/abis';
import { truncAddr, isValidEthAddress, sanitizeString } from '@/lib/validation';
import { upsertToken, removeToken } from '@/lib/token-registry';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { useUniversalWrite } from '@/lib/circle/useUniversalWrite';
import { useCachedSignMessage } from '@/lib/circle/useCachedSignMessage';
import { usePayrollSync } from '@/lib/usePayrollSync';
import { waitForSuccessfulReceipt } from '@/lib/txReceipt';
import { friendlyErrorMessage } from '@/lib/errorMessage';

const ZERO = '0x0000000000000000000000000000000000000000';

/** Only the reads this page needs. Kept inline so the page does not depend on a larger ABI. */
const TOKEN_READS_ABI = [
  { inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
] as const;

type TokenRow = { address: string; decimals: number; balance: bigint };

function Card({ title, who, children }: { title: string; who: string; children: ReactNode }) {
  return (
    <section style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, overflow: 'hidden' }}>
      <header style={{ padding: '16px 24px', borderBottom: '1px solid #F1F5F9' }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', margin: 0 }}>{title}</h3>
        <p style={{ fontSize: 12, color: '#64748B', margin: '4px 0 0' }}>{who}</p>
      </header>
      <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
    </section>
  );
}

const inputStyle: CSSProperties = {
  padding: '9px 14px', border: '1.5px solid #E2E8F0', borderRadius: 10,
  fontSize: 14, fontFamily: 'inherit', color: '#0F172A', background: '#fff', outline: 'none', width: '100%',
};

export default function ContractFunctionsPage() {
  const { address } = useEffectiveAddress();
  const publicClient = usePublicClient({ chainId: arcChain.id });
  const { state, dispatch, addToast, syncData } = useApp();
  const { payrollClone, registryClone, tokenRegistry, isPremiumUser, proExpiresAt } = state;
  usePayrollSync({ registryClone, address, publicClient });

  const { writeContract: universalWrite, canWrite } = useUniversalWrite();
  const sign = useCachedSignMessage();

  const [owner, setOwner]   = useState<string | null>(null);
  const [callerIsAgent, setCallerIsAgent] = useState(false);
  const [paused, setPaused] = useState<boolean | null>(null);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const isOwner = !!address && !!owner && owner.toLowerCase() === address.toLowerCase();

  // Read everything from the chain in one place, so every card shows the same truth.
  const refresh = useCallback(async () => {
    if (!publicClient || !payrollClone) return;
    try {
      setLoadError('');
      const clone = payrollClone as `0x${string}`;
      const [ownerAddr, isPaused, list, agentFlag] = await Promise.all([
        publicClient.readContract({ address: clone, abi: MULTI_TOKEN_PAYROLL_ABI, functionName: 'owner' }) as Promise<string>,
        publicClient.readContract({ address: clone, abi: MULTI_TOKEN_PAYROLL_ABI, functionName: 'paused' }) as Promise<boolean>,
        publicClient.readContract({ address: clone, abi: MULTI_TOKEN_PAYROLL_ABI, functionName: 'getSupportedTokensPaginated', args: [0n, 100n] }) as Promise<string[]>,
        address
          ? publicClient.readContract({ address: clone, abi: MULTI_TOKEN_PAYROLL_ABI, functionName: 'isAgent', args: [address as `0x${string}`] }) as Promise<boolean>
          : Promise.resolve(false),
      ]);
      const rows = await Promise.all(list.map(async (token) => {
        const t = token as `0x${string}`;
        const [decimals, balance] = await Promise.all([
          publicClient.readContract({ address: t, abi: TOKEN_READS_ABI, functionName: 'decimals' }) as Promise<number>,
          publicClient.readContract({ address: t, abi: TOKEN_READS_ABI, functionName: 'balanceOf', args: [clone] }) as Promise<bigint>,
        ]);
        return { address: token, decimals: Number(decimals), balance };
      }));
      setOwner(ownerAddr);
      setCallerIsAgent(agentFlag);
      setPaused(isPaused);
      setTokens(rows);
    } catch (err) {
      setLoadError(friendlyErrorMessage(err, 'Could not read the contract. Check your connection and try again.'));
    }
  }, [publicClient, payrollClone]);

  useEffect(() => { void refresh(); }, [refresh]);

  /** Publishes the local token list to the registry, so it matches what the contract now holds. */
  async function anchorRegistry() {
    const { cid } = await syncData({ walletAddress: address ?? '', signMessage: sign });
    if (!cid || !registryClone || !canWrite || !publicClient) return;
    try {
      const hash = await universalWrite({
        address: registryClone as `0x${string}`, abi: REGISTRY_ABI, functionName: 'updateCID', args: [cid],
      });
      await waitForSuccessfulReceipt(publicClient, hash);
    } catch (err) {
      console.error('[ContractFunctions] Failed to anchor token list:', err);
    }
  }

  /** Runs a contract write, waits for confirmation, then refreshes. Shows one message either way. */
  async function run(label: string, fn: string, args: unknown[] | undefined, onDone?: () => Promise<void> | void) {
    if (!canWrite || !payrollClone || !publicClient) {
      addToast('Connect your wallet to make this change.', 'error');
      return;
    }
    setBusy(label);
    try {
      const hash = await universalWrite({
        address: payrollClone as `0x${string}`,
        abi: MULTI_TOKEN_PAYROLL_ABI,
        functionName: fn,
        args: args as never,
      });
      await waitForSuccessfulReceipt(publicClient, hash);
      addToast(`${label} confirmed.`, 'success');
      await onDone?.();
      await refresh();
    } catch (err) {
      addToast(friendlyErrorMessage(err, `${label} failed. Please try again.`), 'error');
    } finally {
      setBusy(null);
    }
  }

  // ---- Team -------------------------------------------------------------
  const [agentInput, setAgentInput] = useState('');
  const [removeAgentInput, setRemoveAgentInput] = useState('');

  // ---- Tokens -----------------------------------------------------------
  const [newToken, setNewToken] = useState({ address: '', name: '', symbol: '', decimals: '6' });
  const [tokenError, setTokenError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const canAddToken = isOwner || callerIsAgent;

  async function addToken() {
    setTokenError('');
    const addr = newToken.address.trim();
    if (!isValidEthAddress(addr)) { setTokenError('Enter a valid token address.'); return; }
    if (tokens.some(t => t.address.toLowerCase() === addr.toLowerCase())) { setTokenError('This token is already added.'); return; }
    // Chain first. The local list is only updated after the contract accepts the token.
    await run('Token added', 'addSupportedToken', [addr], async () => {
      const { registry, error } = upsertToken(tokenRegistry, {
        address: addr,
        name: sanitizeString(newToken.name) || addr,
        symbol: newToken.symbol.trim().toUpperCase() || 'TOKEN',
        decimals: Number(newToken.decimals) || 6,
        addedBy: address ?? undefined,
      });
      if (!error) dispatch({ type: 'SET_TOKEN_REGISTRY', payload: registry });
      setNewToken({ address: '', name: '', symbol: '', decimals: '6' });
      await anchorRegistry();
    });
  }

  async function removeTokenOnChain(token: string) {
    await run('Token removed', 'removeSupportedToken', [token], async () => {
      const { registry } = removeToken(tokenRegistry, token);
      dispatch({ type: 'SET_TOKEN_REGISTRY', payload: registry });
      setConfirmRemove(null);
      await anchorRegistry();
    });
  }

  // ---- Funds ------------------------------------------------------------
  const [withdrawToken, setWithdrawToken] = useState('');
  const [recoverToken, setRecoverToken] = useState('');

  // ---- Render -----------------------------------------------------------
  if (!isPremiumUser || !payrollClone) {
    return (
      <AppLayout title="Contract Functions">
        <div style={{ maxWidth: 560, margin: '40px auto', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: '#0F172A' }}>No payroll contract yet</h2>
          <p style={{ fontSize: 14, color: '#64748B' }}>Create your payroll contract with Salden Pro to manage it here.</p>
          <Link href="/pricing" style={{ fontSize: 14, fontWeight: 700, color: '#4F46E5' }}>See Salden Pro</Link>
        </div>
      </AppLayout>
    );
  }

  const subscriptionActive = proExpiresAt !== null && proExpiresAt * 1000 > Date.now();
  const expiryLabel = proExpiresAt
    ? new Date(proExpiresAt * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    : '';

  return (
    <AppLayout title="Contract Functions">
      <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Overview */}
        <section style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, padding: '18px 24px', display: 'flex', flexWrap: 'wrap', gap: 20, justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 12, color: '#64748B' }}>Contract</div>
            <a href={addressLink(payrollClone)} target="_blank" rel="noreferrer" style={{ fontSize: 14, fontWeight: 700, color: '#4F46E5', textDecoration: 'none', fontFamily: 'monospace' }}>
              {truncAddr(payrollClone)}
            </a>
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#64748B' }}>Status</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: paused ? '#DC2626' : '#059669' }}>
              {paused === null ? 'Checking...' : paused ? 'Paused' : 'Active'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#64748B' }}>Subscription</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: subscriptionActive ? '#0F172A' : '#DC2626' }}>
              {subscriptionActive ? `Active until ${expiryLabel}` : 'Ended'}
            </div>
          </div>
        </section>

        {!subscriptionActive && (
          <p style={{ fontSize: 13, color: '#475569', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 12, padding: '12px 16px', margin: 0 }}>
            Your subscription has ended. You can still withdraw, manage tokens and recover funds. Renew to send payroll again.
          </p>
        )}

        {loadError && (
          <p style={{ fontSize: 13, color: '#DC2626', margin: 0 }}>{loadError}</p>
        )}

        {!isOwner && owner && (
          <p style={{ fontSize: 13, color: '#475569', margin: 0 }}>
            You are not the owner of this contract. Owner actions are disabled.
          </p>
        )}

        {/* Team */}
        <Card title="Team" who="Owner adds or removes agents. Agents can run payroll and withdrawals.">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input style={{ ...inputStyle, flex: 1, minWidth: 220 }} placeholder="Agent wallet address (0x...)"
              value={agentInput} onChange={e => setAgentInput(e.target.value)} />
            <Button variant="primary" disabled={!isOwner || !isValidEthAddress(agentInput) || busy !== null}
              onClick={() => run('Agent added', 'addAgent', [agentInput.trim()], () => setAgentInput(''))}>
              Add agent
            </Button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input style={{ ...inputStyle, flex: 1, minWidth: 220 }} placeholder="Agent to remove (0x...)"
              value={removeAgentInput} onChange={e => setRemoveAgentInput(e.target.value)} />
            <Button variant="danger" disabled={!isOwner || !isValidEthAddress(removeAgentInput) || busy !== null}
              onClick={() => run('Agent removed', 'removeAgent', [removeAgentInput.trim()], () => setRemoveAgentInput(''))}>
              Remove agent
            </Button>
          </div>
        </Card>

        {/* Tokens */}
        <Card title="Tokens" who="Owner or agent can add a token. Only the owner can remove one, and only once its balance is zero. USDC can never be removed.">
          {tokens.length === 0 && <p style={{ fontSize: 13, color: '#64748B', margin: 0 }}>Loading tokens...</p>}
          {tokens.map(t => {
            const reg = tokenRegistry.find(r => r.address.toLowerCase() === t.address.toLowerCase());
            const isUsdc = t.address.toLowerCase() === CONTRACTS.USDC.toLowerCase();
            return (
              <div key={t.address} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 14px', borderRadius: 10, border: '1px solid #E2E8F0', background: '#F8F9FA' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{reg?.symbol ?? truncAddr(t.address)}</div>
                  <div style={{ fontSize: 12, color: '#64748B' }}>Balance: {formatUnits(t.balance, t.decimals)}</div>
                </div>
                {!isUsdc && confirmRemove !== t.address && (
                  <Button variant="secondary" disabled={!isOwner || t.balance !== 0n || busy !== null}
                    onClick={() => setConfirmRemove(t.address)}>
                    {t.balance === 0n ? 'Remove' : 'Withdraw first'}
                  </Button>
                )}
                {confirmRemove === t.address && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button variant="danger" disabled={busy !== null} onClick={() => removeTokenOnChain(t.address)}>Confirm remove</Button>
                    <Button variant="secondary" onClick={() => setConfirmRemove(null)}>Cancel</Button>
                  </div>
                )}
              </div>
            );
          })}

          <div style={{ borderTop: '1px solid #F1F5F9', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>Add a token</div>
            <input style={inputStyle} placeholder="Token contract address (0x...)" value={newToken.address}
              onChange={e => setNewToken({ ...newToken, address: e.target.value })} />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input style={{ ...inputStyle, flex: 1, minWidth: 120 }} placeholder="Symbol (e.g. EURC)" value={newToken.symbol}
                onChange={e => setNewToken({ ...newToken, symbol: e.target.value })} />
              <input style={{ ...inputStyle, flex: 1, minWidth: 120 }} placeholder="Name" value={newToken.name}
                onChange={e => setNewToken({ ...newToken, name: e.target.value })} />
            </div>
            {tokenError && <p style={{ fontSize: 13, color: '#DC2626', margin: 0 }}>{tokenError}</p>}
            <Button variant="primary" disabled={!canAddToken || busy !== null} onClick={addToken}>Add token</Button>
          </div>
        </Card>

        {/* Funds */}
        <Card title="Funds" who="Withdraw: owner or agent, sends to the owner. Recover: owner only, works for any token.">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select style={{ ...inputStyle, flex: 1, minWidth: 200 }} value={withdrawToken} onChange={e => setWithdrawToken(e.target.value)}>
              <option value="">Choose a token</option>
              {tokens.map(t => <option key={t.address} value={t.address}>{tokenRegistry.find(r => r.address.toLowerCase() === t.address.toLowerCase())?.symbol ?? truncAddr(t.address)}</option>)}
            </select>
            <Button variant="primary" disabled={!withdrawToken || busy !== null}
              onClick={() => run('Withdrawal', 'withdraw', [withdrawToken], () => setWithdrawToken(''))}>
              Withdraw to owner
            </Button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input style={{ ...inputStyle, flex: 1, minWidth: 200 }} placeholder="Any token address (0x...)"
              value={recoverToken} onChange={e => setRecoverToken(e.target.value)} />
            <Button variant="danger" disabled={!isOwner || !isValidEthAddress(recoverToken) || busy !== null}
              onClick={() => run('Recovery', 'emergencyWithdraw', [recoverToken.trim()], () => setRecoverToken(''))}>
              Recover funds
            </Button>
          </div>
        </Card>

        {/* Safety */}
        <Card title="Safety" who="Owner only. Pausing stops payroll and withdrawals. Recovery still works while paused.">
          <div>
            <Button variant={paused ? 'primary' : 'danger'} disabled={!isOwner || paused === null || busy !== null}
              onClick={() => run(paused ? 'Resume' : 'Pause', paused ? 'unpause' : 'pause', [])}>
              {paused ? 'Resume payroll' : 'Pause payroll'}
            </Button>
          </div>
        </Card>

        <p style={{ fontSize: 12, color: '#94A3B8', margin: '4px 0 24px' }}>
          Contract {truncAddr(payrollClone)} on Arc Network.
        </p>
      </div>
    </AppLayout>
  );
}
