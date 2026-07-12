'use client';
/**
 * @file app/ai-agent/page.tsx
 *
 * Three states for a premium user with a deployed clone:
 *
 *   1. NOT YET SETUP (status === 'none')
 *      Activation fires automatically on mount — no button. While the Circle
 *      developer-controlled wallet is provisioning, a spinner is shown. Once
 *      the agent wallet address is available, the setup wizard appears.
 *
 *   2. SETUP IN PROGRESS
 *      Two on-chain steps, each requiring a wallet signature:
 *        Step 1 — SaldenMultiTokenPayroll.addAgent(agentWallet)
 *                 Called by the Employer (owner). Grants the AI Agent
 *                 permission to call batchPay(), withdraw(), addSupportedToken().
 *        Step 2 — SaldenRegistry.addAgent(agentWallet)
 *                 Called by the HR Admin (hrAdmin). Grants the AI Agent
 *                 permission to call updateCID() so it can update the
 *                 employee database pointer on-chain after a payroll run.
 *
 *      Neither contract uses OpenZeppelin AccessControl or grantRole.
 *      Both use a custom addAgent/removeAgent + isAgent mapping pattern.
 *      See src/lib/contracts/agentAbis.ts for the verified ABI fragments.
 *
 *   3. ACTIVE (both addAgent calls confirmed on-chain)
 *      ChatInterface displayed directly. No activate button anywhere.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { CheckCircle2, ExternalLink, Copy } from 'lucide-react';
import { useWalletClient, usePublicClient } from 'wagmi';
import { AgentLayout }           from '@/components/agent/AgentLayout';
import ChatInterface             from '@/components/agent/ChatInterface';
import { useAgentStatus }        from '@/lib/useAgentStatus';
import { useEffectiveAddress }   from '@/lib/useEffectiveAddress';
import { useApp }                from '@/context/AppContext';
import { usePayrollSync }        from '@/lib/usePayrollSync';
import { txLink, CONTRACTS }     from '@/lib/contracts/config';
import {
  PAYROLL_ADD_AGENT_ABI,
  REGISTRY_ADD_AGENT_ABI,
} from '@/lib/contracts/agentAbis';
import { REGISTRY_FACTORY_ABI }  from '@/lib/contracts/abis';
import { useCloneAccess }        from '@/lib/useCloneAccess';
import type { ActivateResult }   from '@/lib/useAgentStatus';
import { copyToClipboard } from '@/lib/clipboard';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    const ok = await copyToClipboard(text);
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
  }
  return (
    <button onClick={copy} title="Copy address" style={{
      background: 'none', border: 'none', cursor: 'pointer',
      padding: 2, color: copied ? '#059669' : '#94A3B8', display: 'inline-flex',
    }}>
      <Copy size={13} />
    </button>
  );
}

function Spinner({ size = 32 }: { size?: number }) {
  return (
    <div style={{
      width: size, height: size,
      border: `${size > 20 ? 3 : 2}px solid #E2E8F0`,
      borderTopColor: '#4F46E5',
      borderRadius: '50%',
      animation: 'spin 0.8s linear infinite',
      margin: '0 auto',
    }} />
  );
}

type StepStatus = 'pending' | 'active' | 'done' | 'failed';

function SetupStep({
  index, title, description, status, children,
}: {
  index: number; title: string; description: string;
  status: StepStatus; children?: React.ReactNode;
}) {
  const palette = {
    pending: { bg: '#F8FAFC',  border: '#E2E8F0', numBg: '#F1F5F9', numColor: '#94A3B8' },
    active:  { bg: '#EEF2FF',  border: '#C7D2FE', numBg: '#4F46E5', numColor: '#fff'    },
    done:    { bg: '#F0FDF4',  border: '#6EE7B7', numBg: '#059669', numColor: '#fff'    },
    failed:  { bg: '#FEF2F2',  border: '#FCA5A5', numBg: '#DC2626', numColor: '#fff'    },
  }[status];

  return (
    <div style={{
      border: `1.5px solid ${palette.border}`, borderRadius: 14,
      padding: '18px 20px', background: palette.bg,
      display: 'flex', gap: 16,
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: '50%',
        background: palette.numBg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, fontWeight: 800, fontSize: 14, color: palette.numColor,
      }}>
        {status === 'done' ? <CheckCircle2 size={16} color="#fff" /> : index}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#0F172A', marginBottom: 3 }}>
          {title}
        </div>
        <div style={{
          fontSize: 12, color: '#64748B', lineHeight: 1.5,
          marginBottom: children ? 12 : 0,
        }}>
          {description}
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AIAgentPage() {
  const { state, dispatch } = useApp();
  const { address } = useEffectiveAddress();
  const { isPremiumUser, payrollClone, registryClone } = state;
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  // Deep-link support for chat-history/page.tsx: /ai-agent?session=<id>
  // resumes a saved conversation, /ai-agent?new=<timestamp> starts fresh.
  // `chatInstanceKey` forces ChatInterface to fully remount on either
  // transition rather than relying on internal effects to reconcile every
  // possible prop change cleanly.
  const [resumeSessionId, setResumeSessionId] = useState<string | undefined>(undefined);
  const [chatInstanceKey, setChatInstanceKey] = useState<string>('default');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const session = params.get('session');
    const fresh   = params.get('new');
    if (session) { setResumeSessionId(session); setChatInstanceKey(`session-${session}`); }
    else if (fresh) { setResumeSessionId(undefined); setChatInstanceKey(`new-${fresh}`); }
  }, []);

  // registryClone was previously only ever populated by dashboard/page.tsx's
  // factory lookup — landing (or refreshing) directly on /ai-agent left it
  // null, which meant employee data could never be restored here either.
  // Cheap read, no wallet signature required.
  useEffect(() => {
    if (registryClone || !address || !publicClient) return;
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
        }
      } catch {
        /* Non-fatal here — the chat/employee-context features degrade
           gracefully without a registryClone; the activation flow below
           has its own error handling for premium/clone checks. */
      }
    })();
    return () => { cancelled = true; };
  }, [registryClone, address, publicClient, dispatch]);

  // Self-healing fallback for payrollClone — single shared implementation,
  // see lib/useCloneAccess.ts for the full writeup (previously duplicated
  // inline here and in dashboard/page.tsx; consolidated into one hook).
  useCloneAccess();

  const payrollSync = usePayrollSync({ registryClone, address, publicClient, walletClient });

  const { status, agentInfo, error: statusError, activating, activate, refresh } = useAgentStatus();

  const [activateResult, setActivateResult] = useState<ActivateResult | null>(null);
  const [autoTriggered,  setAutoTriggered]  = useState(false);
  const [activateError,  setActivateError]  = useState<string | null>(null);

  // Step grant state
  const [step1Status, setStep1Status] = useState<StepStatus>('pending');
  const [step2Status, setStep2Status] = useState<StepStatus>('pending');
  const [step1Hash,   setStep1Hash]   = useState('');
  const [step2Hash,   setStep2Hash]   = useState('');
  const [step1Error,  setStep1Error]  = useState('');
  const [step2Error,  setStep2Error]  = useState('');

  // Was previously `cloneAddress ?? payrollClone ?? ''`, where cloneAddress
  // came from a useCloneAccess() that read a SaldenPayrollFactory contract
  // that was never actually deployed (NEXT_PUBLIC_PAYROLL_FACTORY_ADDRESS
  // was unset, so it always resolved against the zero address and
  // silently fell through to payrollClone anyway). That version was
  // deleted as dead code, then the on-chain fallback it was trying to do
  // was rebuilt correctly — pointed at the real, actually-deployed
  // SaldenMultiTokenPayrollFactory — as the useCloneAccess() call above,
  // which writes straight into payrollClone via AppContext. So by the
  // time this line runs, payrollClone is already the best answer
  // available; no extra fallback needed here.
  const effectiveClone    = payrollClone ?? '';
  const effectiveRegistry = registryClone ?? '';

  // ── Auto-trigger provisioning ─────────────────────────────────────────────
  useEffect(() => {
    if (
      !autoTriggered     &&
      isPremiumUser      &&
      effectiveClone     &&
      !activating        &&
      (status === 'none' || status === 'error')
    ) {
      setAutoTriggered(true);
      activate()
        .then(res => {
          if (res) {
            // Create a new object — never mutate the value returned by the hook
            const patched: ActivateResult = {
              ...res,
              grantRoleInstructions: {
                ...res.grantRoleInstructions,
                payrollClone:  res.grantRoleInstructions.payrollClone  || effectiveClone,
                registryClone: res.grantRoleInstructions.registryClone || effectiveRegistry,
              },
            };
            setActivateResult(patched);
            refresh();
          }
        })
        .catch(() => setActivateError('Agent setup failed. Please try again.'));
    }
  }, [
    isPremiumUser, effectiveClone, effectiveRegistry,
    status, activating, autoTriggered, activate, refresh,
  ]);

  // Surface a failed STATUS CHECK the same way a failed activate() call is
  // surfaced — reuses the existing "Agent Setup Failed" / Retry Setup UI
  // below rather than needing a second error UI. Guards on !activateError
  // so it doesn't clobber a more specific message from activate() itself.
  useEffect(() => {
    if (statusError && !activateError) setActivateError(statusError);
  }, [statusError, activateError]);

  // ── Step 1: SaldenMultiTokenPayroll.addAgent(agentWallet) ─────────────────
  // Called by the Employer (owner). Grants batchPay / withdraw / addSupportedToken.
  const grantPayrollAgent = useCallback(async () => {
    if (!walletClient || !publicClient || !activateResult) return;

    const agentAddr = activateResult.agentInfo.agentWallet as `0x${string}`;
    const cloneAddr = (
      activateResult.grantRoleInstructions.payrollClone || effectiveClone
    ) as `0x${string}`;

    if (!cloneAddr || !agentAddr) return;

    setStep1Status('active'); setStep1Error('');
    try {
      // Wallet popup will show:
      // "Call addAgent on your Salden Payroll contract to allow the AI Agent
      //  to execute payroll on your behalf"
      const hash = await walletClient.writeContract({
        address: cloneAddr,
        abi:     PAYROLL_ADD_AGENT_ABI,
        functionName: 'addAgent',
        args: [agentAddr],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setStep1Hash(hash);
      setStep1Status('done');
    } catch (err) {
      const raw = err instanceof Error ? err.message : '';
      setStep1Error(
        /reject|cancel|denied/i.test(raw) ? 'Transaction cancelled.' :
        /network|rpc/i.test(raw)          ? 'Network error. Try again.' :
        'Transaction failed. Please try again.',
      );
      setStep1Status('failed');
    }
  }, [walletClient, publicClient, activateResult, effectiveClone]);

  // ── Step 2: SaldenRegistry.addAgent(agentWallet) ─────────────────────────
  // Called by hrAdmin. Grants updateCID so the agent can update the
  // employee database pointer after writes.
  const grantRegistryAgent = useCallback(async () => {
    if (!walletClient || !publicClient || !activateResult) return;

    const agentAddr = activateResult.agentInfo.agentWallet as `0x${string}`;
    const regAddr   = (
      activateResult.grantRoleInstructions.registryClone || effectiveRegistry
    ) as `0x${string}`;

    if (!regAddr || !agentAddr) return;

    setStep2Status('active'); setStep2Error('');
    try {
      // Wallet popup will show:
      // "Call addAgent on your Salden Registry contract to allow the AI Agent
      //  to update the employee database on-chain on your behalf"
      const hash = await walletClient.writeContract({
        address: regAddr,
        abi:     REGISTRY_ADD_AGENT_ABI,
        functionName: 'addAgent',
        args: [agentAddr],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setStep2Hash(hash);
      setStep2Status('done');
    } catch (err) {
      const raw = err instanceof Error ? err.message : '';
      setStep2Error(
        /reject|cancel|denied/i.test(raw) ? 'Transaction cancelled.' :
        /network|rpc/i.test(raw)          ? 'Network error. Try again.' :
        'Transaction failed. Please try again.',
      );
      setStep2Status('failed');
    }
  }, [walletClient, publicClient, activateResult, effectiveRegistry]);

  const bothDone = step1Status === 'done' && step2Status === 'done';

  useEffect(() => {
    if (bothDone) {
      const t = setTimeout(refresh, 1500);
      return () => clearTimeout(t);
    }
  }, [bothDone, refresh]);

  // ── No wallet ─────────────────────────────────────────────────────────────
  if (!address) {
    return (
      <AgentLayout title="AI Agent">
        <div style={{ textAlign: 'center', padding: '80px 20px' }}>
          <div style={{
            width: 56, height: 56, borderRadius: 16, background: '#EEF2FF',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 20px',
          }}>
            <svg width="24" height="24" fill="none" stroke="#4F46E5" strokeWidth="2" viewBox="0 0 24 24">
              <rect x="2" y="7" width="20" height="14" rx="2"/>
              <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
            </svg>
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', marginBottom: 8 }}>
            Connect your wallet
          </h2>
          <p style={{ fontSize: 14, color: '#64748B' }}>
            Connect your wallet to access the AI Payroll Agent.
          </p>
        </div>
      </AgentLayout>
    );
  }

  // ── Not premium ───────────────────────────────────────────────────────────
  if (!isPremiumUser) {
    return (
      <AgentLayout title="AI Agent">
        <div style={{
          background: 'linear-gradient(135deg, #1E3A5F 0%, #4F46E5 100%)',
          borderRadius: 20, padding: '48px 32px', textAlign: 'center', color: '#fff',
        }}>
          <div style={{
            width: 64, height: 64, borderRadius: 18,
            background: 'rgba(255,255,255,0.12)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 20px',
          }}>
            <svg width="28" height="28" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="3"/>
              <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
            </svg>
          </div>
          <h2 style={{ fontSize: 22, fontWeight: 800, marginBottom: 12 }}>
            Unlock Your AI Payroll Agent
          </h2>
          <p style={{
            fontSize: 14, color: 'rgba(255,255,255,0.8)', lineHeight: 1.7,
            maxWidth: 420, margin: '0 auto 28px',
          }}>
            Upgrade to Premium for autonomous payroll scheduling, AI-driven compliance
            checks, Gemini 2.5 Flash chat, and 24/7 on-chain execution.
          </p>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 10,
            maxWidth: 320, margin: '0 auto 28px', textAlign: 'left',
          }}>
            {[
              'Autonomous batch payroll via batchPay()',
              'Real on-chain balance & compliance checks',
              'Structured function-calling AI (not just chat)',
              'IPFS employee database with on-chain CID anchoring',
              'Automatic invoice emails from contact@salden.xyz',
            ].map((f, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                fontSize: 13, color: 'rgba(255,255,255,0.85)',
              }}>
                <CheckCircle2 size={15} color="#6EE7B7" style={{ flexShrink: 0, marginTop: 1 }} />
                {f}
              </div>
            ))}
          </div>
          <Link href="/pricing" style={{
            display: 'inline-block', padding: '13px 32px', borderRadius: 12,
            background: '#14B8A6', color: '#fff', fontSize: 15, fontWeight: 700,
            textDecoration: 'none',
          }}>
            View Pricing →
          </Link>
        </div>
      </AgentLayout>
    );
  }

  // ── Loading / clone check ──────────────────────────────────────────────────
  if (status === 'loading') {
    return (
      <AgentLayout title="AI Agent">
        <div style={{ textAlign: 'center', padding: '80px 20px' }}>
          <Spinner />
          <p style={{ fontSize: 14, color: '#64748B', marginTop: 16 }}>
            Loading agent status…
          </p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </AgentLayout>
    );
  }

  // ── No clone deployed yet ─────────────────────────────────────────────────
  if (!effectiveClone) {
    return (
      <AgentLayout title="AI Agent">
        <div style={{
          background: '#fff', border: '1px solid #E2E8F0',
          borderRadius: 20, padding: 36, textAlign: 'center',
        }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>🏭</div>
          <h3 style={{ fontSize: 18, fontWeight: 800, color: '#0F172A', marginBottom: 8 }}>
            No Payroll Contract Found
          </h3>
          <p style={{
            fontSize: 14, color: '#64748B', lineHeight: 1.7,
            maxWidth: 360, margin: '0 auto 20px',
          }}>
            The AI Agent requires a deployed SaldenMultiTokenPayroll clone.
            Complete your payroll setup on the dashboard first.
          </p>
          <Link href="/dashboard" style={{
            display: 'inline-block', padding: '11px 24px', borderRadius: 10,
            background: '#4F46E5', color: '#fff', fontSize: 14, fontWeight: 700,
            textDecoration: 'none',
          }}>
            Go to Dashboard →
          </Link>
        </div>
      </AgentLayout>
    );
  }

  // ── Auto-activating ────────────────────────────────────────────────────────
  if (activating || (autoTriggered && !activateResult && !activateError && status === 'none')) {
    return (
      <AgentLayout title="AI Agent">
        <div style={{
          background: '#fff', border: '1px solid #E2E8F0',
          borderRadius: 20, padding: 40, textAlign: 'center',
        }}>
          <Spinner size={40} />
          <h3 style={{
            fontSize: 17, fontWeight: 800, color: '#0F172A',
            marginTop: 20, marginBottom: 8,
          }}>
            Setting up your AI Agent…
          </h3>
          <p style={{
            fontSize: 13, color: '#64748B', lineHeight: 1.6,
            maxWidth: 340, margin: '0 auto',
          }}>
            Provisioning a secure agent wallet via Circle. This takes a few seconds.
          </p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </AgentLayout>
    );
  }

  // ── Activation error ───────────────────────────────────────────────────────
  if (activateError) {
    return (
      <AgentLayout title="AI Agent">
        <div style={{
          background: '#FEF2F2', border: '1.5px solid #FCA5A5',
          borderRadius: 20, padding: 32, textAlign: 'center',
        }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
          <h3 style={{ fontSize: 17, fontWeight: 800, color: '#DC2626', marginBottom: 8 }}>
            Agent Setup Failed
          </h3>
          <p style={{
            fontSize: 13, color: '#991B1B', lineHeight: 1.6,
            maxWidth: 400, margin: '0 auto 20px',
          }}>
            {activateError}
          </p>
          <button
            onClick={() => { setAutoTriggered(false); setActivateError(null); }}
            style={{
              padding: '10px 24px', borderRadius: 10,
              background: '#DC2626', color: '#fff',
              border: 'none', cursor: 'pointer',
              fontSize: 14, fontWeight: 700, fontFamily: 'inherit',
            }}
          >
            Retry Setup
          </button>
        </div>
      </AgentLayout>
    );
  }

  // ── Setup wizard (agent wallet provisioned, on-chain grants still needed) ──
  if (activateResult && status !== 'active' && !bothDone) {
    const ai    = activateResult.agentInfo;
    const grant = activateResult.grantRoleInstructions;

    return (
      <AgentLayout title="AI Agent">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', marginBottom: 4 }}>
              Grant Agent Permissions
            </h2>
            <p style={{ fontSize: 13, color: '#64748B' }}>
              Your agent wallet is ready. Sign two transactions to grant it the
              permissions it needs to run payroll and update employee records on your behalf.
            </p>
          </div>

          {/* Agent wallet confirmation */}
          <div style={{
            background: '#F0FDF4', border: '1.5px solid #6EE7B7',
            borderRadius: 14, padding: '16px 18px',
          }}>
            <div style={{
              fontSize: 11, fontWeight: 700, color: '#059669',
              letterSpacing: '0.05em', marginBottom: 6,
            }}>
              ✓ AGENT WALLET READY
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 13, color: '#0F172A',
              }}>
                {ai.agentWallet.slice(0, 18)}…{ai.agentWallet.slice(-8)}
              </span>
              <CopyButton text={ai.agentWallet} />
            </div>
            <p style={{ fontSize: 12, color: '#64748B', marginTop: 6, marginBottom: 0 }}>
              Top up this wallet with testnet USDC for gas fees. After setup, ask the agent
              "top up my agent wallet" to request testnet USDC.
            </p>
          </div>

          {/* Step 1 — addAgent on payroll clone */}
          <SetupStep
            index={1}
            title="Authorise Agent — Payroll Contract"
            description={
              `Calls addAgent(${ai.agentWallet.slice(0, 8)}…) on your ` +
              `SaldenMultiTokenPayroll clone (${(grant.payrollClone || effectiveClone).slice(0, 10)}…). ` +
              `This allows the AI Agent to execute batchPay() on your behalf. ` +
              `Only you (the contract owner) can call this.`
            }
            status={step1Status}
          >
            {step1Status === 'pending' && (
              <button
                onClick={grantPayrollAgent}
                style={{
                  padding: '9px 20px', borderRadius: 9,
                  background: '#4F46E5', color: '#fff',
                  border: 'none', cursor: 'pointer',
                  fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                }}
              >
                Sign Transaction →
              </button>
            )}
            {step1Status === 'active' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#4338CA' }}>
                <Spinner size={14} /> Waiting for confirmation on-chain…
              </div>
            )}
            {step1Status === 'done' && (
              <a
                href={txLink(step1Hash)} target="_blank" rel="noreferrer"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  fontSize: 12, color: '#059669', fontWeight: 600,
                }}
              >
                View transaction <ExternalLink size={11} />
              </a>
            )}
            {step1Status === 'failed' && (
              <div style={{ fontSize: 12, color: '#DC2626', marginTop: 4 }}>
                {step1Error}
                <button
                  onClick={grantPayrollAgent}
                  style={{
                    marginLeft: 10, background: 'none', border: 'none',
                    cursor: 'pointer', color: '#DC2626', fontWeight: 700,
                    fontSize: 12, fontFamily: 'inherit', textDecoration: 'underline',
                  }}
                >
                  Retry
                </button>
              </div>
            )}
          </SetupStep>

          {/* Step 2 — addAgent on registry clone */}
          <SetupStep
            index={2}
            title="Authorise Agent — Registry Contract"
            description={
              `Calls addAgent(${ai.agentWallet.slice(0, 8)}…) on your ` +
              `SaldenRegistry clone (${(grant.registryClone || effectiveRegistry || 'not found').slice(0, 10)}…). ` +
              `This allows the AI Agent to update the IPFS employee database pointer ` +
              `on-chain after each payroll run. Only you (HR Admin) can call this.`
            }
            status={step1Status !== 'done' ? 'pending' : step2Status}
          >
            {step1Status === 'done' && step2Status === 'pending' && (
              <button
                onClick={grantRegistryAgent}
                style={{
                  padding: '9px 20px', borderRadius: 9,
                  background: '#4F46E5', color: '#fff',
                  border: 'none', cursor: 'pointer',
                  fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
                }}
              >
                Sign Transaction →
              </button>
            )}
            {step2Status === 'active' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#4338CA' }}>
                <Spinner size={14} /> Waiting for confirmation on-chain…
              </div>
            )}
            {step2Status === 'done' && (
              <a
                href={txLink(step2Hash)} target="_blank" rel="noreferrer"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  fontSize: 12, color: '#059669', fontWeight: 600,
                }}
              >
                View transaction <ExternalLink size={11} />
              </a>
            )}
            {step2Status === 'failed' && (
              <div style={{ fontSize: 12, color: '#DC2626', marginTop: 4 }}>
                {step2Error}
                <button
                  onClick={grantRegistryAgent}
                  style={{
                    marginLeft: 10, background: 'none', border: 'none',
                    cursor: 'pointer', color: '#DC2626', fontWeight: 700,
                    fontSize: 12, fontFamily: 'inherit', textDecoration: 'underline',
                  }}
                >
                  Retry
                </button>
              </div>
            )}
          </SetupStep>

          {/* Both done — waiting for status refresh */}
          {bothDone && (
            <div style={{
              background: '#EEF2FF', border: '1.5px solid #C7D2FE',
              borderRadius: 14, padding: 18,
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <Spinner size={18} />
              <span style={{ fontSize: 13, color: '#4338CA', fontWeight: 600 }}>
                Both permissions granted — activating chat interface…
              </span>
            </div>
          )}
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </AgentLayout>
    );
  }

  // ── Active — show ChatInterface ───────────────────────────────────────────
  return (
    <AgentLayout title="AI Agent">
      <div style={{
        display: 'flex', flexDirection: 'column',
        gap: 16, height: 'calc(100vh - 120px)',
      }}>
        {payrollSync.syncAvailable && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: '#EEF2FF', border: '1px solid #C7D2FE', borderRadius: 10,
            padding: '8px 14px', fontSize: 12, flexShrink: 0,
          }}>
            <span style={{ color: '#3730A3', fontWeight: 600 }}>
              Newer payroll data is available on this account.
            </span>
            <button
              onClick={() => { void payrollSync.syncNow(); }}
              disabled={payrollSync.status === 'loading'}
              style={{
                padding: '5px 12px', borderRadius: 7, background: '#4F46E5', color: '#fff',
                fontSize: 12, fontWeight: 700, border: 'none',
                cursor: payrollSync.status === 'loading' ? 'default' : 'pointer',
                opacity: payrollSync.status === 'loading' ? 0.6 : 1, fontFamily: 'inherit',
              }}
            >
              {payrollSync.status === 'loading' ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0 }}>
          <ChatInterface
            key={chatInstanceKey}
            walletAddress={address ?? ''}
            onDataChanged={refresh}
            agentAddress={agentInfo?.agentWallet}
            agentActive={status === 'active'}
            agentWalletId={agentInfo?.walletId}
            sessionId={resumeSessionId}
          />
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </AgentLayout>
  );
}
