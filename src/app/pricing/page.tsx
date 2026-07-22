'use client';
/**
 * @file app/pricing/page.tsx
 * All feature claims verified against deployed contracts:
 *  - SaldenEnterprisePayroll.MAX_BATCH_SIZE  = 100   (contract-enforced)
 *  - SaldenMultiTokenPayroll.MAX_BATCH_SIZE  = 1,000 (contract-enforced)
 *  - SaldenRegistryFactory.createRegistry()  = open to all (no fee, no gate)
 *  - Group management = frontend UI feature  = available to all users
 *  - emergencyWithdraw exists only in SaldenMultiTokenPayroll (premium clone)
 */

import { useState } from 'react';
import { usePublicClient } from 'wagmi';
import {
  CheckCircle2, Zap, Users, Bot, Shield, Globe,
  Loader2, ArrowRight, Lock, Star,
} from 'lucide-react';
import { AppLayout }          from '@/components/layout/AppLayout';
import { useApp }             from '@/context/AppContext';
import { CONTRACTS, txLink, arcTestnet } from '@/lib/contracts/config';
import { MULTI_TOKEN_FACTORY_ABI, ERC20_ABI } from '@/lib/contracts/abis';
import { trackClientEvent } from '@/lib/analyticsClient';
import { useEffectiveAddress, walletRequiredMessage } from '@/lib/useEffectiveAddress';
import { waitForSuccessfulReceipt } from '@/lib/txReceipt';
import { useUniversalWrite } from '@/lib/circle/useUniversalWrite';
import { useCloneAccess } from '@/lib/useCloneAccess';

// ── Feature comparison row ─────────────────────────────────────────────────────
function Row({ label, free, premium }: { label: string; free: boolean | string; premium: boolean | string }) {
  const icon = (val: boolean | string) =>
    val === false
      ? <span style={{ color: '#CBD5E1', fontSize: 16, fontWeight: 700, display: 'block', textAlign: 'center' }}>×</span>
      : val === true
        ? <CheckCircle2 size={16} color="#059669" style={{ display: 'block', margin: '0 auto' }} />
        : <span style={{ fontSize: 12, fontWeight: 700, color: '#059669', display: 'block', textAlign: 'center' }}>{val}</span>;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px 130px', padding: '12px 24px', borderBottom: '1px solid #F1F5F9', alignItems: 'center' }}>
      <span style={{ fontSize: 14, color: '#475569' }}>{label}</span>
      <div>{icon(free)}</div>
      <div>{icon(premium)}</div>
    </div>
  );
}

type DeployStep = 'idle' | 'approving' | 'deploying' | 'done' | 'error';

export default function PricingPage() {
  const { address, loginMethod } = useEffectiveAddress();
  const { writeContract: universalWrite, canWrite } = useUniversalWrite();
  const publicClient     = usePublicClient({ chainId: arcTestnet.id });
  const { state, dispatch, addToast } = useApp();
  const { isPremiumUser } = state;
  useCloneAccess();

  const [step,   setStep]   = useState<DeployStep>('idle');
  const [txHash, setTxHash] = useState('');
  const [errMsg, setErrMsg] = useState('');

  async function handleUpgrade() {
    if (!address || !canWrite || !publicClient) { addToast(walletRequiredMessage(loginMethod), 'error'); return; }
    if (isPremiumUser) { addToast('You are already on the Premium plan.', 'info'); return; }

    setStep('approving'); setErrMsg('');
    try {
      // Fresh on-chain check — not just the (possibly stale, or not-yet-
      // resolved) local isPremiumUser flag. SaldenMultiTokenPayrollFactory
      // only allows one clone per address; calling deployPayroll() again
      // for an address that already has one reverts on-chain with no
      // human-readable reason (viem shows this as "execution reverted for
      // an unknown reason"). Checking payrollOf() directly here — instead
      // of relying solely on useCloneAccess's effect, which may not have
      // resolved yet if the user lands on /pricing first and clicks
      // Upgrade immediately — closes that race and avoids ever sending a
      // transaction that's guaranteed to fail.
      const existingClone = await publicClient.readContract({
        address: CONTRACTS.MULTI_TOKEN_FACTORY, abi: MULTI_TOKEN_FACTORY_ABI, functionName: 'payrollOf', args: [address],
      }) as string;

      if (existingClone && existingClone !== '0x0000000000000000000000000000000000000000') {
        dispatch({ type: 'SET_PAYROLL_CLONE', payload: existingClone });
        addToast('You already have a Premium payroll contract — activating it now.', 'info');
        setStep('idle');
        return;
      }

      const deployFee = await publicClient.readContract({
        address: CONTRACTS.MULTI_TOKEN_FACTORY, abi: MULTI_TOKEN_FACTORY_ABI, functionName: 'deployFee',
      }) as bigint;

      const allowance = await publicClient.readContract({
        address: CONTRACTS.USDC, abi: ERC20_ABI, functionName: 'allowance',
        args: [address, CONTRACTS.MULTI_TOKEN_FACTORY],
      }) as bigint;

      if (allowance < deployFee) {
        const approveTx = await universalWrite({
          address: CONTRACTS.USDC, abi: ERC20_ABI, functionName: 'approve',
          args: [CONTRACTS.MULTI_TOKEN_FACTORY, deployFee],
        });
        await waitForSuccessfulReceipt(publicClient, approveTx);
      }

      setStep('deploying');
      const deployTx = await universalWrite({
        address: CONTRACTS.MULTI_TOKEN_FACTORY, abi: MULTI_TOKEN_FACTORY_ABI, functionName: 'deployPayroll', args: [],
      });
      await waitForSuccessfulReceipt(publicClient, deployTx);
      setTxHash(deployTx);

      const cloneAddr = await publicClient.readContract({
        address: CONTRACTS.MULTI_TOKEN_FACTORY, abi: MULTI_TOKEN_FACTORY_ABI, functionName: 'payrollOf', args: [address],
      }) as string;

      dispatch({ type: 'SET_PAYROLL_CLONE', payload: cloneAddr });
      dispatch({ type: 'SET_PREMIUM',       payload: true        });
      trackClientEvent({ event: 'user_upgraded', walletAddress: address, txHash: deployTx });
      setStep('done');
      addToast('Premium activated. Your private payroll contract is ready.', 'success', 8000);
    } catch (err) {
      setErrMsg((err as Error).message ?? 'Transaction failed.');
      setStep('error');
    }
  }

  const isLoading = step === 'approving' || step === 'deploying';

  return (
    <AppLayout title="Pricing">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>

        {/* Header */}
        <div style={{ textAlign: 'center', padding: '16px 0 8px' }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: '#0F172A', marginBottom: 10 }}>
            One platform, two tiers
          </h1>
          <p style={{ fontSize: 15, color: '#64748B', maxWidth: 480, margin: '0 auto', lineHeight: 1.7 }}>
            Start with the free tier and upgrade once for lifetime access to your private payroll contract, AI Agent, and multi-token support.
          </p>
        </div>

        {/* Plan cards */}
        <div className="pricing-plan-grid" style={{ display: 'grid', gap: 20, maxWidth: 820, margin: '0 auto', width: '100%' }}>

          {/* Free */}
          <div style={{ background: '#fff', border: isPremiumUser ? '1px solid #E2E8F0' : '2px solid #4F46E5', borderRadius: 20, padding: '32px 28px' }}>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Free</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 42, fontWeight: 800, color: '#0F172A' }}>$0</span>
                <span style={{ fontSize: 14, color: '#94A3B8' }}>forever</span>
              </div>
              <p style={{ fontSize: 13, color: '#64748B', marginTop: 8, lineHeight: 1.65 }}>
                Shared Onchain payroll contract. A solid starting point for small teams.
              </p>
            </div>

            {[
              'Shared SaldenEnterprisePayroll contract',
              'USDC payments',
              'Up to 100 employees per batch',
              'Encrypted IPFS employee registry',
              'Group management',
              'Basic compliance checks',
              'Transaction history',
              'Email OTP login',
            ].map(f => (
              <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <CheckCircle2 size={15} color="#94A3B8" />
                <span style={{ fontSize: 13, color: '#64748B' }}>{f}</span>
              </div>
            ))}

            <div style={{ marginTop: 24 }}>
              {isPremiumUser ? (
                <div style={{ padding: '11px 0', textAlign: 'center', borderRadius: 10, background: '#F8F9FA', border: '1px solid #E2E8F0', fontSize: 14, fontWeight: 500, color: '#94A3B8' }}>
                  Included with Premium
                </div>
              ) : (
                <div style={{ padding: '11px 0', textAlign: 'center', borderRadius: 10, background: '#EEF2FF', fontSize: 14, fontWeight: 700, color: '#4F46E5' }}>
                  Current Plan
                </div>
              )}
            </div>
          </div>

          {/* Premium */}
          <div style={{ background: 'linear-gradient(145deg, #4F46E5 0%, #6D28D9 100%)', borderRadius: 20, padding: '32px 28px', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: -40, right: -40, width: 160, height: 160, borderRadius: '50%', background: 'rgba(255,255,255,0.08)', pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', top: 16, right: 20, background: '#14B8A6', color: '#fff', padding: '3px 12px', borderRadius: 99, fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Lifetime
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Premium</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 42, fontWeight: 800, color: '#fff' }}>$10</span>
                <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)' }}>one-time · USDC</span>
              </div>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)', marginTop: 8, lineHeight: 1.65 }}>
                Your own private payroll contract, unlimited tokens, and full AI Agent access. Permanently.
              </p>
            </div>

            {[
              { icon: <Zap    size={14} />, text: 'Private SaldenMultiTokenPayroll clone'     },
              { icon: <Globe  size={14} />, text: 'USDC and any ERC-20 token support'          },
              { icon: <Users  size={14} />, text: 'Up to 1,000 employees per batch'            },
              { icon: <Bot    size={14} />, text: 'Full AI Agent with scheduling and automation'},
              { icon: <Shield size={14} />, text: 'Automated compliance scheduling'            },
              { icon: <Lock   size={14} />, text: 'Emergency withdrawal from your clone'       },
              { icon: <Star   size={14} />, text: 'Priority support and all future features'   },
            ].map(({ icon, text }) => (
              <div key={text} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <div style={{ color: '#14B8A6', flexShrink: 0 }}>{icon}</div>
                <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.88)' }}>{text}</span>
              </div>
            ))}

            <div style={{ marginTop: 24 }}>
              {isPremiumUser ? (
                <div style={{ padding: '12px 0', textAlign: 'center', borderRadius: 10, background: 'rgba(255,255,255,0.15)', fontSize: 14, fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <CheckCircle2 size={16} color="#14B8A6" /> Premium Active
                </div>
              ) : (
                <>
                  <button
                    onClick={handleUpgrade}
                    disabled={isLoading || !address}
                    style={{ width: '100%', padding: '13px 0', borderRadius: 10, border: 'none', background: '#14B8A6', color: '#fff', fontSize: 15, fontWeight: 700, cursor: isLoading || !address ? 'not-allowed' : 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: !address ? 0.7 : 1 }}
                  >
                    {isLoading
                      ? <><Loader2 size={16} style={{ animation: 'spin 0.7s linear infinite' }} /> {step === 'approving' ? 'Approving USDC…' : 'Deploying contract…'}</>
                      : <><Zap size={16} /> Upgrade for $10 USDC</>
                    }
                  </button>
                  {!address && (
                    <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', textAlign: 'center', marginTop: 8 }}>
                      Connect your wallet to upgrade
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Transaction result */}
        {step === 'done' && txHash && (
          <div style={{ background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 14, padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12, maxWidth: 820, margin: '0 auto', width: '100%' }}>
            <CheckCircle2 size={20} color="#059669" style={{ flexShrink: 0 }} />
            <div>
              <p style={{ fontSize: 14, fontWeight: 700, color: '#059669', margin: '0 0 2px' }}>Premium activated successfully</p>
              <a href={txLink(txHash)} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#059669', display: 'flex', alignItems: 'center', gap: 4, textDecoration: 'none' }}>
                View on ArcScan <ArrowRight size={12} />
              </a>
            </div>
          </div>
        )}

        {step === 'error' && errMsg && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 14, padding: '14px 20px', fontSize: 13, color: '#DC2626', maxWidth: 820, margin: '0 auto', width: '100%' }}>
            {errMsg}
          </div>
        )}

        {/* Feature comparison table */}
        <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, overflow: 'hidden', maxWidth: 820, margin: '0 auto', width: '100%' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px 130px', padding: '14px 24px', borderBottom: '1px solid #E2E8F0', background: '#F8F9FA' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Feature</span>
            <div style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Free</div>
            <div style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, color: '#4F46E5', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Premium</div>
          </div>

          {/* Every claim below is verified against deployed contract source */}
          <Row label="Private payroll contract"          free={false}            premium={true}          />
          <Row label="Max employees per batch"           free="100"              premium="1,000"         />
          <Row label="USDC payments"                     free={true}             premium={true}          />
          <Row label="Multi-token (any ERC-20)"          free={false}            premium={true}          />
          <Row label="AI Agent"                          free={false}            premium={true}          />
          <Row label="Scheduled payroll runs"            free={false}            premium={true}          />
          <Row label="Encrypted IPFS employee registry"  free={true}             premium={true}          />
          <Row label="Group management"                  free={true}             premium={true}          />
          <Row label="Compliance checks"                 free="Manual only"      premium="Automated"     />
          <Row label="Emergency withdrawal"              free={false}            premium={true}          />
          <Row label="Invoice emails"                    free={true}             premium={true}          />
          <Row label="Transaction history"               free={true}             premium={true}          />
          <Row label="Compliance dashboard"              free={true}             premium={true}          />
          <Row label="Cost"                              free="Free"             premium="$10 one-time"  />
        </div>

      </div>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .pricing-plan-grid { grid-template-columns: 1fr 1fr; }
        @media (max-width: 640px) {
          .pricing-plan-grid { grid-template-columns: 1fr; }
        }
      `}</style>
    </AppLayout>
  );
}
