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
  Upload, FileText, Filter, Database,
} from 'lucide-react';
import {
  useAccount, useWalletClient, usePublicClient, useReadContract,
} from 'wagmi';
import { AppLayout }      from '@/components/layout/AppLayout';
import { useApp }         from '@/context/AppContext';
import { Modal }          from '@/components/shared/Modal';
import { Button }         from '@/components/shared/Button';
import { PaymentModal }   from '@/components/dashboard/PaymentModal';
import { LoginModal }     from '@/components/auth/LoginModal';
import {
  AddEmployeesIllustration,
  LoginIllustration,
} from '@/components/shared/Illustrations';
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
}

function EmployeeModal({
  mode, employee, rowIndex, groups, onSave, onSaveBulk, onClose,
}: EmployeeModalProps) {
  const { dispatch }           = useApp();
  const { address }            = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient           = usePublicClient();

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

  // ── "Create Secure Company Database" button ──────────────────────────────
  const [dbStatus, setDbStatus] = useState<'checking' | 'idle' | 'exists' | 'creating' | 'done' | 'error'>('checking');
  const [dbError,  setDbError]  = useState('');

  useEffect(() => {
    if (!address || !publicClient) { setDbStatus('idle'); return; }
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
          setDbStatus('exists');
          dispatch({ type: 'SET_REGISTRY', payload: existing });
        } else {
          setDbStatus('idle');
        }
      } catch {
        if (!cancelled) setDbStatus('idle');
      }
    })();
    return () => { cancelled = true; };
  }, [address, publicClient, dispatch]);

  async function handleCreateDb() {
    if (!walletClient || !publicClient || !address) return;
    setDbStatus('creating'); setDbError('');
    try {
      const hash = await walletClient.writeContract({
        address:      CONTRACTS.REGISTRY_FACTORY,
        abi:          REGISTRY_FACTORY_ABI,
        functionName: 'createRegistry',
        args:         [],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      const clone = await publicClient.readContract({
        address:      CONTRACTS.REGISTRY_FACTORY,
        abi:          REGISTRY_FACTORY_ABI,
        functionName: 'getRegistry',
        args:         [address as `0x${string}`],
      }) as `0x${string}`;
      dispatch({ type: 'SET_REGISTRY', payload: clone });
      setDbStatus('done');
    } catch (err) {
      setDbError((err as Error).message ?? 'Transaction failed');
      setDbStatus('error');
    }
  }

  const dbCreated = dbStatus === 'exists' || dbStatus === 'done';

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
      onClose();
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
    try { await onSaveBulk(withGroup); onClose(); }
    catch (err) { setFileError((err as Error).message); }
    finally { setImporting(false); }
  }

  const inp: React.CSSProperties = {
    width: '100%', padding: '10px 14px', border: '1.5px solid #E2E8F0',
    borderRadius: 10, fontFamily: 'inherit', fontSize: 14, color: '#0F172A',
    background: '#fff', outline: 'none',
  };

  // Shared top section: Create DB button + group selector
  const sharedTop = (
    <>
      <div style={{ marginBottom: 18 }}>
        {dbStatus === 'checking' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#64748B' }}>
            <Loader2 size={14} style={{ animation: 'spin 0.7s linear infinite' }} /> Checking company database…
          </div>
        ) : dbCreated ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderRadius: 10, background: '#ECFDF5', border: '1px solid #A7F3D0', fontSize: 13, fontWeight: 600, color: '#059669' }}>
            <CheckCircle2 size={16} color="#059669" /> Created Company&apos;s Database
          </div>
        ) : (
          <>
            <button onClick={handleCreateDb} disabled={dbStatus === 'creating' || !address}
              style={{ width: '100%', padding: '11px 16px', borderRadius: 10, border: '1.5px solid #4F46E5', background: dbStatus === 'creating' ? '#EEF2FF' : '#fff', color: '#4F46E5', fontSize: 14, fontWeight: 600, cursor: dbStatus === 'creating' ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontFamily: 'inherit' }}>
              {dbStatus === 'creating'
                ? <><Loader2 size={14} style={{ animation: 'spin 0.7s linear infinite' }} /> Creating…</>
                : <><Database size={14} /> Create Secure Company Database</>
              }
            </button>
            {dbError && <p style={{ fontSize: 12, color: '#DC2626', marginTop: 6 }}>{dbError}</p>}
            {dbStatus === 'error' && (
              <p style={{ fontSize: 12, color: '#DC2626', marginTop: 4 }}>
                Transaction rejected or failed. Please try again.
              </p>
            )}
            <p style={{ fontSize: 12, color: '#94A3B8', marginTop: 6, lineHeight: 1.5 }}>
              Required before adding employees. Creates your encrypted company database Onchain.
            </p>
          </>
        )}
      </div>

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
            <button onClick={commitNewGroup} style={{ padding: '10px 14px', borderRadius: 10, background: '#4F46E5', color: '#fff', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>Add</button>
            <button onClick={() => { setShowNewGroup(false); setNewGroupName(''); }} style={{ padding: '10px 12px', borderRadius: 10, background: '#F8F9FA', color: '#64748B', border: '1px solid #E2E8F0', cursor: 'pointer' }}>✕</button>
          </div>
        )}
      </div>
    </>
  );

  return (
    <Modal open onClose={onClose} title={mode === 'add' ? 'Set Up Employees Data' : 'Edit Employee'} maxWidth={500}>
      {mode === 'add' && (
        <div style={{ display: 'flex', borderBottom: '1px solid #E2E8F0', marginBottom: 20 }}>
          {(['single', 'bulk'] as const).map(t => (
            <button key={t} onClick={() => { setTab(t); setErrors([]); setFileError(''); }}
              style={{ flex: 1, padding: '10px 0', fontSize: 13, fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', color: tab === t ? '#4F46E5' : '#64748B', borderBottom: tab === t ? '2px solid #4F46E5' : '2px solid transparent', fontFamily: 'inherit' }}>
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
  const { address, isConnected }  = useAccount();
  const { data: walletClient }    = useWalletClient();
  const publicClient              = usePublicClient();

  const {
    employees, groups, activeGroup,
    payrollSetup, payrollClone, isPremiumUser,
  } = state;

  // ── Login state ────────────────────────────────────────────────────────────
  const [loginOpen,        setLoginOpen]        = useState(false);
  const [showBalance,      setShowBalance]      = useState(false);
  const [copied,           setCopied]           = useState(false);
  const [hasCircleSession, setHasCircleSession] = useState(false);

  useEffect(() => {
    try {
      const s = localStorage.getItem('salden_session');
      if (s) { const p = JSON.parse(s) as { walletAddress?: string }; if (p?.walletAddress) setHasCircleSession(true); }
    } catch { /* ignore */ }
  }, []);

  const isLoggedIn = isConnected || hasCircleSession;

  // ── USDC balance (audit fix: args always defined; query.enabled gates execution)
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as `0x${string}`;
  const { data: rawBalance } = useReadContract({
    address:      CONTRACTS.USDC,
    abi:          ERC20_ABI,
    functionName: 'balanceOf',
    args:         [address ?? ZERO_ADDR],
    query:        { enabled: !!address },
  });
  const balanceStr = rawBalance !== undefined
    ? (Number(rawBalance as bigint) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '0.00';

  function handleCopyAddress() {
    if (!address) return;
    navigator.clipboard?.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  const [searchQuery,    setSearchQuery]    = useState('');
  const [searchResults,  setSearchResults]  = useState<{ emp: Employee; idx: number }[]>([]);
  const [showDropdown,   setShowDropdown]   = useState(false);
  const [highlightedRow, setHighlightedRow] = useState<number | null>(null);
  const rowRefs   = useRef<Record<number, HTMLTableRowElement | null>>({});
  const searchRef = useRef<HTMLDivElement>(null);

  // ── Modal state ────────────────────────────────────────────────────────────
  const [employeeModal,    setEmployeeModal]    = useState<{ mode: 'add' | 'edit'; employee?: Employee; rowIndex?: number } | null>(null);
  const [deleteModal,      setDeleteModal]      = useState<number | null>(null);
  const [contextMenu,      setContextMenu]      = useState<{ x: number; y: number; rowIndex: number } | null>(null);
  const [groupMenuOpen,    setGroupMenuOpen]    = useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (longPress.current) clearTimeout(longPress.current); }, []);

  // ── Execution ──────────────────────────────────────────────────────────────
  const [isExecuting,     setIsExecuting]     = useState(false);
  const [executeStatus,   setExecuteStatus]   = useState('');
  const [executeProgress, setExecuteProgress] = useState<{ current: number; total: number } | null>(null);

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
  const sign = useCallback((msg: string) => walletClient ? walletClient.signMessage({ message: msg }) : Promise.reject(new Error('No wallet')), [walletClient]);

  const handleAddEmployee = useCallback(async (data: Employee) => {
    const next = [...employees, data];
    dispatch({ type: 'SET_EMPLOYEES', payload: next });
    try { await syncData({ employees: next, walletAddress: address ?? '', signMessage: sign }); addToast('Employee added.', 'success'); }
    catch { addToast('Saved locally — sync failed.', 'warning'); }
  }, [employees, dispatch, syncData, addToast, address, sign]);

  const handleAddBulk = useCallback(async (data: Employee[]) => {
    const next = [...employees, ...data];
    dispatch({ type: 'SET_EMPLOYEES', payload: next });
    try { await syncData({ employees: next, walletAddress: address ?? '', signMessage: sign }); addToast(`${data.length} employees imported.`, 'success'); }
    catch { addToast('Saved locally — sync failed.', 'warning'); }
  }, [employees, dispatch, syncData, addToast, address, sign]);

  const handleEditEmployee = useCallback(async (data: Employee, rowIndex?: number) => {
    if (rowIndex === undefined) return;
    const next = employees.map((e, i) => i === rowIndex ? { ...e, ...data } : e);
    dispatch({ type: 'SET_EMPLOYEES', payload: next });
    try { await syncData({ employees: next, walletAddress: address ?? '', signMessage: sign }); addToast('Employee updated.', 'success'); }
    catch { addToast('Saved locally — sync failed.', 'warning'); }
  }, [employees, dispatch, syncData, addToast, address, sign]);

  const handleDeleteEmployee = useCallback(async (rowIndex: number) => {
    const next = employees.filter((_, i) => i !== rowIndex);
    dispatch({ type: 'SET_EMPLOYEES', payload: next });
    try { await syncData({ employees: next, walletAddress: address ?? '', signMessage: sign }); addToast('Employee removed.', 'success'); }
    catch { addToast('Saved locally — sync failed.', 'warning'); }
  }, [employees, dispatch, syncData, addToast, address, sign]);

  // ── Execute payroll (audit fix: uses static imports only — no dynamic re-imports) ──
  const handleExecutePayroll = useCallback(async (overrideToken: TokenEntry | null, overrideGroup?: string) => {
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

    if (!walletClient || !publicClient) { addToast('Wallet not connected.', 'error'); return; }

    setIsExecuting(true); setExecuteStatus('Preparing payroll execution…');
    try {
      setExecuteStatus(`Checking ${tokenSymbol} allowance…`);
      setExecuteProgress({ current: 0, total: targetEmployees.length });

      const allowance = await publicClient.readContract({
        address: tokenAddr, abi: ERC20_ABI, functionName: 'allowance',
        args: [address as `0x${string}`, contractAddr],
      }) as bigint;

      if (allowance < totalAmount) {
        setExecuteStatus(`Approving ${tokenSymbol} transfer…`);
        const approveTx = await walletClient.writeContract({
          address: tokenAddr, abi: ERC20_ABI, functionName: 'approve',
          args: [contractAddr, totalAmount],
        });
        setExecuteStatus('Waiting for approval confirmation…');
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
      }

      setExecuteStatus('Executing batch payment…');
      let txHash: `0x${string}`;
      if (payrollClone) {
        txHash = await walletClient.writeContract({
          address: contractAddr, abi: MULTI_TOKEN_PAYROLL_ABI, functionName: 'batchPay',
          args: [addrs, amounts, tokenAddr],
        });
      } else {
        txHash = await walletClient.writeContract({
          address: contractAddr, abi: ENTERPRISE_PAYROLL_ABI, functionName: 'batchPay',
          args: [addrs, amounts],
        });
      }

      setExecuteStatus('Confirming Onchain…');
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      setExecuteProgress({ current: targetEmployees.length, total: targetEmployees.length });

      const totalHuman = (Number(totalAmount) / tokenScale).toLocaleString('en-US', { minimumFractionDigits: 2 });
      await saveTxRecord({
        id: txHash, hash: txHash, type: 'batchPay',
        amount: totalHuman, token: tokenSymbol,
        recipientCount: targetEmployees.length,
        timestamp: Date.now(), invoiceEmailStatus: null,
      }, address);

      addToast(`Payroll complete — ${targetEmployees.length} employee${targetEmployees.length !== 1 ? 's' : ''} paid in ${tokenSymbol}.`, 'success', 6000);
    } catch (err) {
      addToast(`Payroll failed: ${(err as Error).message}`, 'error');
    } finally {
      setIsExecuting(false); setExecuteStatus(''); setExecuteProgress(null);
    }
  }, [payrollClone, employees, activeGroup, walletClient, publicClient, address, addToast, saveTxRecord]);

  const handleProcessPaymentClick = useCallback(() => {
    if (isPremiumUser && payrollClone) setPaymentModalOpen(true);
    else handleExecutePayroll(null);
  }, [isPremiumUser, payrollClone, handleExecutePayroll]);

  const handleModalConfirm = useCallback(({ token, group }: { token: TokenEntry; group: string }) => {
    if (group !== activeGroup) dispatch({ type: 'SET_ACTIVE_GROUP', payload: group });
    handleExecutePayroll(token, group);
  }, [activeGroup, dispatch, handleExecutePayroll]);

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <AppLayout title="Dashboard" companyName={payrollSetup?.companyName}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

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
            icon={<CheckCircle2 size={16} color="#14B8A6" />} />
        </div>

        {/* ── Unauthenticated gate ───────────────────────────────────── */}
        {!isLoggedIn ? (
          <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 20, padding: '60px 24px', textAlign: 'center' }}>
            <LoginIllustration width={200} height={160} />
            <h3 style={{ fontSize: 20, fontWeight: 700, color: '#0F172A', margin: '24px 0 8px' }}>Welcome to Salden</h3>
            <p style={{ fontSize: 14, color: '#64748B', marginBottom: 28, lineHeight: 1.7 }}>
              Login to manage your payroll, add employees, and process Onchain payments.
            </p>
            <button onClick={() => setLoginOpen(true)}
              style={{ padding: '13px 40px', borderRadius: 12, background: '#4F46E5', color: '#fff', fontSize: 15, fontWeight: 700, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
              Login
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
                        style={{ width: '100%', padding: '9px 14px', textAlign: 'left', background: g === activeGroup ? '#EEF2FF' : 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: g === activeGroup ? 600 : 400, color: g === activeGroup ? '#4F46E5' : '#475569', fontFamily: 'inherit' }}>
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
                    {employees.length === 0 ? 'No employees yet. Add your first employee to get started.' : `No employees in "${activeGroup}".`}
                  </p>
                  <Button variant="brand" icon={<UserPlus size={14} />} onClick={() => setEmployeeModal({ mode: 'add' })} style={{ marginTop: 16 }}>
                    Set up Employees Data
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
                          <button onClick={e => { e.stopPropagation(); navigator.clipboard?.writeText(emp.walletAddress); addToast('Address copied', 'success', 1500); }}
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
          groups={groups} onSave={employeeModal.mode === 'add' ? handleAddEmployee : handleEditEmployee}
          onSaveBulk={handleAddBulk} onClose={() => setEmployeeModal(null)} />
      )}
      {deleteModal !== null && (
        <DeleteModal employee={employees[deleteModal]} onConfirm={() => handleDeleteEmployee(deleteModal)} onClose={() => setDeleteModal(null)} />
      )}
      {isPremiumUser && payrollClone && (
        <PaymentModal open={paymentModalOpen} onClose={() => setPaymentModalOpen(false)} activeGroup={activeGroup} groups={groups} payrollClone={payrollClone} onConfirm={handleModalConfirm} />
      )}
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} />

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </AppLayout>
  );
}
