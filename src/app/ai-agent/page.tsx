'use client';
/**
 * @file app/ai-agent/page.tsx
 *
 * This page is intentionally NOT a chat interface. It only handles:
 *  1. Activating the AI Agent (provisions a Circle-managed wallet for it).
 *  2. Authorizing the agent's wallet on the user's own contracts:
 *       SaldenMultiTokenPayroll (payrollClone)  — onlyOwner addAgent()
 *       SaldenRegistry (registryClone)          — onlyOwner addAgent()
 *
 * Chat, the action log, and schedules all live on /ai-agent/manage.
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useAccount, useWalletClient, usePublicClient } from 'wagmi';
import {
  Loader2, Power, PowerOff, Shield, CheckCircle2,
  ArrowLeft, Settings2, Check, X as XIcon,
} from 'lucide-react';
import Image from 'next/image';
import { Button } from '@/components/shared/Button';
import { Sidebar } from '@/components/layout/Sidebar';
import { useApp } from '@/context/AppContext';

// ── addAgent ABI — identical shape on both MultiTokenPayroll and Registry ─────
const ADD_AGENT_ABI = [
  {
    name:            'addAgent',
    type:            'function' as const,
    inputs:          [{ name: 'account', type: 'address' as const }],
    outputs:         [] as const,
    stateMutability: 'nonpayable' as const,
  },
] as const;

// ── isAgent read ABI ───────────────────────────────────────────────────────────
const IS_AGENT_ABI = [
  {
    name:            'isAgent',
    type:            'function' as const,
    inputs:          [{ name: '', type: 'address' as const }],
    outputs:         [{ name: '', type: 'bool' as const }],
    stateMutability: 'view' as const,
  },
] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentStatus {
  active:          boolean;
  walletAddress?:  string;
  lastRun?:        number;
  schedules:       number;
}

// ── Agent avatar (with live-status dot) ────────────────────────────────────────

function AgentAvatar({ size = 28, active = false }: { size?: number; active?: boolean }) {
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <div style={{
        width: size, height: size, borderRadius: '50%', overflow: 'hidden',
        background: '#EEF2FF', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Image src="/images/ai-avatar.png" alt="Salden AI Agent" width={size} height={size} style={{ objectFit: 'cover' }} />
      </div>
      <span style={{
        position: 'absolute', bottom: -1, right: -1,
        width: Math.max(8, size * 0.32), height: Math.max(8, size * 0.32),
        borderRadius: '50%', border: '2px solid #fff',
        background: active ? '#14B8A6' : '#94A3B8',
        boxShadow: active ? '0 0 4px #14B8A6' : 'none',
      }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function AIAgentPage() {
  const { state }              = useApp();
  const { address }            = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient           = usePublicClient();

  const { isPremiumUser, payrollClone, registryClone } = state;

  // ── Layout overlays ────────────────────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // ── Agent ──────────────────────────────────────────────────────────────────
  const [agentStatus,      setAgentStatus]      = useState<AgentStatus | null>(null);
  const [activating,       setActivating]       = useState(false);
  const [showChecklist,    setShowChecklist]    = useState(false);
  const [payrollGranted,   setPayrollGranted]   = useState(false);
  const [registryGranted,  setRegistryGranted]  = useState(false);
  const [grantingPayroll,  setGrantingPayroll]  = useState(false);
  const [grantingRegistry, setGrantingRegistry] = useState(false);
  const [grantError,       setGrantError]       = useState('');
  const [showPremiumError, setShowPremiumError] = useState(false);

  // ── Fetch agent status ────────────────────────────────────────────────────
  useEffect(() => {
    if (!address) return;
    fetch('/api/agent/status')
      .then(r => r.ok ? r.json() : null)
      .then((d: AgentStatus | null) => d && setAgentStatus(d))
      .catch(() => null);
  }, [address]);

  // ── Pre-check existing grants ─────────────────────────────────────────────
  useEffect(() => {
    if (!agentStatus?.walletAddress || !publicClient) return;
    const agentAddr = agentStatus.walletAddress as `0x${string}`;

    async function checkGrants() {
      if (payrollClone) {
        try {
          const g = await publicClient!.readContract({ address: payrollClone as `0x${string}`, abi: IS_AGENT_ABI, functionName: 'isAgent', args: [agentAddr] }) as boolean;
          setPayrollGranted(g);
        } catch { /* not granted or call failed */ }
      }
      if (registryClone) {
        try {
          const g = await publicClient!.readContract({ address: registryClone as `0x${string}`, abi: IS_AGENT_ABI, functionName: 'isAgent', args: [agentAddr] }) as boolean;
          setRegistryGranted(g);
        } catch { /* not granted or call failed */ }
      }
    }
    checkGrants();
  }, [agentStatus?.walletAddress, payrollClone, registryClone, publicClient]);

  // ── Toggle agent ───────────────────────────────────────────────────────────
  async function handleToggleAgent() {
    if (!isPremiumUser) { setShowPremiumError(true); return; }

    setActivating(true);
    try {
      if (agentStatus?.active) {
        await fetch('/api/agent/deactivate', { method: 'POST' });
        setAgentStatus(prev => prev ? { ...prev, active: false } : null);
        setShowChecklist(false);
      } else {
        const res  = await fetch('/api/agent/activate', { method: 'POST' });
        const data = await res.json() as { walletAddress?: string; error?: string };
        if (!res.ok) throw new Error(data.error ?? 'Activation failed');
        setAgentStatus({ active: true, walletAddress: data.walletAddress, schedules: 0 });
      }
    } catch {
      // Swallow — the button simply stays in its previous state.
    } finally { setActivating(false); }
  }

  // ── Grant addAgent — payroll clone ─────────────────────────────────────────
  async function handleGrantPayroll() {
    if (!walletClient || !publicClient || !payrollClone || !agentStatus?.walletAddress) return;
    setGrantingPayroll(true); setGrantError('');
    try {
      const hash = await walletClient.writeContract({
        address:      payrollClone as `0x${string}`,
        abi:          ADD_AGENT_ABI,
        functionName: 'addAgent',
        args:         [agentStatus.walletAddress as `0x${string}`],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setPayrollGranted(true);
    } catch (err) {
      setGrantError(`Payroll authorization failed: ${(err as Error).message}`);
    } finally { setGrantingPayroll(false); }
  }

  // ── Grant addAgent — registry clone ───────────────────────────────────────
  async function handleGrantRegistry() {
    if (!walletClient || !publicClient || !registryClone || !agentStatus?.walletAddress) return;
    setGrantingRegistry(true); setGrantError('');
    try {
      const hash = await walletClient.writeContract({
        address:      registryClone as `0x${string}`,
        abi:          ADD_AGENT_ABI,
        functionName: 'addAgent',
        args:         [agentStatus.walletAddress as `0x${string}`],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setRegistryGranted(true);
    } catch (err) {
      setGrantError(`Registry authorization failed: ${(err as Error).message}`);
    } finally { setGrantingRegistry(false); }
  }

  const isActivated = !!agentStatus?.walletAddress;
  const fullyAuthorized = payrollGranted && (registryGranted || !registryClone);

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#F8F9FA', overflow: 'hidden' }}>

      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header style={{ height: 60, flexShrink: 0, background: '#fff', borderBottom: '1px solid #E2E8F0', display: 'flex', alignItems: 'center', padding: '0 16px', position: 'relative', zIndex: 20 }}>
        <button onClick={() => setSidebarOpen(true)} aria-label="Open navigation"
          style={{ width: 38, height: 38, borderRadius: 8, border: '1px solid #E2E8F0', background: '#F8F9FA', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#475569', flexShrink: 0 }}>
          <ArrowLeft size={18} />
        </button>

        <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <AgentAvatar size={26} active={!!agentStatus?.active} />
          <span style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>AI Agent</span>
        </div>

        <div style={{ flex: 1 }} />

        <Link href="/ai-agent/manage" aria-label="Manage AI Agent"
          style={{ width: 38, height: 38, borderRadius: 8, border: '1px solid #E2E8F0', background: '#F8F9FA', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: '#475569' }}>
          <Settings2 size={18} />
        </Link>
      </header>

      {/* ── Main sidebar overlay ─────────────────────────────────────────── */}
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} userAddress={address} companyName={state.payrollSetup?.companyName} />

      {/* ── Page content ────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '40px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, maxWidth: 640, width: '100%', margin: '0 auto' }}>

        {/* Non-premium error */}
        {showPremiumError && !isPremiumUser && (
          <div style={{ width: '100%', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12, padding: '16px 20px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <p style={{ fontSize: 14, fontWeight: 600, color: '#DC2626', margin: '0 0 4px' }}>Could not activate agent</p>
              <p style={{ fontSize: 13, color: '#64748B', margin: 0, lineHeight: 1.6 }}>
                Please make sure you are on the premium plan.{' '}
                <Link href="/pricing" style={{ color: '#4F46E5', fontWeight: 600 }}>Go to pricing for more info</Link>
              </p>
            </div>
            <button onClick={() => setShowPremiumError(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', padding: 2, flexShrink: 0 }}><XIcon size={16} /></button>
          </div>
        )}

        {!isActivated ? (
          /* ── State A (free) / State B (premium, not yet activated) ───── */
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: isPremiumUser ? 28 : 20, width: '100%', marginTop: isPremiumUser ? 40 : 0 }}>
            <Button
              variant={isPremiumUser ? 'brand' : 'primary'}
              icon={activating ? <Loader2 size={isPremiumUser ? 18 : 14} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Power size={isPremiumUser ? 18 : 14} />}
              onClick={handleToggleAgent}
              loading={activating}
              size={isPremiumUser ? 'lg' : 'sm'}
              style={isPremiumUser ? { padding: '18px 44px', fontSize: 17 } : undefined}
            >
              Activate AI Agent
            </Button>

            {isPremiumUser ? (
              <Image
                src="/images/ai-agent-active-illustration.png"
                alt="AI Payroll Agent"
                width={300}
                height={300}
                style={{ objectFit: 'contain', maxWidth: '100%' }}
              />
            ) : (
              <div style={{ width: '100%', background: 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)', borderRadius: 16, padding: '28px 28px', textAlign: 'center' }}>
                <h3 style={{ color: '#fff', fontWeight: 800, fontSize: 17, marginBottom: 6 }}>Unlock Your AI Payroll Agent</h3>
                <p style={{ color: 'rgba(255,255,255,0.8)', fontSize: 14, lineHeight: 1.6, marginBottom: 18 }}>
                  Upgrade to Premium for autonomous payroll scheduling, AI-driven compliance checks, and 24/7 Onchain execution — one-time payment.
                </p>
                <Link href="/pricing" style={{ display: 'inline-block', padding: '11px 22px', borderRadius: 10, background: '#14B8A6', color: '#fff', fontSize: 14, fontWeight: 700, textDecoration: 'none' }}>View Pricing</Link>
              </div>
            )}
          </div>
        ) : (
          /* ── State C — activated: authorize the agent's wallet ───────── */
          <div style={{ width: '100%' }}>
            {!showChecklist ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, marginTop: 30 }}>
                <button
                  onClick={() => setShowChecklist(true)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '16px 32px', borderRadius: 14, border: 'none',
                    background: fullyAuthorized ? '#059669' : '#4F46E5', color: '#fff',
                    fontSize: 16, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  <Shield size={18} />
                  {fullyAuthorized ? 'Agent Authorized' : 'Authorize Agent Access'}
                </button>
                <p style={{ fontSize: 13, color: '#64748B', textAlign: 'center', maxWidth: 380 }}>
                  {fullyAuthorized
                    ? 'Your agent can execute payroll and update employee records on your behalf.'
                    : 'Your agent has its own wallet now. Grant it permission on your contracts to let it act for you.'}
                </p>
                <button onClick={handleToggleAgent} disabled={activating}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: 12, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 5 }}>
                  {activating ? <Loader2 size={12} style={{ animation: 'spin 0.7s linear infinite' }} /> : <PowerOff size={12} />} Deactivate agent
                </button>
              </div>
            ) : (
              <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, padding: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: '#EEF2FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Shield size={18} color="#4F46E5" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', margin: 0 }}>Authorize Agent Access</h3>
                    <p style={{ fontSize: 12, color: '#64748B', margin: 0 }}>Each step below sends one Onchain transaction from your own wallet.</p>
                  </div>
                  <button onClick={handleToggleAgent} disabled={activating} title="Deactivate agent"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', padding: 4, flexShrink: 0 }}>
                    {activating ? <Loader2 size={14} style={{ animation: 'spin 0.7s linear infinite' }} /> : <PowerOff size={14} />}
                  </button>
                </div>

                <div style={{ background: '#F8F9FA', borderRadius: 8, padding: '8px 14px', marginBottom: 16 }}>
                  <span style={{ fontSize: 11, color: '#64748B', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>Agent Wallet </span>
                  <code style={{ fontSize: 12, color: '#4F46E5', fontFamily: "'JetBrains Mono', monospace" }}>
                    {agentStatus!.walletAddress!.slice(0, 10)}…{agentStatus!.walletAddress!.slice(-8)}
                  </code>
                </div>
                {grantError && <div style={{ background: '#FEF2F2', borderRadius: 8, padding: '8px 14px', marginBottom: 12, fontSize: 13, color: '#DC2626' }}>{grantError}</div>}

                <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
                  {[
                    {
                      granted: payrollGranted, granting: grantingPayroll, onGrant: handleGrantPayroll, contract: payrollClone, step: '1',
                      label: 'Allow agent to run payroll',
                      sublabel: 'Sends a transaction giving your AI agent permission to execute payments from your MultiTokenPayroll contract.',
                    },
                    {
                      granted: registryGranted, granting: grantingRegistry, onGrant: handleGrantRegistry, contract: registryClone, step: '2',
                      label: 'Allow agent to update employee records',
                      sublabel: 'Sends a transaction giving your AI agent permission to write employee data to your personal Registry contract.',
                    },
                  ].map(({ granted, granting, onGrant, contract, label, sublabel, step }) => (
                    <div key={step} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderRadius: 12, border: `1.5px solid ${granted ? '#A7F3D0' : '#E2E8F0'}`, background: granted ? '#ECFDF5' : '#fff', gap: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                        <div style={{ width: 24, height: 24, borderRadius: '50%', background: granted ? '#059669' : '#E2E8F0', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
                          {granted ? <Check size={14} color="#fff" /> : <span style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8' }}>{step}</span>}
                        </div>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{label}</div>
                          <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 2, lineHeight: 1.5 }}>{sublabel}</div>
                        </div>
                      </div>
                      {!granted && contract ? (
                        <button onClick={onGrant} disabled={granting}
                          style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: '#4F46E5', color: '#fff', fontSize: 12, fontWeight: 600, cursor: granting ? 'not-allowed' : 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                          {granting ? <><Loader2 size={12} style={{ animation: 'spin 0.7s linear infinite' }} /> Signing…</> : 'Authorize'}
                        </button>
                      ) : !contract ? (
                        <span style={{ fontSize: 11, color: '#94A3B8', flexShrink: 0 }}>Not needed</span>
                      ) : null}
                    </div>
                  ))}
                </div>

                {fullyAuthorized && (
                  <div style={{ marginTop: 14, padding: '10px 16px', borderRadius: 10, background: '#ECFDF5', border: '1px solid #A7F3D0', fontSize: 13, fontWeight: 600, color: '#059669', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <CheckCircle2 size={16} /> Agent fully authorized and ready to execute payroll.
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
