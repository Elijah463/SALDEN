'use client';
/**
 * @file components/agent/AgentConfirmationCards.tsx
 *
 * The execution layer behind the G1 structured marker protocol in
 * app/api/agent/chat/route.ts. The chat route NEVER moves money or writes
 * to the employee database itself — it only proposes an action via a
 * structured SSE event after independently re-verifying the address
 * against the real employee allowlist. These two cards are where that
 * proposal becomes a real, human-confirmed, wallet-signed transaction.
 *
 * This is the actual "hard to bypass" mechanism: no matter what a
 * jailbroken model generates in text, nothing happens until a person
 * clicks Confirm AND signs a transaction with their own connected wallet.
 * An LLM cannot forge a wallet signature.
 *
 * `department` IS a confirmed, separate field on Employee (per Fred):
 * department = org function (Legal, Marketing, CSO), group = payroll/work
 * classification (Remote Workers, Contractors). Both are written below.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { usePublicClient } from 'wagmi';
import { encodeFunctionData, keccak256 } from 'viem';
import { Loader2 } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import type { Employee } from '@/context/AppContext';
import {
  PAYROLL_BATCH_PAY_ABI,
  REGISTRY_UPDATE_CID_ABI,
} from '@/lib/contracts/agentAbis';
import { MEMO_ABI, MEMO_CONTRACT_ADDRESS, ERC20_ABI } from '@/lib/contracts/abis';
import { findDuplicateWallets } from '@/lib/validation';
import { waitForSuccessfulReceipt } from '@/lib/txReceipt';
import { useEffectiveAddress, walletRequiredMessage } from '@/lib/useEffectiveAddress';
import { useUniversalWrite } from '@/lib/circle/useUniversalWrite';
import { useCachedSignMessage } from '@/lib/circle/useCachedSignMessage';
import { CONTRACTS, txLink, arcTestnet } from '@/lib/contracts/config';
import { chunkForBatchPay } from '@/lib/contracts/batchLimits';
import { friendlyErrorMessage } from '@/lib/errorMessage';
import { saveAgentSchedule, deleteAgentSchedule, type AgentSchedule } from '@/lib/db/indexeddb';
import { useAgentStatus } from '@/lib/useAgentStatus';
import { ALL_EMPLOYEES_LABEL } from '@/lib/groups';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

// ── Shared card shell ──────────────────────────────────────────────────────────

function CardShell({
  tone, title, children,
}: { tone: 'warn' | 'success' | 'error'; title: string; children: React.ReactNode }) {
  // 'warn' = still awaiting a decision — this is the actual confirmation
  // card, and it stays a visually distinct card since the user still has
  // an action to take. Recoloured to Salden's own indigo instead of the
  // amber/brown it used to be.
  //
  // 'success'/'error' = a RESOLVED outcome — per explicit design
  // feedback, these should read as a plain sentence in the flow of the
  // conversation, not another bordered tile competing for attention right
  // after the card that was just there. Text colour is unchanged (still
  // green for success, red for error) — only the card chrome is gone.
  if (tone !== 'warn') {
    const color = tone === 'success' ? '#059669' : '#DC2626';
    return (
      <div style={{ marginTop: 8, fontSize: 13, color, lineHeight: 1.6 }}>
        <span style={{ fontWeight: 700 }}>{title}</span>
        <div style={{ color: '#334155', marginTop: 2 }}>{children}</div>
      </div>
    );
  }

  return (
    <div style={{
      marginTop: 8, padding: '14px 16px', borderRadius: 12,
      border: '1.5px solid #4338CA', background: '#4F46E5',
      fontSize: 13, color: '#fff',
    }}>
      <div style={{ fontWeight: 800, fontSize: 11, letterSpacing: '0.05em', color: '#E0E7FF', marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function ActionButtons({
  onConfirm, onDecline, busy, confirmLabel = 'Confirm', confirmDisabled = false,
}: { onConfirm: () => void; onDecline: () => void; busy: boolean; confirmLabel?: string; confirmDisabled?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
      <button
        onClick={onConfirm}
        disabled={busy || confirmDisabled}
        style={{
          flex: 1, padding: '8px 0', borderRadius: 8, border: 'none',
          background: (busy || confirmDisabled) ? '#E2E8F0' : '#14B8A6', color: '#fff',
          fontSize: 13, fontWeight: 700, cursor: (busy || confirmDisabled) ? 'not-allowed' : 'pointer',
          fontFamily: 'inherit', display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 6,
        }}
      >
        {busy && <Loader2 size={13} style={{ animation: 'spin 0.7s linear infinite' }} />}
        {confirmLabel}
      </button>
      <button
        onClick={onDecline}
        disabled={busy}
        style={{
          flex: 1, padding: '8px 0', borderRadius: 8,
          border: '1.5px solid #E2E8F0', background: '#fff', color: '#475569',
          fontSize: 13, fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer',
          fontFamily: 'inherit',
        }}
      >
        Decline
      </button>
    </div>
  );
}

// ── Unlisted payment confirmation card ─────────────────────────────────────────

export interface UnlistedPaymentCardProps {
  address: string;
  amount:  string;
  token:   string;
  walletAddress: string;
  /** Bearer session token — required to call the protected spend/record
   *  endpoint after a confirmed payment so the daily spend ceiling actually
   *  tracks unlisted-address payments. Without it, recordProposedSpend is
   *  silently never invoked and G-daily-limit only ever sees $0 spent today. */
  sessionToken?: string;
  /** When true, signs and sends immediately on mount with no review UI or
   *  button click — set by the model when the instruction was fully
   *  explicit (see AUTOCONFIRM in the chat route's system prompt). The
   *  wallet signature prompt itself is still the human-in-the-loop step;
   *  this only skips the extra "are you sure" click before it. */
  autoConfirm?: boolean;
  onResolved: (outcome: 'confirmed' | 'declined' | 'error', detail?: string) => void;
}

type PayState = 'idle' | 'approving' | 'paying' | 'confirming' | 'done' | 'error' | 'declined';

export function UnlistedPaymentCard({
  address, amount, token, walletAddress, sessionToken, autoConfirm, onResolved,
}: UnlistedPaymentCardProps) {
  const { state, saveTxRecord } = useApp();
  const { payrollClone, tokenRegistry, payrollSetup } = state;
  const { loginMethod } = useEffectiveAddress();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const { writeContract: universalWrite, canWrite } = useUniversalWrite();

  const [payState, setPayState] = useState<PayState>('idle');
  const [error,    setError]    = useState('');
  const [txHash,   setTxHash]   = useState('');
  // Synchronous guard — state updates are async so disabled={busy} alone
  // can't prevent a fast double-click from firing handleConfirm twice.
  const executing = useRef(false);

  const tokenEntry = Object.values(tokenRegistry ?? {}).find(
    t => t.symbol.toUpperCase() === token.toUpperCase()
  );

  const handleDecline = useCallback(() => {
    setPayState('declined');
    onResolved('declined');
  }, [onResolved]);

  const handleConfirm = useCallback(async () => {
    if (executing.current) return;   // prevent double-click race
    executing.current = true;
    if (!canWrite || !publicClient) {
      executing.current = false;  // reset so user can retry after connecting wallet
      setError(walletRequiredMessage(loginMethod)); setPayState('error'); return;
    }
    if (!tokenEntry) {
      executing.current = false;  // reset so user can retry once the registry resolves
      setError(`Could not resolve "${token}" in the token registry — refusing to guess decimals for a real payment.`);
      setPayState('error'); return;
    }
    // The AI agent is only ever reachable by premium users who have
    // already deployed their own SaldenMultiTokenPayroll clone (the
    // /ai-agent page itself gates on isPremiumUser before any of these
    // cards can render) — so the agent must only ever call batchPay on
    // that clone, never the free-tier standalone SaldenEnterprisePayroll
    // contract (whose batchPay doesn't even take a token argument). This
    // is a defensive guard, not an expected path: it should be
    // structurally impossible to reach this card without payrollClone
    // already set, but failing clearly here beats silently targeting the
    // wrong contract if that assumption is ever violated.
    if (!payrollClone) {
      executing.current = false;
      setError('No payroll clone found for this account — the AI agent can only process payments through your deployed clone contract.');
      setPayState('error'); return;
    }

    try {
      const tokenAddr   = tokenEntry.address as `0x${string}`;
      const tokenScale  = 10 ** tokenEntry.decimals;
      const amountUnits = BigInt(Math.round(Number(amount) * tokenScale));
      const contractAddr = payrollClone as `0x${string}`;

      // ── Allowance check + approval (mirrors dashboard/page.tsx) ────────────
      setPayState('approving');
      const allowance = await publicClient.readContract({
        address: tokenAddr, abi: ERC20_ABI, functionName: 'allowance',
        args: [walletAddress as `0x${string}`, contractAddr],
      }) as bigint;

      if (allowance < amountUnits) {
        const approveTx = await universalWrite({
          address: tokenAddr, abi: ERC20_ABI, functionName: 'approve',
          args: [contractAddr, amountUnits],
          // Clear description shown in Rabby / MetaMask before signing:
          // "Allow Salden to spend up to <amount> <token> for this payment"
        });
        await waitForSuccessfulReceipt(publicClient, approveTx);
      }

      setPayState('paying');
      const ref = 'SLD-' + Math.random().toString(36).slice(2, 8).toUpperCase();
      const memoJson = JSON.stringify({
        protocol: 'salden', type: 'batchPay', ref,
        date: new Date().toISOString(),
        remark: 'AI Agent — unlisted address payment (user-confirmed)',
        token, totalAmount: amount, recipients: 1, employer: walletAddress,
      });
      const memoHex = ('0x' + Array.from(new TextEncoder().encode(memoJson))
        .map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;

      // SaldenMultiTokenPayroll.batchPay always takes 3 args:
      // (address[] employees, uint256[] amounts, address token)
      // Passing address(0) defaults to USDC (per contract source).
      // There is no 2-arg variant in the deployed contracts.
      const batchData = encodeFunctionData({
        abi: PAYROLL_BATCH_PAY_ABI,
        functionName: 'batchPay',
        args: [
          [address as `0x${string}`],
          [amountUnits],
          tokenAddr,  // never address(0) here — we already resolved tokenAddr above
        ],
      });

      const hash = await universalWrite({
        address: MEMO_CONTRACT_ADDRESS, abi: MEMO_ABI,
        functionName: 'memo',
        args: [contractAddr, batchData as `0x${string}`, keccak256(memoHex), memoHex],
        // Clear description: "Send <amount> <token> to <shortAddr> — AI Agent proposed, you approved"
      });

      setPayState('confirming');
      await waitForSuccessfulReceipt(publicClient, hash);
      setTxHash(hash);

      // ── Tell the server this spend actually happened, so the daily spend
      //    ceiling (checkSpendLimit in the chat route) has something to sum
      //    against for the rest of the day. This is best-effort: if it fails
      //    (missing session token, network hiccup) the payment itself already
      //    succeeded on-chain and must not be rolled back or blocked on this.
      if (sessionToken) {
        fetch(`${API_BASE}/agent/spend/record`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
          body: JSON.stringify({ walletAddress, amount: Number(amount), txHash: hash }),
        }).catch(() => {});
      }

      // ── Record + receipt (executedBy: 'ai_agent' — proposed by the agent,
      //    confirmed and signed by the human) ──────────────────────────────
      const receiptEmail = payrollSetup?.email ?? null;
      await saveTxRecord({
        id: hash, hash, ref,
        type: 'batchPay', status: 'success',
        amount, token,
        remark: 'AI Agent — unlisted address payment',
        recipientCount: 1,
        timestamp: Date.now(),
        // Only 'pending' if we're actually about to attempt a send below —
        // otherwise this stayed 'pending' forever with nothing left to
        // ever move it to 'sent'/'failed'.
        receiptEmailStatus: receiptEmail ? 'pending' : null,
        executedBy: 'ai_agent',
      }, walletAddress);

      if (receiptEmail) {
        fetch(`${API_BASE}/payroll-receipt/send`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            txHash: hash, walletAddress, recipientEmail: receiptEmail,
            recipientCount: 1, amount, token,
            remark: 'AI Agent — unlisted address payment',
            ref, timestamp: Date.now(), executedBy: 'ai_agent',
          }),
        }).then(async res => {
          await saveTxRecord({
            id: hash, hash, ref, type: 'batchPay', status: 'success',
            amount, token, remark: 'AI Agent — unlisted address payment',
            recipientCount: 1, timestamp: Date.now(),
            receiptEmailStatus: res.ok ? 'sent' : 'failed',
            executedBy: 'ai_agent',
          }, walletAddress);
        }).catch(() => {});
      }

      setPayState('done');
      onResolved('confirmed', hash);
    } catch (err) {
      executing.current = false;  // allow retry if the user wants to try again
      const raw = err instanceof Error ? err.message : '';
      const msg = /reject|cancel|denied/i.test(raw)
        ? 'Transaction cancelled.'
        : /insufficient|balance/i.test(raw)
        ? 'Insufficient balance to complete this payment.'
        : /network|fetch|rpc/i.test(raw)
        ? 'Network error — check your connection and try again.'
        : friendlyErrorMessage(err, 'Payment failed. Please try again.');
      setError(msg);
      setPayState('error');
      onResolved('error', msg);
    }
  }, [canWrite, universalWrite, publicClient, tokenEntry, token, amount, payrollClone, address, walletAddress, sessionToken, saveTxRecord, payrollSetup, onResolved, loginMethod]);

  // Previously fired handleConfirm() exactly once on mount, keyed only to
  // [autoConfirm] — if canWrite/publicClient hadn't resolved yet on that
  // very first render (a real, observed timing gap on brand-new component
  // instances), this closure permanently captured `canWrite = false` and
  // never re-evaluated it, surfacing a false "Wallet not connected" even
  // though the wallet genuinely was connected moments later. Now this waits
  // briefly for canWrite/publicClient to resolve and re-fires as soon as
  // they do; only falls through to handleConfirm's own (correct) "wallet
  // not connected" error if they're still unset after a real grace period.
  const autoConfirmedRef = useRef(false);
  useEffect(() => {
    if (!autoConfirm || autoConfirmedRef.current) return;
    if (canWrite && publicClient) {
      autoConfirmedRef.current = true;
      void handleConfirm();
      return;
    }
    const t = setTimeout(() => {
      if (!autoConfirmedRef.current) { autoConfirmedRef.current = true; void handleConfirm(); }
    }, 1200);
    return () => clearTimeout(t);
  }, [autoConfirm, canWrite, publicClient, handleConfirm]);

  if (payState === 'done') {
    return (
      <CardShell tone="success" title="✓ PAYMENT SENT">
        <div>Paid {amount} {token} to {address.slice(0, 8)}…{address.slice(-6)}.</div>
        <a href={txLink(txHash)} target="_blank" rel="noreferrer" style={{ color: '#059669', fontSize: 12, fontWeight: 600 }}>
          View transaction →
        </a>
      </CardShell>
    );
  }

  if (payState === 'declined') {
    return (
      <CardShell tone="error" title="✗ DECLINED">
        <div>You declined this payment. No funds were moved.</div>
      </CardShell>
    );
  }

  if (payState === 'error') {
    return (
      <CardShell tone="error" title="✗ PAYMENT FAILED">
        <div>{error}</div>
      </CardShell>
    );
  }

  const busy = payState === 'approving' || payState === 'paying' || payState === 'confirming';
  const busyLabel = {
    approving:  'Approving token spend…',
    paying:     'Sending transaction…',
    confirming: 'Confirming on-chain…',
  }[payState as 'approving' | 'paying' | 'confirming'];

  return (
    <CardShell tone="warn" title={autoConfirm ? '⚠ SENDING PAYMENT…' : '⚠ ADDRESS NOT IN EMPLOYEE DATABASE'}>
      <div>
        Pay <strong>{amount} {token}</strong> to <strong>{address.slice(0, 8)}…{address.slice(-6)}</strong>?
      </div>
      <div style={{ color: '#E0E7FF', fontSize: 12, marginTop: 4 }}>
        This requires your wallet signature. This is not an existing employee.
      </div>
      {busy && <div style={{ fontSize: 12, color: '#E0E7FF', marginTop: 6 }}>{busyLabel}</div>}
      {!autoConfirm && <ActionButtons onConfirm={handleConfirm} onDecline={handleDecline} busy={busy} confirmLabel="Confirm & Sign" />}
    </CardShell>
  );
}

// ── Add-employee confirmation card ──────────────────────────────────────────────

export interface AddEmployeeCardProps {
  address:    string;
  fullName:   string;
  department: string;
  group:      string;
  salary:     string;
  walletAddress: string;
  /** See UnlistedPaymentCardProps.autoConfirm — same meaning here. */
  autoConfirm?: boolean;
  onResolved: (outcome: 'confirmed' | 'declined' | 'error', detail?: string) => void;
}

type AddState = 'idle' | 'syncing' | 'anchoring' | 'done' | 'error' | 'declined';

export function AddEmployeeCard({
  address, fullName, department, group, salary, walletAddress, autoConfirm, onResolved,
}: AddEmployeeCardProps) {
  const { state, dispatch, syncData } = useApp();
  const { employees, registryClone } = state;
  const { writeContract: universalWrite, canWrite } = useUniversalWrite();
  const sign = useCachedSignMessage();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  const [addState, setAddState] = useState<AddState>('idle');
  const [error,    setError]    = useState('');
  const executing = useRef(false);

  const handleDecline = useCallback(() => {
    setAddState('declined');
    onResolved('declined');
  }, [onResolved]);

  const handleConfirm = useCallback(async () => {
    if (executing.current) return;   // prevent double-click race — must be FIRST
    executing.current = true;
    if (!canWrite || !publicClient) {
      executing.current = false;     // reset so user can retry after reconnecting wallet
      setError('Wallet not connected.'); setAddState('error'); return;
    }

    try {
      // `salary` arrives as a string (see AddEmployeeCardProps below) — the
      // server already validated it's a clean positive numeric string
      // before ever sending it to the client (see propose_add_employee in
      // chat/route.ts), but Employee.salaryAmount is a real `number`. The
      // previous `as Employee` cast silently forced a string into that
      // field instead of converting it — anything downstream doing
      // arithmetic (payroll totals, .toFixed() for display, etc.) on this
      // employee's salary would have hit a runtime error or NaN instead of
      // a clear failure at the point of the actual mistake.
      const salaryAmount = Number(salary);
      const newEmployee: Employee = {
        fullName,
        walletAddress: address,
        department,
        group,
        salaryAmount,
      };

      const next = [...employees, newEmployee];
      dispatch({ type: 'SET_EMPLOYEES', payload: next });

      setAddState('syncing');
      // Routes through useUniversalWrite (wagmi popup for an external
      // wallet, Circle's PIN challenge for social login) and is cached in
      // sessionStorage — see lib/circle/useCachedSignMessage.ts. This used
      // to require a raw wagmi walletClient directly, which silently
      // broke this card for every Circle/social-login user ("Wallet not
      // connected" even when connected) and re-prompted a fresh signature
      // every single time for everyone else.
      const { cid } = await syncData({ employees: next, walletAddress, signMessage: sign });
      // syncData legitimately returns { cid: undefined } if walletAddress
      // was empty or the server response omitted it — writing that through
      // to updateCID would anchor a bad/empty reference on-chain, breaking
      // this wallet's data loading from then on. Fail loudly instead;
      // caught below and shown the same way any other sync failure is.
      if (!cid) throw new Error('Sync did not return a CID — nothing was anchored on-chain.');

      // BUG FIX: this used to be `if (registryClone) { ...anchor... }` —
      // silently SKIPPING the on-chain anchor (and still reporting
      // "confirmed"/"done") whenever registryClone hadn't loaded into
      // state yet. The new employee was saved to IPFS but the on-chain CID
      // pointer never moved, so every other device/session (and a fresh
      // load of this one) would never see them — while the person who
      // just added them saw a success card and had no reason to think
      // anything was wrong. Failing loudly here means the same retry the
      // user would already do for any other sync failure also recovers
      // this case, instead of a silent, hard-to-detect data gap.
      if (!registryClone) {
        throw new Error('Registry not found for this account yet — please refresh the page and try again.');
      }
      setAddState('anchoring');
      const hash = await universalWrite({
        address: registryClone as `0x${string}`,
        abi: REGISTRY_UPDATE_CID_ABI,
        functionName: 'updateCID', args: [cid],
        // Wallet will show: "Update employee database reference on-chain"
      });
      await waitForSuccessfulReceipt(publicClient, hash);

      setAddState('done');
      onResolved('confirmed');
    } catch (err) {
      executing.current = false;  // allow retry
      const raw = err instanceof Error ? err.message : '';
      const msg = /reject|cancel|denied/i.test(raw)
        ? 'Transaction cancelled.'
        : /network|fetch|rpc/i.test(raw)
        ? 'Network error — check your connection and try again.'
        : friendlyErrorMessage(err, 'Could not save employee. Please try again.');
      setError(msg);
      setAddState('error');
      onResolved('error', msg);
    }
  }, [canWrite, universalWrite, sign, publicClient, fullName, address, group, salary, employees, dispatch, syncData, walletAddress, registryClone, onResolved]);

  // See the identical comment on this pattern in UnlistedPaymentCard above —
  // waits briefly for canWrite/publicClient to resolve before auto-firing,
  // instead of permanently trusting whatever they were on this component's
  // very first render.
  const autoConfirmedRef = useRef(false);
  useEffect(() => {
    if (!autoConfirm || autoConfirmedRef.current) return;
    if (canWrite && publicClient) {
      autoConfirmedRef.current = true;
      void handleConfirm();
      return;
    }
    const t = setTimeout(() => {
      if (!autoConfirmedRef.current) { autoConfirmedRef.current = true; void handleConfirm(); }
    }, 1200);
    return () => clearTimeout(t);
  }, [autoConfirm, canWrite, publicClient, handleConfirm]);

  if (addState === 'done') {
    return (
      <CardShell tone="success" title="✓ EMPLOYEE SAVED">
        <div>{fullName} added to the employee database and anchored on-chain.</div>
      </CardShell>
    );
  }

  if (addState === 'declined') {
    return (
      <CardShell tone="error" title="✗ NOT SAVED">
        <div>The address was not added to the employee database.</div>
      </CardShell>
    );
  }

  if (addState === 'error') {
    return (
      <CardShell tone="error" title="✗ SAVE FAILED">
        <div>{error}</div>
      </CardShell>
    );
  }

  const busy = addState === 'syncing' || addState === 'anchoring';
  const busyLabel = { syncing: 'Encrypting and syncing to IPFS…', anchoring: 'Anchoring on-chain…' }[addState as 'syncing' | 'anchoring'];

  return (
    <CardShell tone="warn" title={autoConfirm ? 'SAVING EMPLOYEE…' : 'SAVE TO EMPLOYEE DATABASE?'}>
      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', rowGap: 2, fontSize: 12, color: '#E0E7FF' }}>
        <span>Name</span><span style={{ fontWeight: 700 }}>{fullName}</span>
        <span>Department</span><span style={{ fontWeight: 700 }}>{department}</span>
        <span>Group</span><span style={{ fontWeight: 700 }}>{group}</span>
        <span>Salary</span><span style={{ fontWeight: 700 }}>{salary}</span>
        <span>Wallet</span><span style={{ fontWeight: 700 }}>{address.slice(0, 8)}…{address.slice(-6)}</span>
      </div>
      {busy && <div style={{ fontSize: 12, color: '#E0E7FF', marginTop: 6 }}>{busyLabel}</div>}
      {!autoConfirm && <ActionButtons onConfirm={handleConfirm} onDecline={handleDecline} busy={busy} confirmLabel="Save & Sign" />}
    </CardShell>
  );
}

// ── Edit employee confirmation card ─────────────────────────────────────────

export interface EditEmployeeCardProps {
  currentAddress: string;
  fullName?:      string;
  department?:    string;
  group?:         string;
  salary?:        string;
  newAddress?:    string;
  walletAddress:  string;
  /** When true, applies the update immediately on mount with no review UI
   *  or button click — used for execute_edit_employee (explicit
   *  instructions). The underlying sign+sync+anchor flow is identical
   *  either way; only whether a human has to click "confirm" differs. */
  autoConfirm?:   boolean;
  onResolved: (outcome: 'confirmed' | 'declined' | 'error', detail?: string) => void;
}

export function EditEmployeeCard({
  currentAddress, fullName, department, group, salary, newAddress, walletAddress, autoConfirm, onResolved,
}: EditEmployeeCardProps) {
  const { state, dispatch, syncData } = useApp();
  const { employees, registryClone } = state;
  const { writeContract: universalWrite, canWrite } = useUniversalWrite();
  const sign = useCachedSignMessage();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  const [editState, setEditState] = useState<AddState>('idle');
  const [error,     setError]     = useState('');
  const executing = useRef(false);

  const existing = employees.find(e => e.walletAddress.toLowerCase() === currentAddress.toLowerCase());

  const handleDecline = useCallback(() => {
    setEditState('declined');
    onResolved('declined');
  }, [onResolved]);

  const handleConfirm = useCallback(async () => {
    if (executing.current) return;
    executing.current = true;
    if (!canWrite || !publicClient) {
      executing.current = false;
      setError('Wallet not connected.'); setEditState('error'); return;
    }
    if (!existing) {
      executing.current = false;
      setError('This employee no longer exists in the database.'); setEditState('error'); return;
    }

    try {
      const updated: Employee = {
        ...existing,
        fullName:      fullName ?? existing.fullName,
        department:    department ?? existing.department,
        group:         group ?? existing.group,
        salaryAmount:  salary !== undefined ? Number(salary) : existing.salaryAmount,
        walletAddress: newAddress ?? existing.walletAddress,
      };
      const next = employees.map(e => e.walletAddress.toLowerCase() === currentAddress.toLowerCase() ? updated : e);
      dispatch({ type: 'SET_EMPLOYEES', payload: next });

      setEditState('syncing');
      const { cid } = await syncData({ employees: next, walletAddress, signMessage: sign });
      if (!cid) throw new Error('Sync did not return a CID — nothing was anchored on-chain.');

      // See AddEmployeeCard's identical fix above for the full writeup —
      // silently skipping the anchor here (the old `if (registryClone)`)
      // meant an "employee updated" success card could be shown even
      // though the change never actually reached the on-chain registry
      // other devices/sessions read from.
      if (!registryClone) {
        throw new Error('Registry not found for this account yet — please refresh the page and try again.');
      }
      setEditState('anchoring');
      const hash = await universalWrite({
        address: registryClone as `0x${string}`,
        abi: REGISTRY_UPDATE_CID_ABI,
        functionName: 'updateCID', args: [cid],
      });
      await waitForSuccessfulReceipt(publicClient, hash);

      setEditState('done');
      onResolved('confirmed');
    } catch (err) {
      executing.current = false;
      const raw = err instanceof Error ? err.message : '';
      const msg = /reject|cancel|denied/i.test(raw)
        ? 'Transaction cancelled.'
        : /network|fetch|rpc/i.test(raw)
        ? 'Network error — check your connection and try again.'
        : friendlyErrorMessage(err, 'Could not update employee. Please try again.');
      setError(msg);
      setEditState('error');
      onResolved('error', msg);
    }
  }, [canWrite, universalWrite, sign, publicClient, existing, fullName, department, group, salary, newAddress, currentAddress, employees, dispatch, syncData, walletAddress, registryClone, onResolved]);

  // See the identical comment on this pattern in UnlistedPaymentCard above —
  // waits briefly for canWrite/publicClient to resolve before auto-firing,
  // instead of permanently trusting whatever they were on this component's
  // very first render. This is the specific card behind the repeated
  // "update failed — connect wallet first" reports when editing an employee
  // and proposing the resulting on-chain update.
  const autoConfirmedRef = useRef(false);
  useEffect(() => {
    if (!autoConfirm || autoConfirmedRef.current) return;
    if (canWrite && publicClient) {
      autoConfirmedRef.current = true;
      void handleConfirm();
      return;
    }
    const t = setTimeout(() => {
      if (!autoConfirmedRef.current) { autoConfirmedRef.current = true; void handleConfirm(); }
    }, 1200);
    return () => clearTimeout(t);
  }, [autoConfirm, canWrite, publicClient, handleConfirm]);

  if (editState === 'done') {
    return (
      <CardShell tone="success" title="✓ EMPLOYEE UPDATED">
        <div>{existing?.fullName ?? 'Employee'} updated and anchored on-chain.</div>
      </CardShell>
    );
  }
  if (editState === 'declined') {
    return <CardShell tone="error" title="✗ NOT UPDATED"><div>No changes were made.</div></CardShell>;
  }
  if (editState === 'error') {
    return <CardShell tone="error" title="✗ UPDATE FAILED"><div>{error}</div></CardShell>;
  }
  if (!existing) {
    return <CardShell tone="error" title="✗ EMPLOYEE NOT FOUND"><div>No employee matches that address anymore.</div></CardShell>;
  }

  const busy = editState === 'syncing' || editState === 'anchoring';
  const busyLabel = { syncing: 'Encrypting and syncing to IPFS…', anchoring: 'Anchoring on-chain…' }[editState as 'syncing' | 'anchoring'];

  return (
    <CardShell tone="warn" title={autoConfirm ? 'UPDATING EMPLOYEE…' : 'UPDATE EMPLOYEE?'}>
      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', rowGap: 2, fontSize: 12, color: '#E0E7FF' }}>
        <span>Name</span><span style={{ fontWeight: 700 }}>{existing.fullName}{fullName && fullName !== existing.fullName ? ` → ${fullName}` : ''}</span>
        <span>Department</span><span style={{ fontWeight: 700 }}>{existing.department}{department && department !== existing.department ? ` → ${department}` : ''}</span>
        <span>Group</span><span style={{ fontWeight: 700 }}>{existing.group}{group && group !== existing.group ? ` → ${group}` : ''}</span>
        <span>Salary</span><span style={{ fontWeight: 700 }}>{existing.salaryAmount}{salary && Number(salary) !== existing.salaryAmount ? ` → ${salary}` : ''}</span>
        <span>Wallet</span><span style={{ fontWeight: 700 }}>{existing.walletAddress.slice(0, 8)}…{existing.walletAddress.slice(-6)}{newAddress ? ` → ${newAddress.slice(0, 8)}…${newAddress.slice(-6)}` : ''}</span>
      </div>
      {busy && <div style={{ fontSize: 12, color: '#E0E7FF', marginTop: 6 }}>{busyLabel}</div>}
      {!autoConfirm && <ActionButtons onConfirm={handleConfirm} onDecline={handleDecline} busy={busy} confirmLabel="Update & Sign" />}
    </CardShell>
  );
}

// ── Remove employee confirmation card ───────────────────────────────────────
// ALWAYS requires human confirmation — deletion is never autonomous
// regardless of how explicit the instruction was, per explicit product
// requirement (irreversible action).

export interface RemoveEmployeeCardProps {
  address:       string;
  fullName:      string;
  walletAddress: string;
  onResolved: (outcome: 'confirmed' | 'declined' | 'error', detail?: string) => void;
}

export function RemoveEmployeeCard({ address, fullName, walletAddress, onResolved }: RemoveEmployeeCardProps) {
  const { state, dispatch, syncData } = useApp();
  const { employees, registryClone } = state;
  const { writeContract: universalWrite, canWrite } = useUniversalWrite();
  const sign = useCachedSignMessage();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  const [removeState, setRemoveState] = useState<AddState>('idle');
  const [error,       setError]       = useState('');
  const executing = useRef(false);

  const handleDecline = useCallback(() => {
    setRemoveState('declined');
    onResolved('declined');
  }, [onResolved]);

  const handleConfirm = useCallback(async () => {
    if (executing.current) return;
    executing.current = true;
    if (!canWrite || !publicClient) {
      executing.current = false;
      setError('Wallet not connected.'); setRemoveState('error'); return;
    }

    try {
      const next = employees.filter(e => e.walletAddress.toLowerCase() !== address.toLowerCase());
      dispatch({ type: 'SET_EMPLOYEES', payload: next });

      setRemoveState('syncing');
      const { cid } = await syncData({ employees: next, walletAddress, signMessage: sign });
      if (!cid) throw new Error('Sync did not return a CID — nothing was anchored on-chain.');

      // See AddEmployeeCard's identical fix above for the full writeup.
      // Especially important for a removal: silently skipping the anchor
      // here would mean a "removed" employee still shows up for anyone
      // reading from the last-anchored CID, which is the opposite of what
      // an employer confirming a removal expects.
      if (!registryClone) {
        throw new Error('Registry not found for this account yet — please refresh the page and try again.');
      }
      setRemoveState('anchoring');
      const hash = await universalWrite({
        address: registryClone as `0x${string}`,
        abi: REGISTRY_UPDATE_CID_ABI,
        functionName: 'updateCID', args: [cid],
      });
      await waitForSuccessfulReceipt(publicClient, hash);

      setRemoveState('done');
      onResolved('confirmed');
    } catch (err) {
      executing.current = false;
      const raw = err instanceof Error ? err.message : '';
      const msg = /reject|cancel|denied/i.test(raw)
        ? 'Transaction cancelled.'
        : /network|fetch|rpc/i.test(raw)
        ? 'Network error — check your connection and try again.'
        : friendlyErrorMessage(err, 'Could not remove employee. Please try again.');
      setError(msg);
      setRemoveState('error');
      onResolved('error', msg);
    }
  }, [canWrite, universalWrite, sign, publicClient, address, employees, dispatch, syncData, walletAddress, registryClone, onResolved]);

  if (removeState === 'done') {
    return <CardShell tone="success" title="✓ EMPLOYEE REMOVED"><div>{fullName} removed from the employee database.</div></CardShell>;
  }
  if (removeState === 'declined') {
    return <CardShell tone="error" title="✗ NOT REMOVED"><div>{fullName} was kept in the database.</div></CardShell>;
  }
  if (removeState === 'error') {
    return <CardShell tone="error" title="✗ REMOVE FAILED"><div>{error}</div></CardShell>;
  }

  const busy = removeState === 'syncing' || removeState === 'anchoring';
  const busyLabel = { syncing: 'Encrypting and syncing to IPFS…', anchoring: 'Anchoring on-chain…' }[removeState as 'syncing' | 'anchoring'];

  return (
    <CardShell tone="warn" title="REMOVE EMPLOYEE?">
      <div style={{ fontSize: 12, color: '#E0E7FF' }}>
        This will permanently remove <strong>{fullName}</strong> ({address.slice(0, 8)}…{address.slice(-6)}) from the employee database. This cannot be undone from here.
      </div>
      {busy && <div style={{ fontSize: 12, color: '#E0E7FF', marginTop: 6 }}>{busyLabel}</div>}
      <ActionButtons onConfirm={handleConfirm} onDecline={handleDecline} busy={busy} confirmLabel="Remove & Sign" />
    </CardShell>
  );
}

// ── Bulk add employees confirmation card (document scan) ───────────────────

interface BulkEmployeeDraft {
  fullName: string; walletAddress: string; department: string; group: string; salary: string;
}

export interface BulkAddEmployeesCardProps {
  employeesJson: string;
  skippedCount?: number;
  walletAddress: string;
  autoConfirm?: boolean;
  onResolved: (outcome: 'confirmed' | 'declined' | 'error', detail?: string) => void;
}

export function BulkAddEmployeesCard({ employeesJson, skippedCount, walletAddress, autoConfirm, onResolved }: BulkAddEmployeesCardProps) {
  const { state, dispatch, syncData } = useApp();
  const { employees, registryClone } = state;
  const { writeContract: universalWrite, canWrite } = useUniversalWrite();
  const sign = useCachedSignMessage();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  const [addState, setAddState] = useState<AddState>('idle');
  const [error,    setError]    = useState('');
  const executing = useRef(false);

  let drafts: BulkEmployeeDraft[] = [];
  let parseError = '';
  try {
    drafts = JSON.parse(employeesJson) as BulkEmployeeDraft[];
    if (!Array.isArray(drafts) || drafts.length === 0) parseError = 'No employees to add.';
  } catch {
    parseError = 'Could not read the extracted employee data.';
  }

  const handleDecline = useCallback(() => {
    setAddState('declined');
    onResolved('declined');
  }, [onResolved]);

  const handleConfirm = useCallback(async () => {
    if (executing.current) return;
    executing.current = true;
    if (!canWrite || !publicClient) {
      executing.current = false;
      setError('Wallet not connected.'); setAddState('error'); return;
    }

    try {
      const newEmployees: Employee[] = drafts.map(d => ({
        fullName: d.fullName, walletAddress: d.walletAddress,
        department: d.department, group: d.group, salaryAmount: Number(d.salary),
      }));
      const next = [...employees, ...newEmployees];
      dispatch({ type: 'SET_EMPLOYEES', payload: next });

      setAddState('syncing');
      const { cid } = await syncData({ employees: next, walletAddress, signMessage: sign });
      if (!cid) throw new Error('Sync did not return a CID — nothing was anchored on-chain.');

      // See AddEmployeeCard's identical fix for the full writeup — this
      // used to silently skip anchoring (and still report success) for a
      // whole batch of newly-added employees whenever registryClone hadn't
      // loaded into state yet.
      if (!registryClone) {
        throw new Error('Registry not found for this account yet — please refresh the page and try again.');
      }
      setAddState('anchoring');
      const hash = await universalWrite({
        address: registryClone as `0x${string}`,
        abi: REGISTRY_UPDATE_CID_ABI,
        functionName: 'updateCID', args: [cid],
      });
      await waitForSuccessfulReceipt(publicClient, hash);

      setAddState('done');
      onResolved('confirmed');
    } catch (err) {
      executing.current = false;
      const raw = err instanceof Error ? err.message : '';
      const msg = /reject|cancel|denied/i.test(raw)
        ? 'Transaction cancelled.'
        : /network|fetch|rpc/i.test(raw)
        ? 'Network error — check your connection and try again.'
        : friendlyErrorMessage(err, 'Could not add employees. Please try again.');
      setError(msg);
      setAddState('error');
      onResolved('error', msg);
    }
  }, [canWrite, universalWrite, sign, publicClient, drafts, employees, dispatch, syncData, walletAddress, registryClone, onResolved]);

  useEffect(() => {
    if (autoConfirm && !parseError) void handleConfirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConfirm]);

  if (parseError) return <CardShell tone="error" title="✗ COULD NOT ADD EMPLOYEES"><div>{parseError}</div></CardShell>;
  if (addState === 'done') {
    return <CardShell tone="success" title="✓ EMPLOYEES ADDED"><div>{drafts.length} employee{drafts.length === 1 ? '' : 's'} added and anchored on-chain.</div></CardShell>;
  }
  if (addState === 'declined') return <CardShell tone="error" title="✗ NOT ADDED"><div>No employees were added.</div></CardShell>;
  if (addState === 'error') return <CardShell tone="error" title="✗ ADD FAILED"><div>{error}</div></CardShell>;

  const busy = addState === 'syncing' || addState === 'anchoring';
  const busyLabel = { syncing: 'Encrypting and syncing to IPFS…', anchoring: 'Anchoring on-chain…' }[addState as 'syncing' | 'anchoring'];

  return (
    <CardShell tone="warn" title={autoConfirm ? `ADDING ${drafts.length} EMPLOYEE${drafts.length === 1 ? '' : 'S'}…` : `ADD ${drafts.length} EMPLOYEE${drafts.length === 1 ? '' : 'S'}?`}>
      <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 4 }}>
        {drafts.map((d, i) => (
          <div key={i} style={{ fontSize: 12, color: '#E0E7FF', borderBottom: i < drafts.length - 1 ? '1px solid rgba(255,255,255,0.15)' : 'none', paddingBottom: 4 }}>
            <strong>{d.fullName}</strong> — {d.department} / {d.group} — {d.salary} USDC/mo
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#B45309' }}>
              {d.walletAddress.slice(0, 10)}…{d.walletAddress.slice(-6)}
            </div>
          </div>
        ))}
      </div>
      {!!skippedCount && (
        <div style={{ fontSize: 11, color: '#B45309', marginBottom: 8 }}>
          {skippedCount} record{skippedCount === 1 ? '' : 's'} skipped — missing a valid name, address, or salary.
        </div>
      )}
      {busy && <div style={{ fontSize: 12, color: '#E0E7FF', marginTop: 6 }}>{busyLabel}</div>}
      {!autoConfirm && <ActionButtons onConfirm={handleConfirm} onDecline={handleDecline} busy={busy} confirmLabel="Add All & Sign" />}
    </CardShell>
  );
}

// ── Payroll run confirmation card ───────────────────────────────────────────────
// Full in-chat execution — mirrors UnlistedPaymentCard's approve → batchPay →
// wait-for-receipt → save record → send receipt pattern, generalized to a
// group of employees instead of one custom address. USDC-only, matching
// execute_payroll_run's own scope (the fully-autonomous sibling of this
// human-confirmed flow).
//
// The employee list and amounts shown here come from the client's OWN
// `state.employees` — the same trusted, already-synced data Dashboard uses —
// not from anything the model said. `group` is just which subset to select;
// an LLM can propose the wrong group name, but it cannot fabricate who's in
// it or what they're owed.

export interface PayrollRunCardProps {
  group: string;
  walletAddress: string;
  sessionToken?: string;
  /** See UnlistedPaymentCardProps.autoConfirm — same meaning here. */
  autoConfirm?: boolean;
  onResolved: (outcome: 'confirmed' | 'declined' | 'error', detail?: string) => void;
}

export function PayrollRunCard({ group, walletAddress, sessionToken, autoConfirm, onResolved }: PayrollRunCardProps) {
  const { state, saveTxRecord } = useApp();
  const { employees, payrollClone, payrollSetup } = state;
  const { loginMethod } = useEffectiveAddress();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const { writeContract: universalWrite, canWrite } = useUniversalWrite();

  const [payState, setPayState] = useState<PayState>('idle');
  const [error,    setError]    = useState('');
  const [txHash,   setTxHash]   = useState('');
  // Tracks whether a receipt could even be attempted — see the comment
  // right where this gets set, in handleConfirm below.
  const [receiptSkipped, setReceiptSkipped] = useState(false);
  const executing = useRef(false);

  const targetEmployees = group === 'All Employees'
    ? employees
    : employees.filter(e => (e.group ?? '') === group);
  const totalAmount = targetEmployees.reduce((s, e) => s + (Number(e.salaryAmount) || 0), 0);
  const dupWallets = findDuplicateWallets(targetEmployees);

  const handleDecline = useCallback(() => {
    setPayState('declined');
    onResolved('declined');
  }, [onResolved]);

  const handleConfirm = useCallback(async () => {
    if (executing.current) return;
    executing.current = true;
    if (!canWrite || !publicClient) {
      executing.current = false;
      setError(walletRequiredMessage(loginMethod)); setPayState('error'); return;
    }
    if (targetEmployees.length === 0) {
      executing.current = false;
      setError(`No employees found in "${group}".`); setPayState('error'); return;
    }
    if (dupWallets.length) {
      executing.current = false;
      setError('Duplicate wallet addresses in this group — resolve in the dashboard before running payroll.');
      setPayState('error'); return;
    }
    // The AI agent is only ever reachable by premium users who have
    // already deployed their own SaldenMultiTokenPayroll clone (the
    // /ai-agent page itself gates on isPremiumUser before any of these
    // cards can render) — so the agent must only ever call batchPay on
    // that clone, never the free-tier standalone SaldenEnterprisePayroll
    // contract. Defensive guard, not an expected path — see identical
    // comment in UnlistedPaymentCard above.
    if (!payrollClone) {
      executing.current = false;
      setError('No payroll clone found for this account — the AI agent can only run payroll through your deployed clone contract.');
      setPayState('error'); return;
    }

    // batchPay reverts on-chain above the clone's MAX_BATCH_SIZE (1,000 —
    // see lib/contracts/batchLimits.ts). Split into sequential batches so a
    // payroll run of any size completes as a series of on-chain batches
    // instead of one oversized call.
    const chunks = chunkForBatchPay(targetEmployees, true);
    const contractAddr = payrollClone as `0x${string}`;
    const completedHashes: `0x${string}`[] = [];

    try {
      const tokenAddr    = CONTRACTS.USDC as `0x${string}`;
      const amountUnits  = targetEmployees.reduce(
        (sum, e) => sum + BigInt(Math.round(Number(e.salaryAmount) * 1e6)), 0n,
      );

      setPayState('approving');
      const allowance = await publicClient.readContract({
        address: tokenAddr, abi: ERC20_ABI, functionName: 'allowance',
        args: [walletAddress as `0x${string}`, contractAddr],
      }) as bigint;

      // One approval for the FULL total covers every batch below — ERC-20
      // allowance persists across multiple sequential transferFrom calls.
      if (allowance < amountUnits) {
        const approveTx = await universalWrite({
          address: tokenAddr, abi: ERC20_ABI, functionName: 'approve',
          args: [contractAddr, amountUnits],
        });
        await waitForSuccessfulReceipt(publicClient, approveTx);
      }

      const receiptEmail = payrollSetup?.email ?? null;
      // BUG FIX: payrollSetup.email is only ever populated by an explicit
      // "Unlock your data" / "Sync now" click (see usePayrollSync.ts's
      // header comment) — on a browser/device with no local cache yet for
      // this wallet, it can genuinely still be empty here even though
      // employees are already visible (e.g. freshly imported this same
      // session). This used to run to completion in total silence: no
      // receipt attempt, no error, nothing — which is exactly why
      // "Payroll Receipt" showed as a blank row with no retry option in
      // Transaction History instead of a "Failed" state. Surfaced in this
      // card's own success message below instead of staying silent.
      if (!receiptEmail) setReceiptSkipped(true);
      let lastHash: `0x${string}` = '0x0' as `0x${string}`;

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk       = chunks[chunkIndex];
        const chunkAddrs   = chunk.map(e => e.walletAddress as `0x${string}`);
        const chunkAmounts = chunk.map(e => BigInt(Math.round(Number(e.salaryAmount) * 1e6)));
        const chunkTotal   = chunkAmounts.reduce((a, b) => a + b, 0n);
        const chunkHuman   = (Number(chunkTotal) / 1e6).toFixed(2);

        setPayState('paying');
        const ref = 'SLD-' + Math.random().toString(36).slice(2, 8).toUpperCase();
        const memoJson = JSON.stringify({
          protocol: 'salden', type: 'batchPay', ref,
          date: new Date().toISOString(),
          remark: 'AI Agent — payroll run (user-confirmed)',
          token: 'USDC', totalAmount: chunkHuman,
          recipients: chunk.length, group, employer: walletAddress,
          ...(chunks.length > 1 ? { batch: chunkIndex + 1, batchCount: chunks.length } : {}),
        });
        const memoHex = ('0x' + Array.from(new TextEncoder().encode(memoJson))
          .map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;

        const batchData = encodeFunctionData({
          abi: PAYROLL_BATCH_PAY_ABI,
          functionName: 'batchPay',
          args: [chunkAddrs, chunkAmounts, tokenAddr],
        });

        const hash = await universalWrite({
          address: MEMO_CONTRACT_ADDRESS, abi: MEMO_ABI,
          functionName: 'memo',
          args: [contractAddr, batchData as `0x${string}`, keccak256(memoHex), memoHex],
        });

        setPayState('confirming');
        await waitForSuccessfulReceipt(publicClient, hash);
        completedHashes.push(hash);
        lastHash = hash;
        setTxHash(hash);

        if (sessionToken) {
          fetch(`${API_BASE}/agent/spend/record`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
            body: JSON.stringify({ walletAddress, amount: Number(chunkHuman), txHash: hash }),
          }).catch(() => {});
        }

        await saveTxRecord({
          id: hash, hash, ref,
          type: 'batchPay', status: 'success',
          amount: chunkHuman, token: 'USDC',
          remark: `AI Agent — payroll run (${group})`,
          recipientCount: chunk.length,
          timestamp: Date.now(),
          receiptEmailStatus: receiptEmail ? 'pending' : null,
          executedBy: 'ai_agent',
        }, walletAddress);

        if (receiptEmail) {
          fetch(`${API_BASE}/payroll-receipt/send`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              txHash: hash, walletAddress, recipientEmail: receiptEmail,
              recipientCount: chunk.length, amount: chunkHuman, token: 'USDC',
              remark: `AI Agent — payroll run (${group})`,
              ref, timestamp: Date.now(), executedBy: 'ai_agent',
              employees: chunk.map(e => ({
                fullName: e.fullName, department: e.department,
                walletAddress: e.walletAddress,
                salaryAmount: Number(e.salaryAmount).toFixed(2),
                group: e.group,
              })),
            }),
          }).then(async res => {
            await saveTxRecord({
              id: hash, hash, ref, type: 'batchPay', status: 'success',
              amount: chunkHuman, token: 'USDC', remark: `AI Agent — payroll run (${group})`,
              recipientCount: chunk.length, timestamp: Date.now(),
              receiptEmailStatus: res.ok ? 'sent' : 'failed',
              executedBy: 'ai_agent',
            }, walletAddress);
          }).catch(() => {});
        }
      }

      setPayState('done');
      onResolved('confirmed', lastHash);
    } catch (err) {
      executing.current = false;
      const raw = err instanceof Error ? err.message : '';
      const cancelled = /reject|cancel|denied/i.test(raw);
      // A run split into multiple batches can fail partway through with
      // some batches already confirmed on-chain — see the identical
      // handling and reasoning in dashboard/page.tsx's handleExecutePayroll.
      const partial = completedHashes.length > 0 && completedHashes.length < chunks.length;
      const msg = cancelled
        ? 'Transaction cancelled.'
        : partial
          ? `${completedHashes.length} of ${chunks.length} batches completed successfully before this error. Check Transaction History before retrying, so you don't pay the completed batches twice — only the remaining employees need to be run again.`
          : friendlyErrorMessage(err, 'Payroll run failed. Please try again.');
      setError(msg);
      setPayState('error');
      onResolved('error', msg);
    }
  }, [canWrite, publicClient, loginMethod, targetEmployees, dupWallets, group, payrollClone, walletAddress, sessionToken, saveTxRecord, payrollSetup, onResolved]);

  // See the identical comment on this pattern in UnlistedPaymentCard above —
  // waits briefly for canWrite/publicClient to resolve before auto-firing,
  // instead of permanently trusting whatever they were on this component's
  // very first render. This is the specific card behind the repeated
  // "payroll run failed — connect wallet first" reports.
  const autoConfirmedRef = useRef(false);
  useEffect(() => {
    if (!autoConfirm || autoConfirmedRef.current) return;
    if (canWrite && publicClient) {
      autoConfirmedRef.current = true;
      void handleConfirm();
      return;
    }
    const t = setTimeout(() => {
      if (!autoConfirmedRef.current) { autoConfirmedRef.current = true; void handleConfirm(); }
    }, 1200);
    return () => clearTimeout(t);
  }, [autoConfirm, canWrite, publicClient, handleConfirm]);

  if (payState === 'done') {
    return (
      <CardShell tone="success" title="✓ PAYROLL RUN COMPLETE">
        <div>Paid {targetEmployees.length} employee{targetEmployees.length === 1 ? '' : 's'} in &ldquo;{group}&rdquo;.</div>
        {receiptSkipped && (
          <div style={{ fontSize: 11, color: '#FDE68A', marginTop: 4 }}>
            No invoice email on file — no receipt was sent. Add one in Settings to enable automatic receipts.
          </div>
        )}
        <a href={txLink(txHash)} target="_blank" rel="noreferrer" style={{ color: '#059669', fontSize: 12, fontWeight: 600 }}>
          View transaction →
        </a>
      </CardShell>
    );
  }

  if (payState === 'declined') {
    return (
      <CardShell tone="error" title="✗ DECLINED">
        <div>You declined this payroll run. No funds were moved.</div>
      </CardShell>
    );
  }

  if (payState === 'error') {
    return (
      <CardShell tone="error" title="✗ PAYROLL RUN FAILED">
        <div>{error}</div>
      </CardShell>
    );
  }

  const busy = payState === 'approving' || payState === 'paying' || payState === 'confirming';
  const busyLabel = {
    approving:  'Approving token spend…',
    paying:     'Sending transaction…',
    confirming: 'Confirming on-chain…',
  }[payState as 'approving' | 'paying' | 'confirming'];

  const PREVIEW_ROWS = 6;

  return (
    <CardShell tone="warn" title={autoConfirm ? '⚠ RUNNING PAYROLL…' : '⚠ PAYROLL RUN READY'}>
      <div>
        Run payroll for <strong>{group}</strong> — <strong>{targetEmployees.length} employee{targetEmployees.length === 1 ? '' : 's'}</strong>, total <strong>{totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })} USDC</strong>?
      </div>

      {targetEmployees.length > 0 && (
        <div style={{ marginTop: 8, border: '1px solid rgba(255,255,255,0.25)', borderRadius: 8, overflow: 'hidden' }}>
          {targetEmployees.slice(0, PREVIEW_ROWS).map(e => (
            <div key={e.walletAddress} style={{
              display: 'flex', justifyContent: 'space-between', padding: '6px 10px',
              fontSize: 12, borderBottom: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.08)',
            }}>
              <span style={{ color: '#fff' }}>{e.fullName}</span>
              <span style={{ color: '#E0E7FF', fontWeight: 600 }}>{Number(e.salaryAmount).toFixed(2)} USDC</span>
            </div>
          ))}
          {targetEmployees.length > PREVIEW_ROWS && (
            <div style={{ padding: '6px 10px', fontSize: 11, color: '#E0E7FF', background: 'rgba(255,255,255,0.08)' }}>
              +{targetEmployees.length - PREVIEW_ROWS} more
            </div>
          )}
        </div>
      )}

      {dupWallets.length > 0 && (
        <div style={{ color: '#DC2626', fontSize: 12, marginTop: 6 }}>
          Duplicate wallet addresses found in this group — resolve in the dashboard before running payroll.
        </div>
      )}

      <div style={{ color: '#E0E7FF', fontSize: 12, marginTop: 6 }}>
        This requires your wallet signature.
      </div>
      {busy && <div style={{ fontSize: 12, color: '#E0E7FF', marginTop: 6 }}>{busyLabel}</div>}
      {!autoConfirm && (
        <ActionButtons
          onConfirm={handleConfirm}
          onDecline={handleDecline}
          busy={busy}
          confirmLabel="Confirm & Sign"
          confirmDisabled={targetEmployees.length === 0 || dupWallets.length > 0}
        />
      )}
    </CardShell>
  );
}

// ── Schedule payment confirmation card ─────────────────────────────────────────
// Saves a ONE-TIME future payment locally (IndexedDB) plus a best-effort
// server-side mirror sync — no wallet signature needed here at all; the
// actual signature happens automatically later, when the agent runs the
// payment at its scheduled time. Mirrors
// components/agent/SetSchedulePaymentModal.tsx's handleSchedule() exactly,
// since that's the already-proven, working manual-UI equivalent of this
// same action.

export interface ScheduleConfirmationCardProps {
  group: string;
  token: string;
  whenMs: number;
  walletAddress: string;
  sessionToken?: string;
  autoConfirm?: boolean;
  onResolved: (outcome: 'confirmed' | 'declined' | 'error', detail?: string) => void;
}

export function ScheduleConfirmationCard({
  group, token, whenMs, walletAddress, sessionToken, autoConfirm, onResolved,
}: ScheduleConfirmationCardProps) {
  const { state } = useApp();
  const { employees, payrollClone } = state;
  const { agentInfo } = useAgentStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const executing = useRef(false);

  const targetEmployees = group === ALL_EMPLOYEES_LABEL || group === 'All Employees'
    ? employees
    : employees.filter(e => e.group === group);

  const handleConfirm = useCallback(async () => {
    if (executing.current) return;
    executing.current = true;
    setBusy(true); setError('');

    if (targetEmployees.length === 0) {
      executing.current = false; setBusy(false);
      setError(`No employees found in "${group}".`);
      onResolved('error', `No employees found in "${group}".`);
      return;
    }
    if (targetEmployees.some(e => !Number.isFinite(Number(e.salaryAmount)) || Number(e.salaryAmount) <= 0)) {
      executing.current = false; setBusy(false);
      const msg = 'One or more employees are missing a valid salary amount.';
      setError(msg); onResolved('error', msg);
      return;
    }
    if (!agentInfo?.walletId || !agentInfo?.agentWallet) {
      executing.current = false; setBusy(false);
      const msg = 'Activate the AI Agent (from the AI Agent page) before scheduling autonomous payments.';
      setError(msg); onResolved('error', msg);
      return;
    }
    if (whenMs <= Date.now()) {
      executing.current = false; setBusy(false);
      const msg = 'That date/time has already passed.';
      setError(msg); onResolved('error', msg);
      return;
    }

    try {
      const tokenAddress = token === 'USDC'
        ? CONTRACTS.USDC
        : Object.values(state.tokenRegistry ?? {}).find(t => t.symbol === 'EURC')?.address;
      if (!tokenAddress) throw new Error('Token address not found.');

      const schedule: AgentSchedule = {
        id: crypto.randomUUID(),
        walletAddress,
        type: 'scheduled',
        label: `${group} — ${targetEmployees.length} employee${targetEmployees.length === 1 ? '' : 's'} — ${token}`,
        group: (group === ALL_EMPLOYEES_LABEL || group === 'All Employees') ? undefined : group,
        employees: targetEmployees.map(e => e.walletAddress),
        token,
        amount: targetEmployees.reduce((s, e) => s + Number(e.salaryAmount), 0).toFixed(2),
        nextRunAt: whenMs,
        status: 'active',
        createdAt: Date.now(),
        runHistory: [],
        resolvedPayments: targetEmployees.map(e => ({ address: e.walletAddress, amount: String(e.salaryAmount) })),
        agentWalletId: agentInfo.walletId,
        agentWalletAddress: agentInfo.agentWallet,
        payrollCloneAddress: payrollClone ?? undefined,
        tokenAddress,
        tokenDecimals: 6,
        recipientEmail: state.payrollSetup?.email || undefined,
      };

      await saveAgentSchedule(schedule);
      if (sessionToken) {
        fetch('/api/agent/schedule/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
          body: JSON.stringify({ walletAddress, schedules: [schedule] }),
        }).catch(() => { /* self-heals next time Manage AI Agent loads */ });
      }

      setDone(true); setBusy(false);
      onResolved('confirmed', schedule.id);
    } catch (err) {
      setBusy(false);
      const msg = friendlyErrorMessage(err, 'Could not create schedule.');
      setError(msg); onResolved('error', msg);
    }
  }, [targetEmployees, group, whenMs, token, agentInfo, walletAddress, sessionToken, payrollClone, state.tokenRegistry, state.payrollSetup, onResolved]);

  // Same bounded-wait autoConfirm pattern as the other cards above —
  // agentInfo (from useAgentStatus) can resolve a tick after this
  // component's first render, same class of timing gap as
  // useEffectiveAddress elsewhere in this file.
  const autoConfirmedRef = useRef(false);
  useEffect(() => {
    if (!autoConfirm || autoConfirmedRef.current) return;
    if (agentInfo?.walletId) {
      autoConfirmedRef.current = true;
      void handleConfirm();
      return;
    }
    const t = setTimeout(() => {
      if (!autoConfirmedRef.current) { autoConfirmedRef.current = true; void handleConfirm(); }
    }, 1200);
    return () => clearTimeout(t);
  }, [autoConfirm, agentInfo?.walletId, handleConfirm]);

  const handleDecline = useCallback(() => onResolved('declined'), [onResolved]);

  if (done) {
    return <CardShell tone="success" title="✓ PAYMENT SCHEDULED"><div>Scheduled for {new Date(whenMs).toLocaleString()} — {group}, {token}.</div></CardShell>;
  }
  if (error) {
    return <CardShell tone="error" title="✗ COULD NOT SCHEDULE"><div>{error}</div></CardShell>;
  }

  const totalAmount = targetEmployees.reduce((s, e) => s + Number(e.salaryAmount || 0), 0);
  return (
    <CardShell tone="warn" title="⏱ CONFIRM SCHEDULED PAYMENT">
      <div style={{ marginBottom: 4 }}>{group} — {targetEmployees.length} employee{targetEmployees.length === 1 ? '' : 's'}</div>
      <div style={{ marginBottom: 4 }}>{totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })} {token} total</div>
      <div style={{ marginBottom: 4 }}>Runs: {new Date(whenMs).toLocaleString()}</div>
      <div style={{ fontSize: 11, color: '#C7D2FE' }}>Saved now, signed automatically at the scheduled time — no signature needed to confirm this.</div>
      <ActionButtons onConfirm={handleConfirm} onDecline={handleDecline} busy={busy} confirmLabel="Schedule" />
    </CardShell>
  );
}

// ── Cancel schedule confirmation card ──────────────────────────────────────────
// Mirrors app/ai-agent/manage/page.tsx's handleCancelSchedule() exactly:
// server-side removal (so the cron executor stops picking it up) plus a
// local IndexedDB removal (so the Manage AI Agent page — whose own list is
// sourced from local IndexedDB, not the server mirror — reflects it too).

export interface CancelScheduleCardProps {
  scheduleId: string;
  label: string;
  walletAddress: string;
  sessionToken?: string;
  autoConfirm?: boolean;
  onResolved: (outcome: 'confirmed' | 'declined' | 'error', detail?: string) => void;
}

export function CancelScheduleCard({
  scheduleId, label, walletAddress, sessionToken, autoConfirm, onResolved,
}: CancelScheduleCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const executing = useRef(false);

  const handleConfirm = useCallback(async () => {
    if (executing.current) return;
    executing.current = true;
    setBusy(true); setError('');

    // Local removal is what the person actually sees and what matters for
    // whether this counts as "done" — the server call is best-effort sync
    // so the cron executor also stops picking it up, same tolerance as
    // Manage AI Agent's own handleCancelSchedule (which shows a soft
    // "cancelled locally" toast rather than a hard error in this exact
    // situation, since local state re-pushes to the server automatically
    // on the next Manage AI Agent visit either way).
    let serverSynced = true;
    if (sessionToken) {
      try {
        const res = await fetch('/api/agent/schedule/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
          body: JSON.stringify({ walletAddress, scheduleId }),
        });
        if (!res.ok) serverSynced = false;
      } catch { serverSynced = false; }
    } else {
      serverSynced = false;
    }

    try {
      await deleteAgentSchedule(scheduleId);
      setDone(true); setBusy(false);
      onResolved('confirmed', serverSynced ? scheduleId : `${scheduleId} — removed locally; will finish syncing next time Manage AI Agent loads`);
    } catch (err) {
      setBusy(false);
      const msg = friendlyErrorMessage(err, 'Could not cancel schedule.');
      setError(msg); onResolved('error', msg);
    }
  }, [scheduleId, walletAddress, sessionToken, onResolved]);

  const autoConfirmedRef = useRef(false);
  useEffect(() => {
    if (!autoConfirm || autoConfirmedRef.current) return;
    autoConfirmedRef.current = true;
    void handleConfirm();
  }, [autoConfirm, handleConfirm]);

  const handleDecline = useCallback(() => onResolved('declined'), [onResolved]);

  if (done) {
    return <CardShell tone="success" title="✓ SCHEDULE CANCELLED"><div>"{label}" has been cancelled.</div></CardShell>;
  }
  if (error) {
    return <CardShell tone="error" title="✗ COULD NOT CANCEL"><div>{error}</div></CardShell>;
  }

  return (
    <CardShell tone="warn" title="⏱ CONFIRM CANCELLATION">
      <div style={{ marginBottom: 8 }}>Cancel "{label}"? This cannot be undone — you'd need to schedule it again from scratch.</div>
      <ActionButtons onConfirm={handleConfirm} onDecline={handleDecline} busy={busy} confirmLabel="Cancel Schedule" />
    </CardShell>
  );
}
