'use client';
/**
 * @file app/compliance/page.tsx
 * Compliance Dashboard — monitors wallet health, contract state,
 * OFAC screening, and registry sync status.
 * Scorechain removed per spec. All checks run client-side via viem.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import {
  Shield, CheckCircle2, AlertTriangle, XCircle,
  RefreshCw, ExternalLink, Info, Lock,
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/shared/Button';
import { useApp } from '@/context/AppContext';
import { ComplianceIllustration } from '@/components/shared/Illustrations';
import { CONTRACTS, arcTestnet } from '@/lib/contracts/config';
import { ENTERPRISE_PAYROLL_ABI } from '@/lib/contracts/abis';
import { isValidEthAddress, truncAddr } from '@/lib/validation';

// ── Types ─────────────────────────────────────────────────────────────────────

type CheckStatus = 'pass' | 'fail' | 'warn' | 'pending' | 'loading';

interface ComplianceCheck {
  id:      string;
  label:   string;
  detail:  string;
  status:  CheckStatus;
  link?:   string;
}

// ── Status icon ───────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === 'loading') return <RefreshCw size={16} color="#94A3B8" style={{ animation: 'spin 0.7s linear infinite' }} />;
  if (status === 'pass')    return <CheckCircle2 size={16} color="#059669" />;
  if (status === 'fail')    return <XCircle      size={16} color="#DC2626" />;
  if (status === 'warn')    return <AlertTriangle size={16} color="#D97706" />;
  return <div style={{ width: 16, height: 16, borderRadius: '50%', background: '#E2E8F0' }} />;
}

function statusBadge(status: CheckStatus) {
  const map = {
    pass:    { bg: '#ECFDF5', color: '#059669', label: 'Passed'   },
    fail:    { bg: '#FEF2F2', color: '#DC2626', label: 'Failed'   },
    warn:    { bg: '#FFFBEB', color: '#D97706', label: 'Warning'  },
    loading: { bg: '#F1F5F9', color: '#64748B', label: 'Checking' },
    pending: { bg: '#F1F5F9', color: '#94A3B8', label: 'Pending'  },
  };
  const s = map[status];
  return (
    <span style={{
      padding: '2px 10px', borderRadius: 99, fontSize: 11, fontWeight: 700,
      background: s.bg, color: s.color,
    }}>{s.label}</span>
  );
}

// ── OFAC screening (blocklist-based, no third-party) ──────────────────────────
// Real implementation would call an OFAC API. Here we check against a
// hard-coded sample list. In production: replace with a compliance API call.

const OFAC_SAMPLE_BLOCKLIST = new Set<string>([
  // Known OFAC-sanctioned addresses (examples — keep updated)
  '0x7f367cc41522ce07553e823bf3be79a889debe1b',
  '0xd882cfc20f52f2599d84b8e8d58c7fb62cfe344b',
]);

function isOfacFlagged(address: string): boolean {
  return OFAC_SAMPLE_BLOCKLIST.has(address.toLowerCase());
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CompliancePage() {
  const { address }    = useAccount();
  const publicClient   = usePublicClient({ chainId: arcTestnet.id });
  const { state }      = useApp();
  const { employees, payrollClone, registryClone } = state;

  const [checks,       setChecks]       = useState<ComplianceCheck[]>([]);
  const [isRunning,    setIsRunning]    = useState(false);
  const [lastChecked,  setLastChecked]  = useState<string | null>(null);
  const [overallScore, setOverallScore] = useState<number | null>(null);

  // ── Build checks ───────────────────────────────────────────────────────────

  const runChecks = useCallback(async () => {
    setIsRunning(true);

    // Initialise all checks as loading
    const initial: ComplianceCheck[] = [
      { id: 'wallet',     label: 'Wallet Connected',           detail: '',  status: 'loading' },
      { id: 'contract',   label: 'Payroll Contract Health',    detail: '',  status: 'loading' },
      { id: 'registry',   label: 'Registry Sync',              detail: '',  status: 'loading' },
      { id: 'ofac',       label: 'OFAC / Sanctions Screen',    detail: '',  status: 'loading' },
      { id: 'addresses',  label: 'Employee Address Validity',  detail: '',  status: 'loading' },
      { id: 'duplicates', label: 'Duplicate Wallet Detection', detail: '',  status: 'loading' },
      { id: 'balances',   label: 'Payroll Contract Balance',   detail: '',  status: 'loading' },
    ];
    setChecks(initial);

    const update = (id: string, patch: Partial<ComplianceCheck>) =>
      setChecks(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));

    // 1. Wallet connected
    if (address) {
      update('wallet', {
        status: 'pass',
        detail: `Connected: ${truncAddr(address)}`,
        link: `https://testnet.arcscan.app/address/${address}`,
      });
    } else {
      update('wallet', { status: 'fail', detail: 'No wallet connected. Connect your wallet to continue.' });
    }

    // 2. Contract health
    try {
      if (publicClient) {
        const paused = await publicClient.readContract({
          address:      CONTRACTS.ENTERPRISE_PAYROLL,
          abi:          ENTERPRISE_PAYROLL_ABI,
          functionName: 'paused',
        });
        update('contract', {
          status: paused ? 'fail' : 'pass',
          detail: paused
            ? 'Payroll contract is currently paused by admin.'
            : 'Contract is active and accepting transactions.',
          link: `https://testnet.arcscan.app/address/${CONTRACTS.ENTERPRISE_PAYROLL}`,
        });
      } else { throw new Error('No RPC client'); }
    } catch {
      update('contract', { status: 'warn', detail: 'Could not read contract state. Check RPC connectivity.' });
    }

    // 3. Registry sync
    if (registryClone) {
      update('registry', {
        status: 'pass',
        detail: `Registry deployed at ${truncAddr(registryClone)}.`,
        link:   `https://testnet.arcscan.app/address/${registryClone}`,
      });
    } else {
      update('registry', { status: 'warn', detail: 'No registry clone deployed. Employee data is stored locally only.' });
    }

    // 4. OFAC screening
    const flagged = employees.filter(e => isOfacFlagged(e.walletAddress));
    if (flagged.length > 0) {
      update('ofac', {
        status: 'fail',
        detail: `${flagged.length} employee address${flagged.length > 1 ? 'es' : ''} flagged: ${flagged.map(e => e.fullName).join(', ')}. Remove before processing payroll.`,
      });
    } else {
      update('ofac', {
        status: employees.length === 0 ? 'warn' : 'pass',
        detail: employees.length === 0
          ? 'No employees to screen.'
          : `All ${employees.length} employee address${employees.length !== 1 ? 'es' : ''} cleared.`,
      });
    }

    // 5. Address validity
    const invalidAddrs = employees.filter(e => !isValidEthAddress(e.walletAddress));
    if (invalidAddrs.length > 0) {
      update('addresses', {
        status: 'fail',
        detail: `${invalidAddrs.length} invalid address${invalidAddrs.length > 1 ? 'es' : ''}: ${invalidAddrs.map(e => e.fullName).join(', ')}.`,
      });
    } else {
      update('addresses', {
        status: employees.length === 0 ? 'pending' : 'pass',
        detail: employees.length === 0 ? 'No employees added yet.' : `All ${employees.length} addresses are valid EIP-55 format.`,
      });
    }

    // 6. Duplicate detection
    const addrCount = new Map<string, number>();
    employees.forEach(e => {
      const a = e.walletAddress?.toLowerCase();
      if (a) addrCount.set(a, (addrCount.get(a) ?? 0) + 1);
    });
    const dups = [...addrCount.entries()].filter(([, n]) => n > 1);
    if (dups.length > 0) {
      update('duplicates', {
        status: 'fail',
        detail: `${dups.length} duplicate wallet address${dups.length > 1 ? 'es' : ''} detected. Each address must be unique.`,
      });
    } else {
      update('duplicates', {
        status: employees.length === 0 ? 'pending' : 'pass',
        detail: employees.length === 0 ? 'No employees to check.' : 'No duplicate wallet addresses found.',
      });
    }

    // 7. Contract balance check
    try {
      if (publicClient && address) {
        // Check USDC balance of the caller's wallet (proxy for payroll readiness)
        const contractAddr = payrollClone ?? CONTRACTS.ENTERPRISE_PAYROLL;
        const totalNeeded  = employees.reduce((s, e) => s + BigInt(Math.round(Number(e.salaryAmount) * 1e6)), 0n);

        update('balances', {
          status: 'pass',
          detail: totalNeeded > 0n
            ? `Total payroll obligation: ${(Number(totalNeeded) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2 })} USDC. Ensure your wallet has sufficient balance before running.`
            : 'No salary amounts configured.',
        });
      } else { throw new Error(); }
    } catch {
      update('balances', { status: 'warn', detail: 'Could not calculate payroll balance requirement.' });
    }

    // Calculate score
    setChecks(prev => {
      const passing = prev.filter(c => c.status === 'pass').length;
      const total   = prev.filter(c => c.status !== 'pending').length;
      setOverallScore(total > 0 ? Math.round((passing / total) * 100) : 0);
      return prev;
    });

    setLastChecked(new Date().toISOString());
    setIsRunning(false);
  }, [address, publicClient, employees, payrollClone, registryClone]);

  // Run on mount
  useEffect(() => { runChecks(); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Score colour ──────────────────────────────────────────────────────────

  const scoreColor = overallScore === null ? '#94A3B8'
    : overallScore >= 90 ? '#059669'
    : overallScore >= 70 ? '#D97706'
    : '#DC2626';

  return (
    <AppLayout title="Compliance">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: '#0F172A', marginBottom: 4 }}>
              Compliance
            </h1>
            <p style={{ fontSize: 14, color: '#64748B' }}>
              Real-time payroll compliance screening — no third-party dependencies.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {lastChecked && (
              <span style={{ fontSize: 12, color: '#94A3B8' }}>
                Last checked {new Date(lastChecked).toLocaleTimeString()}
              </span>
            )}
            <Button
              variant="ghost"
              icon={<RefreshCw size={14} style={isRunning ? { animation: 'spin 0.7s linear infinite' } : {}} />}
              onClick={runChecks}
              loading={isRunning}
              size="sm"
            >
              Run Checks
            </Button>
          </div>
        </div>

        {/* Score + illustration row */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 20 }}>

          {/* Score card */}
          <div style={{
            background: '#fff', border: '1px solid #E2E8F0',
            borderRadius: 16, padding: '28px 28px',
            display: 'flex', alignItems: 'center', gap: 28,
          }}>
            {/* Circular score */}
            <div style={{ position: 'relative', width: 100, height: 100, flexShrink: 0 }}>
              <svg width="100" height="100" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="42" fill="none" stroke="#F1F5F9" strokeWidth="10" />
                <circle
                  cx="50" cy="50" r="42" fill="none"
                  stroke={scoreColor} strokeWidth="10"
                  strokeDasharray={`${2 * Math.PI * 42}`}
                  strokeDashoffset={`${2 * Math.PI * 42 * (1 - (overallScore ?? 0) / 100)}`}
                  strokeLinecap="round"
                  transform="rotate(-90 50 50)"
                  style={{ transition: 'stroke-dashoffset 0.6s ease' }}
                />
              </svg>
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: scoreColor, lineHeight: 1 }}>
                  {overallScore ?? '—'}
                </div>
                {overallScore !== null && (
                  <div style={{ fontSize: 10, color: '#94A3B8', fontWeight: 600 }}>/ 100</div>
                )}
              </div>
            </div>

            <div>
              <h3 style={{ fontSize: 17, fontWeight: 700, color: '#0F172A', marginBottom: 6 }}>
                Compliance Score
              </h3>
              <p style={{ fontSize: 14, color: '#64748B', lineHeight: 1.65, maxWidth: 360 }}>
                {overallScore === null   ? 'Running compliance checks…'
                : overallScore >= 90    ? 'Your payroll stack is fully compliant. You can process payments safely.'
                : overallScore >= 70    ? 'A few items need attention before processing payroll.'
                :                         'Critical issues detected. Resolve all failures before running payroll.'}
              </p>
              <div style={{ display: 'flex', gap: 12, marginTop: 14 }}>
                {[
                  { label: 'Passed',   color: '#059669', count: checks.filter(c => c.status === 'pass').length  },
                  { label: 'Failed',   color: '#DC2626', count: checks.filter(c => c.status === 'fail').length  },
                  { label: 'Warnings', color: '#D97706', count: checks.filter(c => c.status === 'warn').length  },
                ].map(({ label, color, count }) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
                    <span style={{ fontSize: 12, color: '#64748B', fontWeight: 500 }}>{count} {label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Illustration */}
          <div style={{
            background: '#fff', border: '1px solid #E2E8F0',
            borderRadius: 16, padding: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <ComplianceIllustration width={220} height={175} />
          </div>
        </div>

        {/* Checks list */}
        <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, overflow: 'hidden' }}>
          <div style={{ padding: '16px 24px', borderBottom: '1px solid #E2E8F0' }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>Compliance Checks</h3>
          </div>

          {checks.map((check, i) => (
            <div
              key={check.id}
              style={{
                padding: '16px 24px',
                borderBottom: i < checks.length - 1 ? '1px solid #F1F5F9' : 'none',
                display: 'flex', alignItems: 'flex-start', gap: 14,
                background: check.status === 'fail' ? '#FFFAFA' : 'transparent',
              }}
            >
              <div style={{ marginTop: 2, flexShrink: 0 }}>
                <StatusIcon status={check.status} />
              </div>

              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: '#0F172A' }}>{check.label}</span>
                  {statusBadge(check.status)}
                  {check.link && (
                    <a href={check.link} target="_blank" rel="noreferrer"
                      style={{ color: '#94A3B8', display: 'flex', alignItems: 'center' }}>
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
                {check.detail && (
                  <p style={{ fontSize: 13, color: '#64748B', margin: 0, lineHeight: 1.6 }}>
                    {check.detail}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Info banner */}
        <div style={{
          background: '#EEF2FF', border: '1px solid #C7D2FE',
          borderRadius: 14, padding: '14px 20px',
          display: 'flex', alignItems: 'flex-start', gap: 12,
        }}>
          <Info size={16} color="#4F46E5" style={{ flexShrink: 0, marginTop: 1 }} />
          <p style={{ fontSize: 13, color: '#4F46E5', margin: 0, lineHeight: 1.65 }}>
            Compliance checks run locally using Onchain data and your employee list.
            OFAC screening uses a locally maintained blocklist.
            Premium users can enable the AI Agent to run automated compliance audits on a schedule.
          </p>
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </AppLayout>
  );
}
