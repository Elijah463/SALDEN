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
import { useWalletClient, usePublicClient } from 'wagmi';
import { encodeFunctionData } from 'viem';
import { Loader2 } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import type { Employee } from '@/context/AppContext';
import {
  PAYROLL_BATCH_PAY_ABI,
  REGISTRY_UPDATE_CID_ABI,
} from '@/lib/contracts/agentAbis';
import { MEMO_ABI, MEMO_CONTRACT_ADDRESS, ERC20_ABI } from '@/lib/contracts/abis';
import { CONTRACTS, txLink } from '@/lib/contracts/config';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

// ── Shared card shell ──────────────────────────────────────────────────────────

function CardShell({
  tone, title, children,
}: { tone: 'warn' | 'success' | 'error'; title: string; children: React.ReactNode }) {
  const palette = {
    warn:    { border: '#FED7AA', bg: '#FFFBEB', accent: '#92400E' },
    success: { border: '#6EE7B7', bg: '#F0FDF4', accent: '#059669' },
    error:   { border: '#FCA5A5', bg: '#FEF2F2', accent: '#DC2626' },
  }[tone];

  return (
    <div style={{
      marginTop: 8, padding: '12px 16px', borderRadius: 12,
      border: `1.5px solid ${palette.border}`, background: palette.bg,
      fontSize: 13,
    }}>
      <div style={{ fontWeight: 800, fontSize: 11, letterSpacing: '0.05em', color: palette.accent, marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function ActionButtons({
  onConfirm, onDecline, busy, confirmLabel = 'Confirm',
}: { onConfirm: () => void; onDecline: () => void; busy: boolean; confirmLabel?: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
      <button
        onClick={onConfirm}
        disabled={busy}
        style={{
          flex: 1, padding: '8px 0', borderRadius: 8, border: 'none',
          background: busy ? '#E2E8F0' : '#14B8A6', color: '#fff',
          fontSize: 13, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer',
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
  onResolved: (outcome: 'confirmed' | 'declined' | 'error', detail?: string) => void;
}

type PayState = 'idle' | 'approving' | 'paying' | 'confirming' | 'done' | 'error' | 'declined';

export function UnlistedPaymentCard({
  address, amount, token, walletAddress, sessionToken, onResolved,
}: UnlistedPaymentCardProps) {
  const { state, saveTxRecord } = useApp();
  const { payrollClone, tokenRegistry, payrollSetup } = state;
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

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
    if (!walletClient || !publicClient) {
      executing.current = false;  // reset so user can retry after connecting wallet
      setError('Wallet not connected.'); setPayState('error'); return;
    }
    if (!tokenEntry) {
      executing.current = false;  // reset so user can retry once the registry resolves
      setError(`Could not resolve "${token}" in the token registry — refusing to guess decimals for a real payment.`);
      setPayState('error'); return;
    }

    try {
      const tokenAddr   = tokenEntry.address as `0x${string}`;
      const tokenScale  = 10 ** tokenEntry.decimals;
      const amountUnits = BigInt(Math.round(Number(amount) * tokenScale));
      const contractAddr = (payrollClone ? payrollClone : CONTRACTS.ENTERPRISE_PAYROLL) as `0x${string}`;

      // ── Allowance check + approval (mirrors dashboard/page.tsx) ────────────
      setPayState('approving');
      const allowance = await publicClient.readContract({
        address: tokenAddr, abi: ERC20_ABI, functionName: 'allowance',
        args: [walletAddress as `0x${string}`, contractAddr],
      }) as bigint;

      if (allowance < amountUnits) {
        const approveTx = await walletClient.writeContract({
          address: tokenAddr, abi: ERC20_ABI, functionName: 'approve',
          args: [contractAddr, amountUnits],
          // Clear description shown in Rabby / MetaMask before signing:
          // "Allow Salden to spend up to <amount> <token> for this payment"
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
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

      const hash = await walletClient.writeContract({
        address: MEMO_CONTRACT_ADDRESS, abi: MEMO_ABI,
        functionName: 'callWithMemo',
        args: [contractAddr, batchData as `0x${string}`, memoHex, 0n],
        // Clear description: "Send <amount> <token> to <shortAddr> — AI Agent proposed, you approved"
      });

      setPayState('confirming');
      await publicClient.waitForTransactionReceipt({ hash });
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

      // ── Record + invoice (executedBy: 'ai_agent' — proposed by the agent,
      //    confirmed and signed by the human) ──────────────────────────────
      await saveTxRecord({
        id: hash, hash, ref,
        type: 'batchPay', status: 'success',
        amount, token,
        remark: 'AI Agent — unlisted address payment',
        recipientCount: 1,
        timestamp: Date.now(),
        invoiceEmailStatus: 'pending',
        executedBy: 'ai_agent',
      }, walletAddress);

      const invoiceEmail = payrollSetup?.email ?? null;
      if (invoiceEmail) {
        fetch(`${API_BASE}/invoice/send`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            txHash: hash, walletAddress, recipientEmail: invoiceEmail,
            recipientCount: 1, amount, token,
            remark: 'AI Agent — unlisted address payment',
            ref, timestamp: Date.now(), executedBy: 'ai_agent',
          }),
        }).then(async res => {
          await saveTxRecord({
            id: hash, hash, ref, type: 'batchPay', status: 'success',
            amount, token, remark: 'AI Agent — unlisted address payment',
            recipientCount: 1, timestamp: Date.now(),
            invoiceEmailStatus: res.ok ? 'sent' : 'failed',
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
        : 'Payment failed. Please try again.';
      setError(msg);
      setPayState('error');
      onResolved('error', msg);
    }
  }, [walletClient, publicClient, tokenEntry, token, amount, payrollClone, address, walletAddress, sessionToken, saveTxRecord, payrollSetup, onResolved]);

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
    <CardShell tone="warn" title="⚠ ADDRESS NOT IN EMPLOYEE DATABASE">
      <div>
        Pay <strong>{amount} {token}</strong> to <strong>{address.slice(0, 8)}…{address.slice(-6)}</strong>?
      </div>
      <div style={{ color: '#92400E', fontSize: 12, marginTop: 4 }}>
        This requires your wallet signature. This is not an existing employee.
      </div>
      {busy && <div style={{ fontSize: 12, color: '#92400E', marginTop: 6 }}>{busyLabel}</div>}
      <ActionButtons onConfirm={handleConfirm} onDecline={handleDecline} busy={busy} confirmLabel="Confirm & Sign" />
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
  onResolved: (outcome: 'confirmed' | 'declined' | 'error', detail?: string) => void;
}

type AddState = 'idle' | 'syncing' | 'anchoring' | 'done' | 'error' | 'declined';

export function AddEmployeeCard({
  address, fullName, department, group, salary, walletAddress, onResolved,
}: AddEmployeeCardProps) {
  const { state, dispatch, syncData } = useApp();
  const { employees, registryClone } = state;
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

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
    if (!walletClient || !publicClient) {
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
      // account required in wagmi v2 for external wallets (Rabby, etc.)
      // Wallet will show: "Sign to encrypt and save employee data to IPFS"
      const sign = (msg: string) => walletClient.signMessage({
        account: walletAddress as `0x${string}`,
        message: msg,
      });
      const { cid } = await syncData({ employees: next, walletAddress, signMessage: sign });

      if (registryClone) {
        setAddState('anchoring');
        const hash = await walletClient.writeContract({
          address: registryClone as `0x${string}`,
          abi: REGISTRY_UPDATE_CID_ABI,
          functionName: 'updateCID', args: [cid],
          // Wallet will show: "Update employee database reference on-chain"
        });
        await publicClient.waitForTransactionReceipt({ hash });
      }

      setAddState('done');
      onResolved('confirmed');
    } catch (err) {
      executing.current = false;  // allow retry
      const raw = err instanceof Error ? err.message : '';
      const msg = /reject|cancel|denied/i.test(raw)
        ? 'Transaction cancelled.'
        : /network|fetch|rpc/i.test(raw)
        ? 'Network error — check your connection and try again.'
        : 'Could not save employee. Please try again.';
      setError(msg);
      setAddState('error');
      onResolved('error', msg);
    }
  }, [walletClient, publicClient, fullName, address, group, salary, employees, dispatch, syncData, walletAddress, registryClone, onResolved]);

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
    <CardShell tone="warn" title="SAVE TO EMPLOYEE DATABASE?">
      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', rowGap: 2, fontSize: 12, color: '#92400E' }}>
        <span>Name</span><span style={{ fontWeight: 700 }}>{fullName}</span>
        <span>Department</span><span style={{ fontWeight: 700 }}>{department}</span>
        <span>Group</span><span style={{ fontWeight: 700 }}>{group}</span>
        <span>Salary</span><span style={{ fontWeight: 700 }}>{salary}</span>
        <span>Wallet</span><span style={{ fontWeight: 700 }}>{address.slice(0, 8)}…{address.slice(-6)}</span>
      </div>
      {busy && <div style={{ fontSize: 12, color: '#92400E', marginTop: 6 }}>{busyLabel}</div>}
      <ActionButtons onConfirm={handleConfirm} onDecline={handleDecline} busy={busy} confirmLabel="Save & Sign" />
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
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

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
    if (!walletClient || !publicClient) {
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
      const sign = (msg: string) => walletClient.signMessage({ account: walletAddress as `0x${string}`, message: msg });
      const { cid } = await syncData({ employees: next, walletAddress, signMessage: sign });

      if (registryClone) {
        setEditState('anchoring');
        const hash = await walletClient.writeContract({
          address: registryClone as `0x${string}`,
          abi: REGISTRY_UPDATE_CID_ABI,
          functionName: 'updateCID', args: [cid],
        });
        await publicClient.waitForTransactionReceipt({ hash });
      }

      setEditState('done');
      onResolved('confirmed');
    } catch (err) {
      executing.current = false;
      const raw = err instanceof Error ? err.message : '';
      const msg = /reject|cancel|denied/i.test(raw)
        ? 'Transaction cancelled.'
        : /network|fetch|rpc/i.test(raw)
        ? 'Network error — check your connection and try again.'
        : 'Could not update employee. Please try again.';
      setError(msg);
      setEditState('error');
      onResolved('error', msg);
    }
  }, [walletClient, publicClient, existing, fullName, department, group, salary, newAddress, currentAddress, employees, dispatch, syncData, walletAddress, registryClone, onResolved]);

  useEffect(() => {
    if (autoConfirm) void handleConfirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConfirm]);

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
      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', rowGap: 2, fontSize: 12, color: '#92400E' }}>
        <span>Name</span><span style={{ fontWeight: 700 }}>{existing.fullName}{fullName && fullName !== existing.fullName ? ` → ${fullName}` : ''}</span>
        <span>Department</span><span style={{ fontWeight: 700 }}>{existing.department}{department && department !== existing.department ? ` → ${department}` : ''}</span>
        <span>Group</span><span style={{ fontWeight: 700 }}>{existing.group}{group && group !== existing.group ? ` → ${group}` : ''}</span>
        <span>Salary</span><span style={{ fontWeight: 700 }}>{existing.salaryAmount}{salary && Number(salary) !== existing.salaryAmount ? ` → ${salary}` : ''}</span>
        <span>Wallet</span><span style={{ fontWeight: 700 }}>{existing.walletAddress.slice(0, 8)}…{existing.walletAddress.slice(-6)}{newAddress ? ` → ${newAddress.slice(0, 8)}…${newAddress.slice(-6)}` : ''}</span>
      </div>
      {busy && <div style={{ fontSize: 12, color: '#92400E', marginTop: 6 }}>{busyLabel}</div>}
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
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

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
    if (!walletClient || !publicClient) {
      executing.current = false;
      setError('Wallet not connected.'); setRemoveState('error'); return;
    }

    try {
      const next = employees.filter(e => e.walletAddress.toLowerCase() !== address.toLowerCase());
      dispatch({ type: 'SET_EMPLOYEES', payload: next });

      setRemoveState('syncing');
      const sign = (msg: string) => walletClient.signMessage({ account: walletAddress as `0x${string}`, message: msg });
      const { cid } = await syncData({ employees: next, walletAddress, signMessage: sign });

      if (registryClone) {
        setRemoveState('anchoring');
        const hash = await walletClient.writeContract({
          address: registryClone as `0x${string}`,
          abi: REGISTRY_UPDATE_CID_ABI,
          functionName: 'updateCID', args: [cid],
        });
        await publicClient.waitForTransactionReceipt({ hash });
      }

      setRemoveState('done');
      onResolved('confirmed');
    } catch (err) {
      executing.current = false;
      const raw = err instanceof Error ? err.message : '';
      const msg = /reject|cancel|denied/i.test(raw)
        ? 'Transaction cancelled.'
        : /network|fetch|rpc/i.test(raw)
        ? 'Network error — check your connection and try again.'
        : 'Could not remove employee. Please try again.';
      setError(msg);
      setRemoveState('error');
      onResolved('error', msg);
    }
  }, [walletClient, publicClient, address, employees, dispatch, syncData, walletAddress, registryClone, onResolved]);

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
      <div style={{ fontSize: 12, color: '#92400E' }}>
        This will permanently remove <strong>{fullName}</strong> ({address.slice(0, 8)}…{address.slice(-6)}) from the employee database. This cannot be undone from here.
      </div>
      {busy && <div style={{ fontSize: 12, color: '#92400E', marginTop: 6 }}>{busyLabel}</div>}
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
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

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
    if (!walletClient || !publicClient) {
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
      const sign = (msg: string) => walletClient.signMessage({ account: walletAddress as `0x${string}`, message: msg });
      const { cid } = await syncData({ employees: next, walletAddress, signMessage: sign });

      if (registryClone) {
        setAddState('anchoring');
        const hash = await walletClient.writeContract({
          address: registryClone as `0x${string}`,
          abi: REGISTRY_UPDATE_CID_ABI,
          functionName: 'updateCID', args: [cid],
        });
        await publicClient.waitForTransactionReceipt({ hash });
      }

      setAddState('done');
      onResolved('confirmed');
    } catch (err) {
      executing.current = false;
      const raw = err instanceof Error ? err.message : '';
      const msg = /reject|cancel|denied/i.test(raw)
        ? 'Transaction cancelled.'
        : /network|fetch|rpc/i.test(raw)
        ? 'Network error — check your connection and try again.'
        : 'Could not add employees. Please try again.';
      setError(msg);
      setAddState('error');
      onResolved('error', msg);
    }
  }, [walletClient, publicClient, drafts, employees, dispatch, syncData, walletAddress, registryClone, onResolved]);

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
          <div key={i} style={{ fontSize: 12, color: '#92400E', borderBottom: i < drafts.length - 1 ? '1px solid #FDE68A' : 'none', paddingBottom: 4 }}>
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
      {busy && <div style={{ fontSize: 12, color: '#92400E', marginTop: 6 }}>{busyLabel}</div>}
      {!autoConfirm && <ActionButtons onConfirm={handleConfirm} onDecline={handleDecline} busy={busy} confirmLabel="Add All & Sign" />}
    </CardShell>
  );
}
// No wallet signature needed — this is a deep link into the existing, already-
// audited dashboard execution flow. The agent proposes the group, the human
// reviews employee list and amounts on the dashboard, then signs there.

export interface PayrollRunCardProps {
  group: string;
}

export function PayrollRunCard({ group }: PayrollRunCardProps) {
  const href = `/dashboard?group=${encodeURIComponent(group)}`;
  return (
    <div style={{
      marginTop: 8, padding: '12px 16px', borderRadius: 12,
      border: '1.5px solid #C7D2FE', background: '#EEF2FF', fontSize: 13,
    }}>
      <div style={{ fontWeight: 700, color: '#4338CA', marginBottom: 4 }}>
        Payroll Run Ready — {group}
      </div>
      <div style={{ color: '#475569', fontSize: 12, marginBottom: 10 }}>
        I've prepared a payroll run for <strong>{group}</strong>. Review the
        employee list and amounts on the dashboard, then sign the transaction.
      </div>
      <a
        href={href}
        style={{
          display: 'inline-block', padding: '8px 18px', borderRadius: 8,
          background: '#4F46E5', color: '#fff', fontSize: 13, fontWeight: 700,
          textDecoration: 'none',
        }}
      >
        Go to Dashboard →
      </a>
    </div>
  );
}
