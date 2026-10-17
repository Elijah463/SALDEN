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

import { useState, useEffect } from 'react';
import { usePublicClient } from 'wagmi';
import { formatUnits } from 'viem';
import {
  CheckCircle2, Zap, Users, Bot, Shield, Globe,
  Loader2, ArrowRight, Lock, Star,
} from 'lucide-react';
import { AppLayout }          from '@/components/layout/AppLayout';
import { NetworkGuard }       from '@/components/shared/NetworkGuard';
import { useApp }             from '@/context/AppContext';
import { CONTRACTS, txLink, arcChain } from '@/lib/contracts/config';
import { MULTI_TOKEN_FACTORY_ABI } from '@/lib/contracts/abis';
import { trackClientEvent } from '@/lib/analyticsClient';
import { useEffectiveAddress, walletRequiredMessage } from '@/lib/useEffectiveAddress';
import { waitForSuccessfulReceipt } from '@/lib/txReceipt';
import { useUniversalWrite } from '@/lib/circle/useUniversalWrite';
import { useTokenApproval } from '@/lib/approvals/useTokenApproval';
import { useCloneAccess } from '@/lib/useCloneAccess';
import { writeCloneCache } from '@/lib/cloneCache';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** The wallet's payroll clone from the factory, or null if it has none. */
async function readClone(client: NonNullable<ReturnType<typeof usePublicClient>>, wallet: string): Promise<string | null> {
  const clone = await client.readContract({
    address: CONTRACTS.MULTI_TOKEN_FACTORY, abi: MULTI_TOKEN_FACTORY_ABI,
    functionName: 'payrollOf', args: [wallet as `0x${string}`],
  }) as string;
  return clone && clone.toLowerCase() !== ZERO_ADDRESS ? clone : null;
}

/** Unix seconds when the clone's subscription ends (0 if never paid). */
async function readExpiry(client: NonNullable<ReturnType<typeof usePublicClient>>, clone: string): Promise<number> {
  const expiry = await client.readContract({
    address: CONTRACTS.MULTI_TOKEN_FACTORY, abi: MULTI_TOKEN_FACTORY_ABI,
    functionName: 'proExpiry', args: [clone as `0x${string}`],
  }) as bigint;
  return Number(expiry);
}
import { friendlyErrorMessage } from '@/lib/errorMessage';

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
  const { ensureApproval, invalidateApproval } = useTokenApproval();
  const publicClient     = usePublicClient({ chainId: arcChain.id });
  const { state, dispatch, addToast } = useApp();
  const { isPremiumUser } = state;
  useCloneAccess();

  // Upgrade price is read live from the factory's deployFee() so an on-chain
  // change is reflected here without a redeploy. $1.99 is only the fallback
  // shown until the read completes (or if it fails).
  const [priceUsdc, setPriceUsdc] = useState<number>(1.99);
  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    (async () => {
      try {
        const fee = await publicClient.readContract({
          address: CONTRACTS.MULTI_TOKEN_FACTORY, abi: MULTI_TOKEN_FACTORY_ABI, functionName: 'deployFee',
        }) as bigint;
        if (!cancelled) setPriceUsdc(Number(formatUnits(fee, 6)));
      } catch { /* keep the fallback */ }
    })();
    return () => { cancelled = true; };
  }, [publicClient]);

  const [step,   setStep]   = useState<DeployStep>('idle');
  const [txHash, setTxHash] = useState('');
  const [errMsg, setErrMsg] = useState('');

  async function handleUpgrade() {
    if (!address || !canWrite || !publicClient) { addToast(walletRequiredMessage(loginMethod), 'error'); return; }

    setStep('approving'); setErrMsg('');
    try {
      // The chain is the only source of truth: whether a clone exists, and whether its
      // subscription is still running. Local state can be stale.
      const existingClone = await readClone(publicClient, address);
      if (existingClone) {
        const expiresAt = await readExpiry(publicClient, existingClone);
        if (expiresAt > Math.floor(Date.now() / 1000)) {
          dispatch({ type: 'SET_PAYROLL_CLONE', payload: existingClone });
          dispatch({ type: 'SET_PRO_STATUS',    payload: { expiresAt } });
          writeCloneCache(address, { payrollClone: existingClone });
          addToast('Your Salden Pro subscription is already active.', 'info');
          setStep('idle');
          return;
        }
      }

      // Either a first purchase (deployPayroll) or a renewal of a lapsed clone (renewPro).
      // A clone that already exists must never go through deployPayroll: it reverts.
      const fee = await publicClient.readContract({
        address: CONTRACTS.MULTI_TOKEN_FACTORY, abi: MULTI_TOKEN_FACTORY_ABI, functionName: 'deployFee',
      }) as bigint;

      await ensureApproval({
        token: CONTRACTS.USDC as `0x${string}`, spender: CONTRACTS.MULTI_TOKEN_FACTORY as `0x${string}`, amount: fee,
      });

      setStep('deploying');
      const tx = existingClone
        ? await universalWrite({
            address: CONTRACTS.MULTI_TOKEN_FACTORY, abi: MULTI_TOKEN_FACTORY_ABI,
            functionName: 'renewPro', args: [existingClone as `0x${string}`],
          })
        : await universalWrite({
            address: CONTRACTS.MULTI_TOKEN_FACTORY, abi: MULTI_TOKEN_FACTORY_ABI,
            functionName: 'deployPayroll', args: [],
          });
      await waitForSuccessfulReceipt(publicClient, tx);
      setTxHash(tx);

      const clone = existingClone ?? await readClone(publicClient, address);
      if (!clone) throw new Error('Payroll contract not found after the transaction.');
      const expiresAt = await readExpiry(publicClient, clone);

      dispatch({ type: 'SET_PAYROLL_CLONE', payload: clone });
      dispatch({ type: 'SET_PRO_STATUS',    payload: { expiresAt } });
      writeCloneCache(address, { payrollClone: clone });
      trackClientEvent({ event: 'user_upgraded', walletAddress: address, txHash: tx });
      setStep('done');
      addToast(
        existingClone
          ? 'Salden Pro renewed for another year.'
          : 'Salden Pro activated. Your private payroll contract is ready.',
        'success', 8000,
      );
    } catch (err) {
      // An allowance-related revert means the cached approval was wrong. Clear it so the
      // next attempt re-checks on chain.
      if (/TransferFromFailed/i.test(String(err))) {
        void invalidateApproval(CONTRACTS.USDC as `0x${string}`, CONTRACTS.MULTI_TOKEN_FACTORY as `0x${string}`);
      }
      setErrMsg(friendlyErrorMessage(err, 'Transaction failed.'));
      setStep('error');
    }
  }

  const isLoading = step === 'approving' || step === 'deploying';

  return (
    <NetworkGuard>
    <AppLayout title="Pricing">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>

        {/* Header */}
        <div style={{ textAlign: 'center', padding: '16px 0 8px' }}>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: '#0F172A', marginBottom: 10 }}>
            One platform, two tiers
          </h1>
          <p style={{ fontSize: 15, color: '#64748B', maxWidth: 480, margin: '0 auto', lineHeight: 1.7 }}>
            Start with the free tier and upgrade to an annual subscription for your private payroll contract, AI Agent, and multi-token support.
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
                  Included with Salden Pro
                </div>
              ) : (
                <div style={{ padding: '11px 0', textAlign: 'center', borderRadius: 10, background: '#EEF2FF', fontSize: 14, fontWeight: 700, color: '#4F46E5' }}>
                  Current Plan
                </div>
              )}
            </div>
          </div>

          {/* Salden Pro */}
          <div style={{ background: 'linear-gradient(145deg, #4F46E5 0%, #6D28D9 100%)', borderRadius: 20, padding: '32px 28px', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: -40, right: -40, width: 160, height: 160, borderRadius: '50%', background: 'rgba(255,255,255,0.08)', pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', top: 16, right: 20, background: '#14B8A6', color: '#fff', padding: '3px 12px', borderRadius: 99, fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Annual
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Salden Pro</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 42, fontWeight: 800, color: '#fff' }}>${priceUsdc.toFixed(2)}</span>
                <span style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)' }}>/ year · USDC</span>
              </div>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)', marginTop: 8, lineHeight: 1.65 }}>
                Your own private payroll contract, unlimited tokens, and full AI Agent access. Renews annually.
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
                  <CheckCircle2 size={16} color="#14B8A6" /> Salden Pro Active
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
                      : <><Zap size={16} /> Upgrade for ${priceUsdc.toFixed(2)} USDC / year</>
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
              <p style={{ fontSize: 14, fontWeight: 700, color: '#059669', margin: '0 0 2px' }}>Salden Pro activated successfully</p>
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
            <div style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, color: '#4F46E5', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Salden Pro</div>
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
          <Row label="Payroll Receipt emails"           free={true}             premium={true}          />
          <Row label="Transaction history"               free={true}             premium={true}          />
          <Row label="Compliance dashboard"              free={true}             premium={true}          />
          <Row label="Cost"                              free="Free"             premium={`$${priceUsdc.toFixed(2)} per year`}  />
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
    </NetworkGuard>
  );
}
