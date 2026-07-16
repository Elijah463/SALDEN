'use client';
/**
 * @file app/dashboard/page.tsx
 * Audit fixes applied:
 *  - useReadContract args always provided (never undefined); query.enabled gates execution
 *  - Static imports used throughout handleExecutePayroll (no duplicate dynamic imports)
 *  - ERC20_ABI / REGISTRY_FACTORY_ABI / CONTRACTS used from static imports only
 *  - EmployeeModal defined at module level (not inside DashboardPage) to prevent remount
 */

import {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react';
import {
  Search, UserPlus, ChevronDown,
  Pencil, Trash2, AlertTriangle, Loader2,
  CheckCircle2, Copy, Users, Eye, EyeOff,
  Upload, FileText, Filter, Banknote,
} from 'lucide-react';
import {
  usePublicClient, useBalance,
} from 'wagmi';
import { encodeFunctionData, keccak256 } from 'viem';
import { AppLayout }      from '@/components/layout/AppLayout';
import { useApp }         from '@/context/AppContext';
import { Modal }          from '@/components/shared/Modal';
import { useEffectiveAddress, walletRequiredMessage } from '@/lib/useEffectiveAddress';
import { usePayrollSync } from '@/lib/usePayrollSync';
import { useCloneAccess } from '@/lib/useCloneAccess';
import { trackClientEvent } from '@/lib/analyticsClient';
import { waitForSuccessfulReceipt } from '@/lib/txReceipt';
import { copyToClipboard } from '@/lib/clipboard';
import { useUniversalWrite } from '@/lib/circle/useUniversalWrite';
import { MEMO_ABI, MEMO_CONTRACT_ADDRESS } from '@/lib/contracts/abis';
import { Button }         from '@/components/shared/Button';
import { PaymentModal, type PaymentModalParams } from '@/components/dashboard/PaymentModal';
import { ExecutionModal, type ExecutionState }   from '@/components/dashboard/ExecutionModal';
import { LoginModal }     from '@/components/auth/LoginModal';
import {
  AddEmployeesIllustration,
} from '@/components/shared/Illustrations';
import Image from 'next/image';
import {
  validateEmployee,
  findDuplicateWallets,
  validateEmployeeFile,
  normalizeEmployeeRows,
  truncAddr,
} from '@/lib/validation';
import type { Employee } from '@/context/AppContext';
import type { TokenEntry } from '@/lib/token-registry';
import {
  ENTERPRISE_PAYROLL_ABI,
  MULTI_TOKEN_PAYROLL_ABI,
  REGISTRY_FACTORY_ABI,
  REGISTRY_ABI,
  ERC20_ABI,
} from '@/lib/contracts/abis';
import { CONTRACTS } from '@/lib/contracts/config';

// ── papaparse ─────────────────────────────────────────────────────────────────
async function parseCsv(file: File): Promise<Record<string, unknown>[]> {
  const Papa = (await import('papaparse')).default;
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: r  => resolve(r.data as Record<string, unknown>[]),
      error:   err => reject(err),
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile Setup Modal — first onboarding step: collect profile info, then
// deploy the user's personal registry clone (gas paid in USDC).
// ─────────────────────────────────────────────────────────────────────────────

const EMPLOYEE_RANGES = ['2-500', '501-1000', '1001-5000', '5001-10000'];

function ProfileSetupModal({ onClose, onComplete }: { onClose: () => void; onComplete: () => void }) {
  const { dispatch } = useApp();
  const { address, loginMethod } = useEffectiveAddress();
  const publicClient           = usePublicClient();
  const { writeContract, canWrite } = useUniversalWrite();

  const [fullName,    setFullName]    = useState('');
  const [companyName, setCompanyName] = useState('');
  const [email,       setEmail]       = useState('');
  const [empRange,    setEmpRange]    = useState('');
  const [errors,      setErrors]      = useState<string[]>([]);
  const [submitting,  setSubmitting]  = useState(false);
  const [submitStatus, setSubmitStatus] = useState('');

  useEffect(() => {
    try {
      const s = localStorage.getItem('salden_session');
      if (s) { const p = JSON.parse(s) as { email?: string }; if (p?.email) setEmail(p.email); }
    } catch { /* ignore */ }
  }, []);

  const inp: React.CSSProperties = {
    width: '100%', padding: '10px 14px', border: '1.5px solid #E2E8F0',
    borderRadius: 10, fontFamily: 'inherit', fontSize: 14, color: '#0F172A',
    background: '#fff', outline: 'none',
  };
  const label: React.CSSProperties = {
    display: 'block', fontSize: 12, fontWeight: 600, color: '#475569',
    marginBottom: 6, textTransform: 'uppercase' as const, letterSpacing: '0.05em',
  };

  async function handleSubmit() {
    const errs: string[] = [];
    if (!fullName.trim()) errs.push('Full name is required.');
    if (!companyName.trim()) errs.push('Company / organization name is required.');
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.push('A valid email is required.');
    if (!empRange) errs.push('Please select how many employees or recipients you plan to pay.');
    if (errs.length) { setErrors(errs); return; }
    if (!canWrite || !publicClient || !address) { setErrors([walletRequiredMessage(loginMethod)]); return; }

    setSubmitting(true); setErrors([]);
    try {
      const hash = await writeContract({
        address:      CONTRACTS.REGISTRY_FACTORY,
        abi:          REGISTRY_FACTORY_ABI,
        functionName: 'createRegistry',
        args:         [],
      }, msg => setSubmitStatus(msg));
      await waitForSuccessfulReceipt(publicClient, hash);
      const clone = await publicClient.readContract({
        address:      CONTRACTS.REGISTRY_FACTORY,
        abi:          REGISTRY_FACTORY_ABI,
        functionName: 'getRegistry',
        args:         [address as `0x${string}`],
      }) as `0x${string}`;
      dispatch({ type: 'SET_REGISTRY', payload: clone });
      dispatch({ type: 'SET_PAYROLL_DATA', payload: {
        payrollSetup: { fullName, companyName, email, employeeRange: empRange, registryClone: clone },
      } });
      trackClientEvent({ event: 'user_registered', walletAddress: address, txHash: hash });
      onComplete();
    } catch (err) {
      setErrors([(err as Error).message ?? 'Transaction failed. Please try again.']);
    } finally { setSubmitting(false); setSubmitStatus(''); }
  }

  return (
    <Modal open onClose={onClose} title="Finish Your Profile" maxWidth={460}>
      <div style={{ marginBottom: 14 }}>
        <label style={label}>Full Name <span style={{ color: '#DC2626' }}>*</span></label>
        <input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Jane Doe" style={inp}
          onFocus={e => (e.target.style.borderColor = '#4F46E5')} onBlur={e => (e.target.style.borderColor = '#E2E8F0')} />
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={label}>Company / Organization Name <span style={{ color: '#DC2626' }}>*</span></label>
        <input value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Acme Inc." style={inp}
          onFocus={e => (e.target.style.borderColor = '#4F46E5')} onBlur={e => (e.target.style.borderColor = '#E2E8F0')} />
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={label}>Email <span style={{ color: '#DC2626' }}>*</span></label>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" style={inp}
          onFocus={e => (e.target.style.borderColor = '#4F46E5')} onBlur={e => (e.target.style.borderColor = '#E2E8F0')} />
      </div>
      <div style={{ marginBottom: 18 }}>
        <label style={label}>How many employees / recipients? <span style={{ color: '#DC2626' }}>*</span></label>
        <select value={empRange} onChange={e => setEmpRange(e.target.value)} style={{ ...inp, cursor: 'pointer' }}
          onFocus={e => (e.target.style.borderColor = '#4F46E5')} onBlur={e => (e.target.style.borderColor = '#E2E8F0')}>
          <option value="">Select a range</option>
          {EMPLOYEE_RANGES.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>

      {errors.length > 0 && (
        <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 10, background: '#FEF2F2', border: '1px solid #FECACA' }}>
          {errors.map((e, i) => <p key={i} style={{ fontSize: 12.5, color: '#DC2626', margin: 0 }}>{e}</p>)}
        </div>
      )}

      <button onClick={handleSubmit} disabled={submitting}
        style={{ width: '100%', padding: '13px 16px', borderRadius: 10, border: 'none', background: '#14B8A6', color: '#fff', fontSize: 15, fontWeight: 700, cursor: submitting ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontFamily: 'inherit' }}>
        {submitting ? <><Loader2 size={15} style={{ animation: 'spin 0.7s linear infinite' }} /> {submitStatus || 'Deploying your contract…'}</> : 'Complete Setup'}
      </button>
      <p style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 10, textAlign: 'center', lineHeight: 1.5 }}>
        This deploys your own private registry contract Onchain. A small USDC gas fee applies.
      </p>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Employee Modal — defined at MODULE LEVEL to prevent remount on parent render
// ─────────────────────────────────────────────────────────────────────────────

interface EmployeeModalProps {
  mode:       'add' | 'edit';
  employee?:  Employee;
  rowIndex?:  number;
  groups:     string[];
  onSave:     (data: Employee, idx?: number) => Promise<void>;
  onSaveBulk?: (data: Employee[]) => Promise<void>;
  onClose:    () => void;
  /** Onboarding mode: modal stays open after each save and shows a running
   *  count + "Proceed to Dashboard" button once `minRequired` is reached. */
  setupMode?:    boolean;
  minRequired?:  number;
}

function EmployeeModal({
  mode, employee, rowIndex, groups, onSave, onSaveBulk, onClose,
  setupMode = false, minRequired = 2,
}: EmployeeModalProps) {
  const { dispatch, state, syncData } = useApp();
  const { address }            = useEffectiveAddress();
  const publicClient           = usePublicClient();
  const { writeContract: universalWrite, signMessage: universalSignMessage, canWrite } = useUniversalWrite();

  const [tab,           setTab]           = useState<'single' | 'bulk'>('single');
  const [form,          setForm]          = useState<Employee>({
    fullName:      employee?.fullName      ?? '',
    department:    employee?.department    ?? '',
    walletAddress: employee?.walletAddress ?? '',
    salaryAmount:  employee?.salaryAmount  ?? 0,
    group:         employee?.group         ?? '',
  });
  const [errors,        setErrors]        = useState<string[]>([]);
  const [saving,        setSaving]        = useState(false);
  const [bulkEmployees, setBulkEmployees] = useState<Employee[]>([]);
  const [fileError,     setFileError]     = useState('');
  const [importing,     setImporting]     = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [showNewGroup,  setShowNewGroup]  = useState(false);
  const [newGroupName,  setNewGroupName]  = useState('');

  const [proceeding,    setProceeding]    = useState(false);
  const [proceedError,  setProceedError]  = useState('');

  const employeeCount = state.employees.length;
  const setupDone     = employeeCount >= minRequired;

  async function handleProceed() {
    if (!canWrite || !publicClient || !state.registryClone || !address) return;
    setProceeding(true); setProceedError('');
    try {
      const sign = (msg: string) => universalSignMessage(msg);
      const { cid } = await syncData({ employees: state.employees, walletAddress: address, signMessage: sign });
      if (cid) {
        const hash = await universalWrite({
          address:      state.registryClone as `0x${string}`,
          abi:          REGISTRY_ABI,
          functionName: 'updateCID',
          args:         [cid],
        });
        await waitForSuccessfulReceipt(publicClient, hash);
      }
      onClose();
    } catch (err) {
      setProceedError((err as Error).message ?? 'Failed to finalize setup');
    } finally { setProceeding(false); }
  }

  function commitNewGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    dispatch({ type: 'SET_GROUPS', payload: [...groups, name] });
    setForm(p => ({ ...p, group: name }));
    setShowNewGroup(false);
    setNewGroupName('');
  }

  async function handleSave() {
    const errs: string[] = [];
    const result = validateEmployee({ ...form, salaryAmount: Number(form.salaryAmount) });
    if (!result.valid) errs.push(...result.errors);
    if (!form.group) errs.push('Group is required — select or create a group.');
    if (errs.length) { setErrors(errs); return; }
    setSaving(true);
    try {
      await onSave({ ...form, salaryAmount: Number(form.salaryAmount) }, rowIndex);
      if (setupMode) {
        setForm({ fullName: '', department: '', walletAddress: '', salaryAmount: 0, group: form.group });
      } else {
        onClose();
      }
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally { setSaving(false); }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setFileError(''); setBulkEmployees([]);
    const file = e.target.files?.[0];
    if (!file) return;
    const vr = validateEmployeeFile(file);
    if (!vr.valid) { setFileError(vr.error ?? 'Invalid file'); return; }
    try {
      let rows: Record<string, unknown>[] = [];
      if (vr.type === 'csv') {
        rows = await parseCsv(file);
      } else {
        const text   = await file.text();
        const parsed = JSON.parse(text) as unknown;
        rows = Array.isArray(parsed) ? parsed as Record<string, unknown>[] : ((parsed as Record<string, unknown>).employees as Record<string, unknown>[]) ?? [];
      }
      const normalized = normalizeEmployeeRows(rows);
      const valid      = normalized.filter(emp => validateEmployee(emp).valid);
      if (!valid.length) { setFileError('No valid records found. Required columns: FullName, Department, Wallet Address, Salary Amount.'); return; }
      setBulkEmployees(valid);
    } catch { setFileError('Failed to parse file.'); }
  }

  async function handleBulkImport() {
    if (!bulkEmployees.length || !onSaveBulk) return;
    if (!form.group) { setFileError('Group is required before importing.'); return; }
    const withGroup = bulkEmployees.map(e => ({ ...e, group: form.group }));
    setImporting(true);
    try {
      await onSaveBulk(withGroup);
      setBulkEmployees([]);
      if (fileRef.current) fileRef.current.value = '';
      if (!setupMode) onClose();
    }
    catch (err) { setFileError((err as Error).message); }
    finally { setImporting(false); }
  }

  const inp: React.CSSProperties = {
    width: '100%', padding: '10px 14px', border: '1.5px solid #E2E8F0',
    borderRadius: 10, fontFamily: 'inherit', fontSize: 14, color: '#0F172A',
    background: '#fff', outline: 'none',
  };

  // Shared top section: setup progress (onboarding) + group selector
  const sharedTop = (
    <>
      {setupMode && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: setupDone ? '#059669' : '#475569' }}>
              {setupDone ? 'Minimum reached — you can proceed' : `${employeeCount} of ${minRequired} employees added`}
            </span>
            {setupDone && <CheckCircle2 size={16} color="#059669" />}
          </div>
          <div style={{ height: 6, borderRadius: 4, background: '#F1F5F9', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.min(100, (employeeCount / minRequired) * 100)}%`, background: setupDone ? '#059669' : '#4F46E5', transition: 'width 0.2s' }} />
          </div>
        </div>
      )}

      <hr style={{ border: 'none', borderTop: '1px solid #F1F5F9', margin: '0 0 18px' }} />

      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 6, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>
          Group <span style={{ color: '#DC2626' }}>*</span>
        </label>
        {!showNewGroup ? (
          <select value={form.group ?? ''} onChange={e => { if (e.target.value === '__add__') setShowNewGroup(true); else setForm(p => ({ ...p, group: e.target.value })); }}
            style={{ ...inp, cursor: 'pointer' }}
            onFocus={e => (e.target.style.borderColor = '#4F46E5')}
            onBlur={e => (e.target.style.borderColor = '#E2E8F0')}>
            <option value="">Select Group (required)</option>
            {groups.map(g => <option key={g} value={g}>{g}</option>)}
            <option value="__add__">+ Add New Group</option>
          </select>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <input autoFocus placeholder="e.g Remote Employees" value={newGroupName}
              onChange={e => setNewGroupName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commitNewGroup(); if (e.key === 'Escape') { setShowNewGroup(false); setNewGroupName(''); } }}
              style={{ ...inp, flex: 1 }}
              onFocus={e => (e.target.style.borderColor = '#4F46E5')}
              onBlur={e => (e.target.style.borderColor = '#E2E8F0')} />
            <button onClick={commitNewGroup} style={{ padding: '10px 14px', borderRadius: 10, background: '#14B8A6', color: '#fff', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>Add</button>
            <button onClick={() => { setShowNewGroup(false); setNewGroupName(''); }} style={{ padding: '10px 12px', borderRadius: 10, background: '#F8F9FA', color: '#64748B', border: '1px solid #E2E8F0', cursor: 'pointer' }}>✕</button>
          </div>
        )}
      </div>
    </>
  );

  // Proceed-to-dashboard action — rendered at the BOTTOM of the modal
  // (below the form/import controls), away from the progress indicator
  // above, per the redesign.
  const proceedSection = setupMode && setupDone && (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #F1F5F9' }}>
      <button onClick={handleProceed} disabled={proceeding}
        style={{ width: '100%', padding: '12px 16px', borderRadius: 10, border: 'none', background: '#059669', color: '#fff', fontSize: 14, fontWeight: 700, cursor: proceeding ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontFamily: 'inherit' }}>
        {proceeding ? <><Loader2 size={14} style={{ animation: 'spin 0.7s linear infinite' }} /> Syncing & finalizing…</> : 'Proceed to Dashboard'}
      </button>
      {proceedError && <p style={{ fontSize: 12, color: '#DC2626', marginTop: 6 }}>{proceedError}</p>}
      <p style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 6, lineHeight: 1.5 }}>
        You can keep adding employees above, or proceed now — this syncs your employee data and anchors it Onchain.
      </p>
    </div>
  );

  return (
    <Modal open onClose={onClose} title={mode === 'add' ? 'Set Up Employees Data' : 'Edit Employee'} maxWidth={500}>
      {mode === 'add' && (
        <div style={{ display: 'flex', borderBottom: '1px solid #E2E8F0', marginBottom: 20 }}>
          {(['single', 'bulk'] as const).map(t => (
            <button key={t} onClick={() => { setTab(t); setErrors([]); setFileError(''); }}
              style={{ flex: 1, padding: '10px 0', fontSize: 13, fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', color: tab === t ? '#14B8A6' : '#64748B', borderBottom: tab === t ? '2px solid #14B8A6' : '2px solid transparent', fontFamily: 'inherit' }}>
              {t === 'single' ? 'Single Entry' : 'Bulk Import (CSV / JSON)'}
            </button>
          ))}
        </div>
      )}

      {(mode === 'edit' || tab === 'single') && (
        <>
          {sharedTop}
          {errors.length > 0 && (
            <div style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 10, padding: '10px 14px', marginBottom: 14 }}>
              {errors.map((e, i) => (
                <p key={i} style={{ fontSize: 13, color: '#DC2626', display: 'flex', alignItems: 'center', gap: 6, margin: i > 0 ? '4px 0 0' : 0 }}>
                  <AlertTriangle size={12} /> {e}
                </p>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[
              { field: 'fullName',      label: 'Full Name',             type: 'text',   mono: false },
              { field: 'department',    label: 'Department',            type: 'text',   mono: false },
              { field: 'walletAddress', label: 'Wallet Address (0x…)',  type: 'text',   mono: true  },
              { field: 'salaryAmount',  label: 'Salary Amount (USDC)',  type: 'number', mono: false },
            ].map(({ field, label, type, mono }) => (
              <input key={field} type={type} placeholder={label}
                value={String(form[field as keyof Employee] ?? '')}
                onChange={e => { setForm(p => ({ ...p, [field]: e.target.value })); setErrors([]); }}
                maxLength={field === 'walletAddress' ? 42 : 200}
                min={type === 'number' ? 0 : undefined}
                step={type === 'number' ? '0.01' : undefined}
                style={{ ...inp, fontFamily: mono ? "'JetBrains Mono', monospace" : 'inherit' }}
                onFocus={e => (e.target.style.borderColor = '#4F46E5')}
                onBlur={e => (e.target.style.borderColor = '#E2E8F0')} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button onClick={onClose} style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: '1.5px solid #E2E8F0', background: 'transparent', fontSize: 14, fontWeight: 500, cursor: 'pointer', color: '#475569', fontFamily: 'inherit' }}>Cancel</button>
            <Button variant="brand" loading={saving} onClick={handleSave} style={{ flex: 1 }}>
              {mode === 'add' ? 'Add Employee' : 'Save Changes'}
            </Button>
          </div>
          {proceedSection}
        </>
      )}

      {mode === 'add' && tab === 'bulk' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {sharedTop}
          <div style={{ background: '#EEF2FF', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: '#4F46E5' }}>
            <FileText size={12} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />
            Required columns: <strong>FullName</strong>, <strong>Department</strong>, <strong>Wallet Address</strong>, <strong>Salary Amount</strong>
          </div>
          <div onClick={() => fileRef.current?.click()}
            style={{ border: '2px dashed #E2E8F0', borderRadius: 12, padding: '32px 20px', textAlign: 'center', cursor: 'pointer' }}
            onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor = '#4F46E5'; (e.currentTarget as HTMLDivElement).style.background = '#EEF2FF'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = '#E2E8F0'; (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}>
            <Upload size={22} color="#94A3B8" style={{ margin: '0 auto 8px' }} />
            <p style={{ fontSize: 14, color: '#475569' }}>Click to upload CSV or JSON</p>
            <p style={{ fontSize: 12, color: '#94A3B8', marginTop: 4 }}>Max 5 MB</p>
            {bulkEmployees.length > 0 && <p style={{ fontSize: 13, color: '#059669', fontWeight: 600, marginTop: 8 }}>{bulkEmployees.length} records ready</p>}
          </div>
          <input ref={fileRef} type="file" accept=".csv,.json" onChange={handleFileChange} style={{ display: 'none' }} />
          {fileError && <p style={{ fontSize: 13, color: '#DC2626', display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}><AlertTriangle size={13} /> {fileError}</p>}
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onClose} style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: '1.5px solid #E2E8F0', background: 'transparent', fontSize: 14, fontWeight: 500, cursor: 'pointer', color: '#475569', fontFamily: 'inherit' }}>Cancel</button>
            <Button variant="brand" loading={importing} disabled={!bulkEmployees.length} onClick={handleBulkImport} style={{ flex: 1 }}>
              Import {bulkEmployees.length > 0 ? `${bulkEmployees.length} Employees` : 'Employees'}
            </Button>
          </div>
          {proceedSection}
        </div>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </Modal>
  );
}

// ── Delete confirmation ───────────────────────────────────────────────────────

function DeleteModal({ employee, onConfirm, onClose }: { employee?: Employee; onConfirm: () => Promise<void>; onClose: () => void }) {
  const [deleting, setDeleting] = useState(false);
  async function handle() { setDeleting(true); try { await onConfirm(); onClose(); } finally { setDeleting(false); } }
  return (
    <Modal open onClose={onClose} maxWidth={380}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ width: 52, height: 52, borderRadius: 16, background: '#FEF2F2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
          <Trash2 size={22} color="#DC2626" />
        </div>
        <h3 style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', marginBottom: 8 }}>Delete Employee?</h3>
        <p style={{ fontSize: 14, color: '#64748B', marginBottom: 24, lineHeight: 1.6 }}>
          This permanently removes <strong style={{ color: '#0F172A' }}>{employee?.fullName}</strong> from payroll.
        </p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: '1.5px solid #E2E8F0', background: 'transparent', fontSize: 14, fontWeight: 500, cursor: 'pointer', color: '#475569', fontFamily: 'inherit' }}>No, Keep</button>
          <Button variant="danger" loading={deleting} onClick={handle} style={{ flex: 1 }}>Yes, Delete</Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon: React.ReactNode }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, padding: '20px 22px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: '#EEF2FF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</div>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#64748B', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>{label}</span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, color: '#0F172A' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main dashboard
// ─────────────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { state, dispatch, addToast, syncData, saveTxRecord } = useApp();
  // useEffectiveAddress resolves wagmi OR Circle session — fixes social login redirect loop
  const { address, isConnected: isLoggedIn, mounted: authMounted, loginMethod } = useEffectiveAddress();
  const publicClient              = usePublicClient();
  const { writeContract: universalWrite, signMessage: universalSignMessage, canWrite } = useUniversalWrite();

  const {
    employees, groups, activeGroup,
    payrollSetup, payrollClone, registryClone, isPremiumUser,
  } = state;

  // ── Login state ────────────────────────────────────────────────────────────
  const [loginOpen,        setLoginOpen]        = useState(false);
  const [showBalance,      setShowBalance]      = useState(false);
  const [copied,           setCopied]           = useState(false);

  // ── Onboarding: does the user already have a registry clone? ──────────────
  const [registryStatus, setRegistryStatus] = useState<'checking' | 'none' | 'exists'>('checking');
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  // ── Restoring previously-synced employee data from IPFS (via on-chain CID).
  // Centralised in usePayrollSync so /ai-agent gets the same instant-cache +
  // staleness-detection behaviour instead of this page being the only place
  // that ever restored data. (/transaction-history doesn't use employee/
  // registry data at all — it reads local tx records directly — so it
  // doesn't need this hook.)
  const payrollSync = usePayrollSync({
    registryClone: registryStatus === 'exists' ? registryClone : null,
    address,
    publicClient,
  });
  const dataLoadStatus = payrollSync.status;

  useEffect(() => {
    // Wait until localStorage has been read before making auth decisions.
    // Without this guard, the hook returns isLoggedIn=false for one frame
    // during hydration, causing the registry check to reset unnecessarily.
    if (!authMounted) return;
    if (!isLoggedIn || !address || !publicClient) { setRegistryStatus('checking'); return; }
    let cancelled = false;
    (async () => {
      try {
        const existing = await publicClient.readContract({
          address:      CONTRACTS.REGISTRY_FACTORY,
          abi:          REGISTRY_FACTORY_ABI,
          functionName: 'getRegistry',
          args:         [address as `0x${string}`],
        }) as `0x${string}`;
        if (cancelled) return;
        const ZERO = '0x0000000000000000000000000000000000000000';
        if (existing && existing.toLowerCase() !== ZERO) {
          dispatch({ type: 'SET_REGISTRY', payload: existing });
          setRegistryStatus('exists');
        } else {
          setRegistryStatus('none');
        }
      } catch {
        if (!cancelled) setRegistryStatus('none');
      }
    })();
    return () => { cancelled = true; };
  }, [authMounted, isLoggedIn, address, publicClient, dispatch]);

  // Self-healing fallback for payrollClone — single shared implementation,
  // see lib/useCloneAccess.ts for the full writeup (previously duplicated
  // inline here and in ai-agent/page.tsx; consolidated into one hook).
  useCloneAccess();

  // ── USDC balance ───────────────────────────────────────────────────────────
  // Arc Testnet uses USDC as its native gas token: native balance reads (this
  // hook) report it with 18 decimals, while the ERC-20 interface contract
  // (CONTRACTS.USDC) reports the same balance with 6 decimals. For on-screen
  // *display* we always use the native/18-decimal reading; the ERC-20
  // interface is reserved for actual contract calls (transfers, approvals).
  const { data: nativeBalance } = useBalance({
    address,
    query: { enabled: !!address },
  });
  const balanceStr = nativeBalance
    ? Number(nativeBalance.formatted).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '0.00';

  async function handleCopyAddress() {
    if (!address) return;
    const ok = await copyToClipboard(address);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      addToast('Could not copy — press and hold the address to copy it manually.', 'error', 3000);
    }
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  const [searchQuery,    setSearchQuery]    = useState('');
  const [searchResults,  setSearchResults]  = useState<{ emp: Employee; idx: number }[]>([]);
  const [showDropdown,   setShowDropdown]   = useState(false);
  const [highlightedRow, setHighlightedRow] = useState<number | null>(null);
  const rowRefs   = useRef<Record<number, HTMLTableRowElement | null>>({});
  const searchRef = useRef<HTMLDivElement>(null);
  // Latest CID we've successfully anchored Onchain — lets anchorCid skip a
  // redundant transaction if the data hasn't actually changed since.
  // (IPFS "previousCid" bookkeeping for Pinata cleanup is handled centrally
  // by AppContext's syncData/loadData — no need to duplicate it here.)
  const lastAnchoredCidRef = useRef<string | null>(null);

  // usePayrollSync may hydrate/load a CID before the user ever calls
  // anchorCid this session (from local cache or an on-chain restore) — seed
  // the dedup ref from it so the first real anchorCid() call can still skip
  // a redundant transaction when nothing has actually changed.
  useEffect(() => {
    if (payrollSync.currentCid) lastAnchoredCidRef.current = payrollSync.currentCid;
  }, [payrollSync.currentCid]);

  // ── Modal state ────────────────────────────────────────────────────────────
  const [employeeModal,    setEmployeeModal]    = useState<{ mode: 'add' | 'edit'; employee?: Employee; rowIndex?: number; setupMode?: boolean } | null>(null);
  const [deleteModal,      setDeleteModal]      = useState<number | null>(null);
  const [contextMenu,      setContextMenu]      = useState<{ x: number; y: number; rowIndex: number } | null>(null);
  const [groupMenuOpen,    setGroupMenuOpen]    = useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (longPress.current) clearTimeout(longPress.current); }, []);

  // Deep-link support: the AI agent's "Go to Dashboard" link (PayrollRunCard)
  // sends the user to /dashboard?group=<name> promising the group will be
  // pre-selected. Previously nothing on this page read that query param, so
  // the link silently did nothing beyond a plain navigation. Runs once on
  // mount, after `groups` is populated, and only applies if the group named
  // in the URL still exists (a stale/bookmarked link with a deleted group
  // should not crash — it should just fall back to "All Employees").
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('group');
    if (!requested) return;
    const decoded = decodeURIComponent(requested);
    if (groups.includes(decoded) && decoded !== activeGroup) {
      dispatch({ type: 'SET_ACTIVE_GROUP', payload: decoded });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  // ── Execution ──────────────────────────────────────────────────────────────
  const [isExecuting,     setIsExecuting]     = useState(false);
  const [executeStatus,   setExecuteStatus]   = useState('');
  const [executeProgress, setExecuteProgress] = useState<{ current: number; total: number } | null>(null);
  const [executionState,  setExecutionState]  = useState<ExecutionState>('idle');
  const [executeError,    setExecuteError]    = useState('');
  const [execTxHash,      setExecTxHash]      = useState('');

  // ── Derived ────────────────────────────────────────────────────────────────
  const filteredEmployees = useMemo(() =>
    activeGroup === 'All Employees' ? employees : employees.filter(e => e.group === activeGroup),
    [employees, activeGroup]);

  const totalPayroll = useMemo(() =>
    filteredEmployees.reduce((s, e) => s + Number(e.salaryAmount || 0), 0),
    [filteredEmployees]);

  // ── Search logic ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); setShowDropdown(false); return; }
    const q = searchQuery.toLowerCase();
    const r = employees.map((emp, idx) => ({ emp, idx }))
      .filter(({ emp }) => emp.fullName?.toLowerCase().includes(q) || emp.department?.toLowerCase().includes(q))
      .slice(0, 8);
    setSearchResults(r); setShowDropdown(r.length > 0);
  }, [searchQuery, employees]);

  const handleSearchSelect = useCallback((idx: number) => {
    setSearchQuery(''); setShowDropdown(false); setHighlightedRow(idx);
    setTimeout(() => rowRefs.current[idx]?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    setTimeout(() => setHighlightedRow(null), 2500);
  }, []);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (searchRef.current && !searchRef.current.contains(e.target as Node)) setShowDropdown(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  // ── Context menu ───────────────────────────────────────────────────────────
  const handleRowPointerDown = (e: React.PointerEvent, i: number) => { longPress.current = setTimeout(() => setContextMenu({ x: e.clientX, y: e.clientY, rowIndex: i }), 600); };
  const handleRowPointerUp = () => { if (longPress.current) clearTimeout(longPress.current); };

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  // ── CRUD ───────────────────────────────────────────────────────────────────
  //
  // The sign function derives the encryption key that secures employee data.
  // It routes through useUniversalWrite's signMessage — wagmi's popup for an
  // external wallet, or a Circle SIGN_MESSAGE PIN challenge for Google/email
  // social login — exactly ONCE per browser session per (address + message)
  // pair.
  //
  // We cache the result in sessionStorage so page refreshes don't re-prompt
  // the wallet. sessionStorage clears automatically when the tab closes,
  // so the key is never persisted to disk between sessions.
  const sign = useCallback(async (msg: string): Promise<string> => {
    if (!canWrite || !address) throw new Error('No wallet');

    const storageKey = `salden_sig::${address.toLowerCase()}::${btoa(msg).slice(0, 32)}`;

    try {
      const cached = sessionStorage.getItem(storageKey);
      if (cached) return cached;
    } catch { /* sessionStorage blocked (private browsing edge cases) */ }

    // Not cached — prompt for a signature once (wagmi popup for external
    // wallets, Circle's PIN challenge for Google/email social login)
    const sig = await universalSignMessage(msg);

    try { sessionStorage.setItem(storageKey, sig); } catch { /* ignore write errors */ }

    return sig;
  }, [canWrite, universalSignMessage, address]);

  /**
   * Anchors a freshly-synced IPFS CID Onchain (SaldenRegistry.updateCID).
   * Without this, the registry's on-chain pointer would only ever reflect
   * whatever was anchored during initial onboarding — every edit afterward
   * would update IPFS but silently leave the Onchain record stale, so a
   * reload (or another device) would load outdated data.
   */
  const anchorCid = useCallback(async (cid?: string) => {
    if (!cid || cid === lastAnchoredCidRef.current) return;
    if (!registryClone || !canWrite || !publicClient) return;
    try {
      const hash = await universalWrite({
        address:      registryClone as `0x${string}`,
        abi:          REGISTRY_ABI,
        functionName: 'updateCID',
        args:         [cid],
      });
      await waitForSuccessfulReceipt(publicClient, hash);
      lastAnchoredCidRef.current = cid;
    } catch (err) {
      console.error('[Dashboard] Failed to anchor CID Onchain:', err);
      addToast('Saved, but the Onchain record could not be updated. Retry from Settings → Sync Data if this keeps happening.', 'warning');
    }
  }, [registryClone, canWrite, universalWrite, publicClient, addToast]);

  // ── Restore previously-synced data ──────────────────────────────────────────
  // Handled by usePayrollSync (called above) — see that hook for the full
  // sequence (instant local-cache paint, cheap on-chain hash check, silent
  // load vs. syncAvailable prompt). Previously this logic lived only here,
  // duplicated per-page and with no local cache or staleness detection.

  const handleAddEmployee = useCallback(async (data: Employee) => {
    const next = [...employees, data];
    dispatch({ type: 'SET_EMPLOYEES', payload: next });
    try {
      const { cid } = await syncData({ employees: next, walletAddress: address ?? '', signMessage: sign });
      addToast('Employee added.', 'success');
      await anchorCid(cid);
    }
    catch { addToast('Saved locally — sync failed.', 'warning'); }
  }, [employees, dispatch, syncData, addToast, address, sign, anchorCid]);

  const handleAddBulk = useCallback(async (data: Employee[]) => {
    const next = [...employees, ...data];
    dispatch({ type: 'SET_EMPLOYEES', payload: next });
    try {
      const { cid } = await syncData({ employees: next, walletAddress: address ?? '', signMessage: sign });
      addToast(`${data.length} employees imported.`, 'success');
      await anchorCid(cid);
    }
    catch { addToast('Saved locally — sync failed.', 'warning'); }
  }, [employees, dispatch, syncData, addToast, address, sign, anchorCid]);

  const handleEditEmployee = useCallback(async (data: Employee, rowIndex?: number) => {
    if (rowIndex === undefined) return;
    const next = employees.map((e, i) => i === rowIndex ? { ...e, ...data } : e);
    dispatch({ type: 'SET_EMPLOYEES', payload: next });
    try {
      const { cid } = await syncData({ employees: next, walletAddress: address ?? '', signMessage: sign });
      addToast('Employee updated.', 'success');
      await anchorCid(cid);
    }
    catch { addToast('Saved locally — sync failed.', 'warning'); }
  }, [employees, dispatch, syncData, addToast, address, sign, anchorCid]);

  const handleDeleteEmployee = useCallback(async (rowIndex: number) => {
    const next = employees.filter((_, i) => i !== rowIndex);
    dispatch({ type: 'SET_EMPLOYEES', payload: next });
    try {
      const { cid } = await syncData({ employees: next, walletAddress: address ?? '', signMessage: sign });
      addToast('Employee removed.', 'success');
      await anchorCid(cid);
    }
    catch { addToast('Saved locally — sync failed.', 'warning'); }
  }, [employees, dispatch, syncData, addToast, address, sign, anchorCid]);

  // ── Execute payroll (audit fix: uses static imports only — no dynamic re-imports) ──
  const handleExecutePayroll = useCallback(async (
    overrideToken: TokenEntry | null,
    overrideGroup?: string,
    remark = 'Salary Payment',
  ) => {
    if (!address) { addToast('Connect your wallet to process payroll.', 'error'); return; }

    const resolvedGroup    = overrideGroup ?? activeGroup;
    const targetEmployees  = resolvedGroup === 'All Employees' ? employees : employees.filter(e => e.group === resolvedGroup);
    if (!targetEmployees.length) { addToast(resolvedGroup === 'All Employees' ? 'No employees to pay.' : `No employees in "${resolvedGroup}".`, 'warning'); return; }

    const dups = findDuplicateWallets(targetEmployees);
    if (dups.length) { addToast(`Duplicate wallet addresses on rows ${dups.map(d => d.rows.join(', ')).join(' | ')}. Resolve before processing.`, 'error', 8000); return; }

    const tokenAddr   = (overrideToken?.address ?? CONTRACTS.USDC) as `0x${string}`;
    const tokenSymbol = overrideToken?.symbol   ?? 'USDC';
    const tokenDec    = overrideToken?.decimals  ?? 6;
    const tokenScale  = 10 ** tokenDec;
    const contractAddr = (payrollClone ? payrollClone : CONTRACTS.ENTERPRISE_PAYROLL) as `0x${string}`;
    const addrs        = targetEmployees.map(e => e.walletAddress as `0x${string}`);
    const amounts      = targetEmployees.map(e => BigInt(Math.round(Number(e.salaryAmount) * tokenScale)));
    const totalAmount  = amounts.reduce((a, b) => a + b, 0n);

    if (!canWrite || !publicClient) { addToast(walletRequiredMessage(loginMethod), 'error'); return; }

    setIsExecuting(true);
    setExecutionState('pending');
    setExecuteError('');
    setExecTxHash('');
    setExecuteStatus('Preparing payroll execution…');
    try {
      setExecuteStatus(`Checking ${tokenSymbol} allowance…`);
      setExecuteProgress({ current: 0, total: targetEmployees.length });

      const allowance = await publicClient.readContract({
        address: tokenAddr, abi: ERC20_ABI, functionName: 'allowance',
        args: [address as `0x${string}`, contractAddr],
      }) as bigint;

      if (allowance < totalAmount) {
        setExecuteStatus(`Approving ${tokenSymbol} transfer…`);
        const approveTx = await universalWrite({
          address: tokenAddr, abi: ERC20_ABI, functionName: 'approve',
          args: [contractAddr, totalAmount],
        }, setExecuteStatus);
        setExecuteStatus('Waiting for approval confirmation…');
        await waitForSuccessfulReceipt(publicClient, approveTx);
      }

      setExecuteStatus('Executing batch payment…');
      let txHash: `0x${string}`;

      // Build structured Arc Memo JSON (ImportantUpdate #8).
      // Arc Memo contract preserves msg.sender so the payroll clone sees the
      // original wallet address, not the Memo contract. No contract changes needed.
      const ref     = 'SLD-' + Math.random().toString(36).slice(2, 8).toUpperCase();
      const memoJson = JSON.stringify({
        protocol: 'salden', type: 'batchPay', ref,
        date: new Date().toISOString(),
        remark, token: tokenSymbol,
        totalAmount: (Number(totalAmount) / tokenScale).toFixed(2),
        recipients: targetEmployees.length,
        group: resolvedGroup, employer: address,
      });
      const memoHex = ('0x' + Array.from(new TextEncoder().encode(memoJson))
        .map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
      // The real Memo contract's memoId is a caller-chosen bytes32 (see
      // event `Memo`'s indexed memoId) — deriving it as a hash of the
      // memo content itself keeps it deterministic and collision-safe
      // without inventing a separate ID scheme.
      const memoId = keccak256(memoHex);

      // Encode batchPay calldata for the Memo contract to forward
      setExecuteStatus('Executing batch payment…');
      if (payrollClone) {
        const batchData = encodeFunctionData({
          abi: MULTI_TOKEN_PAYROLL_ABI, functionName: 'batchPay',
          args: [addrs, amounts, tokenAddr],
        });
        // Arc Memo contract: memo(target, data, memoId, memoData) — see
        // lib/contracts/abis.ts for why this isn't called callWithMemo.
        // msg.sender is preserved — payroll clone sees the user's wallet address
        txHash = await universalWrite({
          address: MEMO_CONTRACT_ADDRESS, abi: MEMO_ABI,
          functionName: 'memo',
          args: [contractAddr, batchData as `0x${string}`, memoId, memoHex],
        }, setExecuteStatus);
      } else {
        const batchData = encodeFunctionData({
          abi: ENTERPRISE_PAYROLL_ABI, functionName: 'batchPay',
          args: [addrs, amounts],
        });
        txHash = await universalWrite({
          address: MEMO_CONTRACT_ADDRESS, abi: MEMO_ABI,
          functionName: 'memo',
          args: [contractAddr, batchData as `0x${string}`, memoId, memoHex],
        }, setExecuteStatus);
      }

      setExecuteStatus('Confirming on-chain…');
      await waitForSuccessfulReceipt(publicClient, txHash);
      setExecuteProgress({ current: targetEmployees.length, total: targetEmployees.length });
      setExecTxHash(txHash);
      setExecutionState('success');

      const totalHuman = (Number(totalAmount) / tokenScale).toLocaleString('en-US', { minimumFractionDigits: 2 });
      await saveTxRecord({
        id: txHash, hash: txHash, ref,
        type: 'batchPay', status: 'success',
        amount: totalHuman, token: tokenSymbol,
        remark,
        recipientCount: targetEmployees.length,
        timestamp: Date.now(),
        invoiceEmailStatus: 'pending',  // set to pending before firing
        executedBy: 'manual',
      }, address);

      trackClientEvent({
        event: 'batch_paid', walletAddress: address, txHash,
        employeeCount: targetEmployees.length, volumeUsdc: Number(totalHuman.replace(/,/g, '')),
      });

      // Auto-send invoice email after batchPay (ImportantUpdate - automatic for batchPay only).
      // Fire-and-forget: payroll already succeeded, email failure is non-critical.
      // Uses the company email stored in payrollSetup.
      const invoiceEmail = payrollSetup?.email ?? null;
      if (invoiceEmail) {
        fetch('/api/invoice/send', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            txHash,
            walletAddress:  address,
            recipientEmail: invoiceEmail,
            recipientCount: targetEmployees.length,
            amount:         totalHuman,
            token:          tokenSymbol,
            remark,
            ref,
            timestamp:      Date.now(),
            executedBy:     'manual',
          }),
        }).then(async res => {
          const newStatus = res.ok ? 'sent' : 'failed';
          // Update the IndexedDB record with the actual send status
          await saveTxRecord({
            id: txHash, hash: txHash, ref,
            type: 'batchPay', status: 'success',
            amount: totalHuman, token: tokenSymbol,
            remark,
            recipientCount: targetEmployees.length,
            timestamp: Date.now(),
            invoiceEmailStatus: newStatus,
            executedBy: 'manual',
          }, address);
        }).catch(() => {
          // Invoice send failed — update status silently
          saveTxRecord({
            id: txHash, hash: txHash, ref,
            type: 'batchPay', status: 'success',
            amount: totalHuman, token: tokenSymbol,
            remark,
            recipientCount: targetEmployees.length,
            timestamp: Date.now(),
            invoiceEmailStatus: 'failed',
            executedBy: 'manual',
          }, address).catch(() => { /* ignore double failure */ });
        });
      }

      addToast(`Payroll complete — ${targetEmployees.length} employee${targetEmployees.length !== 1 ? 's' : ''} paid in ${tokenSymbol}.`, 'success', 6000);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      const friendly = /reject|cancel|denied/i.test(msg) ? 'Transaction cancelled.' : 'Payroll failed. Please try again.';
      setExecutionState('failed');
      setExecuteError(friendly);
    } finally {
      setIsExecuting(false); setExecuteStatus(''); setExecuteProgress(null);
    }
  }, [payrollClone, employees, activeGroup, canWrite, universalWrite, publicClient, address, addToast, saveTxRecord, payrollSetup, loginMethod]);

  const handleProcessPaymentClick = useCallback(() => {
    if (isPremiumUser && payrollClone) setPaymentModalOpen(true);
    else handleExecutePayroll(null);
  }, [isPremiumUser, payrollClone, handleExecutePayroll]);

  const handleModalConfirm = useCallback(({ token, group, remark }: PaymentModalParams) => {
    if (group !== activeGroup) dispatch({ type: 'SET_ACTIVE_GROUP', payload: group });
    handleExecutePayroll(token, group, remark);
  }, [activeGroup, dispatch, handleExecutePayroll]);

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <AppLayout title="Dashboard" companyName={payrollSetup?.companyName}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

        {/* ── Newer data available banner ────────────────────────────── */}
        {/* A different device, a teammate, or a scheduled AI-agent run
            anchored a newer CID than what's currently loaded. We never
            overwrite silently — this is the explicit opt-in the person
            asked for. */}
        {payrollSync.syncAvailable && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 12,
            padding: '12px 18px', fontSize: 13,
          }}>
            <span style={{ color: '#3730A3', fontWeight: 600 }}>
              Newer payroll data is available — this device hasn&apos;t synced it yet.
            </span>
            <button
              onClick={() => { void payrollSync.syncNow(); }}
              disabled={payrollSync.status === 'loading'}
              style={{
                padding: '7px 16px', borderRadius: 8, background: '#14B8A6', color: '#fff',
                fontSize: 13, fontWeight: 700, border: 'none',
                cursor: payrollSync.status === 'loading' ? 'default' : 'pointer',
                opacity: payrollSync.status === 'loading' ? 0.6 : 1, fontFamily: 'inherit',
              }}
            >
              {payrollSync.status === 'loading' ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
        )}

        {/* ── Hero balance card ──────────────────────────────────────── */}
        <div style={{ background: '#4F46E5', borderRadius: 20, padding: '24px 28px', position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', top: -40, right: -40, width: 180, height: 180, borderRadius: '50%', background: 'rgba(255,255,255,0.05)' }} />
          <div style={{ position: 'absolute', bottom: -60, right: 60, width: 240, height: 240, borderRadius: '50%', background: 'rgba(255,255,255,0.03)' }} />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button onClick={() => setShowBalance(v => !v)} title={showBalance ? 'Hide balance' : 'Show balance'}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.8)', padding: 0, display: 'flex', alignItems: 'center' }}>
                {showBalance ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)', letterSpacing: '0.03em' }}>Total Balance</span>
            </div>
            <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.75)', textDecoration: 'none', letterSpacing: '0.05em', textTransform: 'uppercase' as const, padding: '4px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.25)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.1)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              Faucet
            </a>
          </div>

          <div style={{ fontSize: 38, fontWeight: 800, color: '#fff', letterSpacing: '-0.02em', marginBottom: 12, position: 'relative' }}>
            {isLoggedIn ? (showBalance ? `$${balanceStr}` : '$••••••') : '$0.00'}
            <span style={{ fontSize: 16, fontWeight: 600, color: 'rgba(255,255,255,0.6)', marginLeft: 8 }}>USDC</span>
          </div>

          {isLoggedIn && address ? (
            <button onClick={handleCopyAddress}
              style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.12)', border: 'none', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: 'rgba(255,255,255,0.85)' }}>
              {address.slice(0, 8)}…{address.slice(-6)}
              <Copy size={13} color={copied ? '#14B8A6' : 'rgba(255,255,255,0.6)'} />
              {copied && <span style={{ fontSize: 11, color: '#14B8A6' }}>Copied!</span>}
            </button>
          ) : (
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', margin: 0 }}>Connect your wallet to view balance</p>
          )}
        </div>

        {/* ── 2 stat cards only ─────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
          <StatCard label="Total Employees" value={employees.length.toLocaleString()}
            sub={activeGroup !== 'All Employees' ? `${filteredEmployees.length} in ${activeGroup}` : undefined}
            icon={<Users size={16} color="#4F46E5" />} />
          <StatCard label="Gross Total Pay"
            value={totalPayroll.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            sub={activeGroup !== 'All Employees' ? `for ${activeGroup}` : 'USDC'}
            icon={<Banknote size={16} color="#14B8A6" />} />
        </div>

        {/* ── Unauthenticated gate ───────────────────────────────────── */}
        {!isLoggedIn ? (
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 20, padding: '60px 24px', textAlign: 'center' }}>
            <Image src="/images/login-illustration.png" alt="Login" width={200} height={200} style={{ objectFit: 'contain', margin: '0 auto' }} />
            <h3 style={{ fontSize: 20, fontWeight: 700, color: '#0F172A', margin: '24px 0 8px' }}>Welcome to Salden</h3>
            <p style={{ fontSize: 14, color: '#64748B', marginBottom: 28, lineHeight: 1.7 }}>
              Login to manage your payroll, add employees, and process Onchain payments.
            </p>
            <button onClick={() => setLoginOpen(true)}
              style={{ padding: '13px 40px', borderRadius: 12, background: '#14B8A6', color: '#fff', fontSize: 15, fontWeight: 700, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
              Login
            </button>
          </div>
        ) : registryStatus === 'checking' ? (
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 20, padding: '60px 24px', textAlign: 'center' }}>
            <Loader2 size={24} style={{ animation: 'spin 0.7s linear infinite', color: '#4F46E5' }} />
            <p style={{ fontSize: 14, color: '#64748B', marginTop: 14 }}>Checking your account…</p>
          </div>
        ) : registryStatus === 'none' ? (
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 20, padding: '60px 24px', textAlign: 'center' }}>
            <h3 style={{ fontSize: 20, fontWeight: 700, color: '#0F172A', margin: '0 0 8px' }}>Finish Your Profile</h3>
            <p style={{ fontSize: 14, color: '#64748B', marginBottom: 28, lineHeight: 1.7, maxWidth: 420, margin: '0 auto 28px' }}>
              Tell us a bit about your company to set up your private, encrypted payroll database Onchain.
            </p>
            <button onClick={() => setProfileModalOpen(true)}
              style={{ padding: '13px 40px', borderRadius: 12, background: '#14B8A6', color: '#fff', fontSize: 15, fontWeight: 700, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
              Finish Your Profile
            </button>
          </div>
        ) : registryStatus === 'exists' && dataLoadStatus === 'loading' ? (
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 20, padding: '60px 24px', textAlign: 'center' }}>
            <Loader2 size={24} style={{ animation: 'spin 0.7s linear infinite', color: '#4F46E5' }} />
            <p style={{ fontSize: 14, color: '#64748B', marginTop: 14 }}>Restoring your saved data…</p>
            <p style={{ fontSize: 12, color: '#94A3B8', marginTop: 6 }}>Check your wallet for a signature request.</p>
          </div>
        ) : employees.length < 2 ? (
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 20, padding: '60px 24px', textAlign: 'center' }}>
            <AddEmployeesIllustration width={200} height={150} />
            <h3 style={{ fontSize: 20, fontWeight: 700, color: '#0F172A', margin: '16px 0 8px' }}>Set Up Employee Data</h3>
            <p style={{ fontSize: 14, color: '#64748B', marginBottom: 28, lineHeight: 1.7, maxWidth: 420, margin: '0 auto 28px' }}>
              Add at least 2 employees to finish setting up your payroll. You can add more anytime afterward.
            </p>
            <button onClick={() => setEmployeeModal({ mode: 'add', setupMode: true })}
              style={{ padding: '13px 40px', borderRadius: 12, background: '#14B8A6', color: '#fff', fontSize: 15, fontWeight: 700, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
              Set Up Employee Data
            </button>
          </div>
        ) : (
          /* ── Employee table ─────────────────────────────────────── */
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16 }}>
            {/* Toolbar */}
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #E2E8F0', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
              {/* Search */}
              <div ref={searchRef} style={{ position: 'relative', flex: 1, minWidth: 200 }}>
                <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#94A3B8', pointerEvents: 'none' }} />
                <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search name or department…"
                  style={{ width: '100%', padding: '9px 14px 9px 36px', border: '1.5px solid #E2E8F0', borderRadius: 10, fontSize: 13, fontFamily: 'inherit', color: '#0F172A', background: '#F8F9FA', outline: 'none' }}
                  onFocus={e => (e.target.style.borderColor = '#4F46E5')}
                  onBlur={e => (e.target.style.borderColor = '#E2E8F0')} />
                {showDropdown && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, background: '#fff', border: '1px solid #E2E8F0', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.1)', zIndex: 20, maxHeight: 240, overflowY: 'auto' }}>
                    {searchResults.map(({ emp, idx }) => (
                      <button key={idx} onClick={() => handleSearchSelect(idx)}
                        style={{ width: '100%', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', textAlign: 'left', fontFamily: 'inherit' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#F8F9FA')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 500, color: '#0F172A' }}>{emp.fullName}</div>
                          <div style={{ fontSize: 11, color: '#64748B' }}>{emp.department}</div>
                        </div>
                        <span style={{ fontSize: 11, color: '#94A3B8', fontFamily: 'monospace' }}>#{idx + 1}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Group filter */}
              <div style={{ position: 'relative' }}>
                <button onClick={() => setGroupMenuOpen(p => !p)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 10, border: '1.5px solid #E2E8F0', background: '#F8F9FA', fontSize: 13, fontWeight: 500, cursor: 'pointer', color: '#475569', fontFamily: 'inherit' }}>
                  <Filter size={14} /> {activeGroup}
                  <ChevronDown size={13} style={{ transform: groupMenuOpen ? 'rotate(180deg)' : 'none', transition: '0.15s' }} />
                </button>
                {groupMenuOpen && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: '#fff', border: '1px solid #E2E8F0', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.1)', zIndex: 20, minWidth: 180, padding: '4px 0' }}>
                    {['All Employees', ...groups].map(g => (
                      <button key={g} onClick={() => { dispatch({ type: 'SET_ACTIVE_GROUP', payload: g }); setGroupMenuOpen(false); }}
                        style={{ width: '100%', padding: '9px 14px', textAlign: 'left', background: g === activeGroup ? '#F0FDFA' : 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: g === activeGroup ? 600 : 400, color: g === activeGroup ? '#14B8A6' : '#475569', fontFamily: 'inherit' }}>
                        {g}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <Button variant="ghost" icon={<UserPlus size={14} />} onClick={() => setEmployeeModal({ mode: 'add' })} size="sm">Add Employee</Button>

              {/* Process Payment — teal, NO play icon */}
              <button onClick={handleProcessPaymentClick} disabled={isExecuting || filteredEmployees.length === 0}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 10, border: 'none', background: isExecuting || !filteredEmployees.length ? '#E2E8F0' : '#14B8A6', color: isExecuting || !filteredEmployees.length ? '#94A3B8' : '#fff', fontSize: 13, fontWeight: 600, cursor: isExecuting || !filteredEmployees.length ? 'not-allowed' : 'pointer', fontFamily: 'inherit', transition: 'background 0.15s' }}
                onMouseEnter={e => { if (!isExecuting && filteredEmployees.length) (e.currentTarget as HTMLButtonElement).style.background = '#0D9488'; }}
                onMouseLeave={e => { if (!isExecuting && filteredEmployees.length) (e.currentTarget as HTMLButtonElement).style.background = '#14B8A6'; }}>
                {isExecuting && <Loader2 size={14} style={{ animation: 'spin 0.7s linear infinite' }} />}
                Process Payment
              </button>
            </div>

            {/* Progress bar */}
            {isExecuting && (
              <div style={{ padding: '10px 20px', background: '#EEF2FF', borderBottom: '1px solid #E2E8F0', display: 'flex', alignItems: 'center', gap: 10 }}>
                <Loader2 size={14} color="#4F46E5" style={{ animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 12, color: '#4F46E5', margin: 0 }}>{executeStatus}</p>
                  {executeProgress && (
                    <div style={{ marginTop: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748B', marginBottom: 3 }}>
                        <span>{executeProgress.current} of {executeProgress.total}</span>
                        <span>{Math.round((executeProgress.current / executeProgress.total) * 100)}%</span>
                      </div>
                      <div style={{ height: 4, borderRadius: 99, background: '#C7D2FE', overflow: 'hidden' }}>
                        <div style={{ height: '100%', borderRadius: 99, background: '#4F46E5', width: `${(executeProgress.current / executeProgress.total) * 100}%`, transition: 'width 0.4s ease' }} />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Table */}
            <div style={{ overflowX: 'auto' }}>
              {filteredEmployees.length === 0 ? (
                <div style={{ padding: '60px 20px', textAlign: 'center' }}>
                  <AddEmployeesIllustration width={220} height={165} />
                  <p style={{ color: '#94A3B8', fontSize: 14, marginTop: 16 }}>
                    No employees in &quot;{activeGroup}&quot;.
                  </p>
                  <Button variant="brand" icon={<UserPlus size={14} />} onClick={() => setEmployeeModal({ mode: 'add' })} style={{ marginTop: 16 }}>
                    Add Employee
                  </Button>
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' as const }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #E2E8F0' }}>
                      {['S/N', 'Full Name', 'Department', 'Wallet Address', 'Salary (USDC)', 'Group'].map(col => (
                        <th key={col} style={{ textAlign: 'left', padding: '10px 20px', fontSize: 11, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase' as const, letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEmployees.map((emp, idx) => (
                      <tr key={idx}
                        ref={el => { rowRefs.current[idx] = el; }}
                        onPointerDown={e => handleRowPointerDown(e, idx)}
                        onPointerUp={handleRowPointerUp}
                        onPointerLeave={handleRowPointerUp}
                        onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, rowIndex: idx }); }}
                        style={{ borderBottom: '1px solid #F1F5F9', background: highlightedRow === idx ? '#EEF2FF' : 'transparent', cursor: 'pointer', transition: 'background 0.15s', userSelect: 'none' }}
                        onMouseEnter={e => { if (highlightedRow !== idx) (e.currentTarget as HTMLTableRowElement).style.background = '#F8F9FA'; }}
                        onMouseLeave={e => { if (highlightedRow !== idx) (e.currentTarget as HTMLTableRowElement).style.background = 'transparent'; }}>
                        <td style={{ padding: '12px 20px', fontSize: 12, fontFamily: 'monospace', color: '#94A3B8' }}>{idx + 1}</td>
                        <td style={{ padding: '12px 20px', fontSize: 14, fontWeight: 600, color: '#0F172A', whiteSpace: 'nowrap' }}>{emp.fullName}</td>
                        <td style={{ padding: '12px 20px', fontSize: 13, color: '#475569', whiteSpace: 'nowrap' }}>{emp.department}</td>
                        <td style={{ padding: '12px 20px' }}>
                          <button onClick={async e => { e.stopPropagation(); const ok = await copyToClipboard(emp.walletAddress); addToast(ok ? 'Address copied' : 'Could not copy address', ok ? 'success' : 'error', 1500); }}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#475569', display: 'flex', alignItems: 'center', gap: 5 }}
                            title={emp.walletAddress}>
                            {truncAddr(emp.walletAddress)} <Copy size={11} color="#94A3B8" />
                          </button>
                        </td>
                        <td style={{ padding: '12px 20px', fontSize: 14, fontWeight: 700, color: '#0F172A', whiteSpace: 'nowrap' }}>
                          {Number(emp.salaryAmount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                        <td style={{ padding: '12px 20px' }}>
                          {emp.group
                            ? <span style={{ display: 'inline-flex', padding: '3px 10px', borderRadius: 99, background: '#EEF2FF', color: '#4F46E5', fontSize: 11, fontWeight: 600 }}>{emp.group}</span>
                            : <span style={{ color: '#E2E8F0', fontSize: 12 }}>—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {filteredEmployees.length > 0 && (
              <div style={{ padding: '10px 20px', borderTop: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#94A3B8' }}>
                  {filteredEmployees.length} employee{filteredEmployees.length !== 1 ? 's' : ''}
                  {activeGroup !== 'All Employees' ? ` in ${activeGroup}` : ''} — Long-press any row for quick actions
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>
                  Total: {totalPayroll.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div onClick={e => e.stopPropagation()}
          style={{ position: 'fixed', zIndex: 9999, top: contextMenu.y, left: contextMenu.x, background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.12)', padding: '4px 0', minWidth: 170 }}>
          <button onClick={() => { setEmployeeModal({ mode: 'edit', employee: employees[contextMenu.rowIndex], rowIndex: contextMenu.rowIndex }); setContextMenu(null); }}
            style={{ width: '100%', padding: '10px 16px', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#475569', fontFamily: 'inherit', textAlign: 'left' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#F8F9FA')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
            <Pencil size={14} /> Edit Row Details
          </button>
          <button onClick={() => { setDeleteModal(contextMenu.rowIndex); setContextMenu(null); }}
            style={{ width: '100%', padding: '10px 16px', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#DC2626', fontFamily: 'inherit', textAlign: 'left' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#FEF2F2')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
            <Trash2 size={14} /> Delete Row
          </button>
        </div>
      )}

      {employeeModal && (
        <EmployeeModal mode={employeeModal.mode} employee={employeeModal.employee} rowIndex={employeeModal.rowIndex}
          setupMode={employeeModal.setupMode} minRequired={2}
          groups={groups} onSave={employeeModal.mode === 'add' ? handleAddEmployee : handleEditEmployee}
          onSaveBulk={handleAddBulk} onClose={() => setEmployeeModal(null)} />
      )}
      {deleteModal !== null && (
        <DeleteModal employee={employees[deleteModal]} onConfirm={() => handleDeleteEmployee(deleteModal)} onClose={() => setDeleteModal(null)} />
      )}
      {isPremiumUser && payrollClone && (
        <PaymentModal open={paymentModalOpen} onClose={() => setPaymentModalOpen(false)} activeGroup={activeGroup} groups={groups} payrollClone={payrollClone} onConfirm={handleModalConfirm} />
      )}
      <ExecutionModal
        state={executionState}
        statusText={executeStatus}
        progress={executeProgress}
        txHash={execTxHash}
        error={executeError}
        onClose={() => { setExecutionState('idle'); setExecuteError(''); setExecTxHash(''); }}
      />
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />
      {profileModalOpen && (
        <ProfileSetupModal
          onClose={() => setProfileModalOpen(false)}
          onComplete={() => { setProfileModalOpen(false); setRegistryStatus('exists'); }}
        />
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </AppLayout>
  );
}
