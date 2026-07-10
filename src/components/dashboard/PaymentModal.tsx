'use client';
/**
 * @file components/dashboard/PaymentModal.tsx
 * Premium payment modal — select token, group, and remark before confirming.
 * Remark is written into the Arc Memo JSON (ImportantUpdate #8).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { usePublicClient } from 'wagmi';
import { RefreshCw, ChevronDown, AlertTriangle, Loader2 } from 'lucide-react';
import { Modal }   from '@/components/shared/Modal';
import { Button }  from '@/components/shared/Button';
import { useApp }  from '@/context/AppContext';
import { arcTestnet, CONTRACTS } from '@/lib/contracts/config';
import { MULTI_TOKEN_PAYROLL_ABI } from '@/lib/contracts/abis';
import { getCachedTokens, setCachedTokens } from '@/lib/db/indexeddb';
import { getToken, tokenLabel, DEFAULT_TOKEN_REGISTRY, type TokenEntry } from '@/lib/token-registry';

const REMARK_OPTIONS = [
  'Salary Payment',
  'Allowance',
  'Reimbursement',
  'Salary Advance',
  'Other',
] as const;

export interface PaymentModalParams {
  token:   TokenEntry;
  group:   string;
  remark:  string;
}

interface PaymentModalProps {
  open:         boolean;
  onClose:      () => void;
  activeGroup:  string;
  groups:       string[];
  payrollClone: string;
  onConfirm:    (params: PaymentModalParams) => void;
}

export function PaymentModal({ open, onClose, activeGroup, groups, payrollClone, onConfirm }: PaymentModalProps) {
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const { state }    = useApp();
  const { tokenRegistry } = state;

  const [tokens,         setTokens]         = useState<TokenEntry[]>([]);
  const [selectedToken,  setSelectedToken]  = useState('');
  const [selectedGroup,  setSelectedGroup]  = useState(activeGroup);
  const [selectedRemark, setSelectedRemark] = useState<string>(REMARK_OPTIONS[0]);
  const [customRemark,   setCustomRemark]   = useState('');
  const [loadingTokens,  setLoadingTokens]  = useState(true);
  const [refreshing,     setRefreshing]     = useState(false);
  const [fetchError,     setFetchError]     = useState('');
  const hasSetDefault = useRef(false);

  useEffect(() => {
    if (open) {
      hasSetDefault.current = false;
      setSelectedGroup(activeGroup);
      setSelectedRemark(REMARK_OPTIONS[0]);
      setCustomRemark('');
    }
  }, [open, activeGroup]);

  const fetchTokens = useCallback(async (forceRefresh = false) => {
    if (!publicClient || !payrollClone) return;
    setRefreshing(forceRefresh);
    setFetchError('');
    try {
      if (!forceRefresh) {
        const cached = await getCachedTokens(payrollClone);
        if (cached?.length) {
          const resolved = cached.map(addr => getToken(tokenRegistry, addr) ?? {
            address: addr, name: 'Unknown Token',
            symbol: `${addr.slice(0, 6)}…${addr.slice(-4)}`,
            decimals: 18, addedAt: new Date().toISOString(),
          });
          setTokens(resolved);
          if (!hasSetDefault.current) {
            const usdc = resolved.find(t => t.address.toLowerCase() === CONTRACTS.USDC.toLowerCase());
            setSelectedToken((usdc ?? resolved[0])?.address ?? '');
            hasSetDefault.current = true;
          }
          setLoadingTokens(false);
          setRefreshing(false);
          return;
        }
      }
      const raw = await publicClient.readContract({
        address: payrollClone as `0x${string}`,
        abi: MULTI_TOKEN_PAYROLL_ABI,
        functionName: 'getSupportedTokens',
      }) as `0x${string}`[];
      let addresses = raw as string[];
      // Always ensure USDC is present even if not in contract list — restored
      // from the pre-upgrade version; the corrected-zip rewrite silently
      // dropped this safety net, which meant a contract that doesn't list
      // USDC would leave it unselectable in the dropdown despite USDC being
      // the app-wide default token.
      if (!addresses.some(a => a.toLowerCase() === CONTRACTS.USDC.toLowerCase())) {
        addresses = [CONTRACTS.USDC, ...addresses];
      }
      await setCachedTokens({
        walletAddress:  state.account ?? '',
        contractAddr:   payrollClone,
        tokenAddresses: addresses,
        cachedAt:       Date.now(),
      });
      const resolved = addresses.map(addr => getToken(tokenRegistry, addr) ?? {
        address: addr, name: 'Unknown Token',
        symbol: `${addr.slice(0, 6)}…${addr.slice(-4)}`,
        decimals: 18, addedAt: new Date().toISOString(),
      });
      setTokens(resolved);
      if (!hasSetDefault.current) {
        const usdc = resolved.find(t => t.address.toLowerCase() === CONTRACTS.USDC.toLowerCase());
        setSelectedToken((usdc ?? resolved[0])?.address ?? '');
        hasSetDefault.current = true;
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Failed to load tokens');
      const fallback = Object.values(tokenRegistry);
      setTokens(fallback.length ? fallback : Object.values(DEFAULT_TOKEN_REGISTRY));
      if (!hasSetDefault.current) { setSelectedToken(CONTRACTS.USDC); hasSetDefault.current = true; }
    } finally { setLoadingTokens(false); setRefreshing(false); }
  }, [publicClient, payrollClone, tokenRegistry]);

  useEffect(() => { if (open) fetchTokens(false); }, [open, payrollClone, fetchTokens]);

  function handleConfirm() {
    const tokenEntry = tokens.find(t => t.address === selectedToken);
    if (!tokenEntry) return;
    const remark = selectedRemark === 'Other'
      ? (customRemark.trim() || 'Other')
      : selectedRemark;
    onConfirm({ token: tokenEntry, group: selectedGroup, remark });
    onClose();
  }

  const sel: React.CSSProperties = {
    width: '100%', padding: '10px 14px', border: '1.5px solid #E2E8F0',
    borderRadius: 10, fontSize: 14, fontFamily: 'inherit', color: '#0F172A',
    background: '#fff', outline: 'none', cursor: 'pointer',
    appearance: 'none', WebkitAppearance: 'none',
  };
  const lbl: React.CSSProperties = {
    fontSize: 12, fontWeight: 700, color: '#64748B',
    textTransform: 'uppercase', letterSpacing: '0.05em',
    display: 'block', marginBottom: 8,
  };
  const allGroups = ['All Employees', ...groups];
  const selectedTokenEntry = tokens.find(t => t.address === selectedToken);

  return (
    <Modal open={open} onClose={onClose} title="Process Payment" maxWidth={440}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Token */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <label style={lbl}>Currency / Token</label>
            <button onClick={() => fetchTokens(true)} disabled={refreshing}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', display: 'flex' }}>
              <RefreshCw size={13} style={{ animation: refreshing ? 'spin 0.7s linear infinite' : 'none' }} />
            </button>
          </div>
          {loadingTokens
            ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0' }}><Loader2 size={14} style={{ animation: 'spin 0.7s linear infinite', color: '#94A3B8' }} /><span style={{ fontSize: 13, color: '#94A3B8' }}>Loading tokens…</span></div>
            : <div style={{ position: 'relative' }}>
                <select value={selectedToken} onChange={e => setSelectedToken(e.target.value)} style={sel}
                  onFocus={e => { e.target.style.borderColor = '#4F46E5'; }}
                  onBlur={e => { e.target.style.borderColor = '#E2E8F0'; }}>
                  {tokens.map(t => <option key={t.address} value={t.address}>{tokenLabel(t)}</option>)}
                </select>
                <ChevronDown size={14} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: '#94A3B8' }} />
              </div>
          }
          {fetchError && (
            <p style={{ fontSize: 12, color: '#D97706', marginTop: 6, display: 'flex', alignItems: 'center', gap: 5 }}>
              <AlertTriangle size={12} /> {fetchError}
            </p>
          )}
          {selectedTokenEntry && !loadingTokens && (
            <div style={{ marginTop: 8, padding: '6px 12px', background: '#EEF2FF', borderRadius: 8, fontSize: 12, color: '#4F46E5', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 700 }}>{selectedTokenEntry.symbol}</span>
              <span style={{ color: '#94A3B8' }}>·</span>
              <span>{selectedTokenEntry.decimals} decimals</span>
            </div>
          )}
        </div>

        {/* Group */}
        <div>
          <label style={lbl}>Employee Group</label>
          <div style={{ position: 'relative' }}>
            <select value={selectedGroup} onChange={e => setSelectedGroup(e.target.value)} style={sel}
              onFocus={e => { e.target.style.borderColor = '#4F46E5'; }}
              onBlur={e => { e.target.style.borderColor = '#E2E8F0'; }}>
              {allGroups.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
            <ChevronDown size={14} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: '#94A3B8' }} />
          </div>
        </div>

        {/* Remark dropdown — written into Arc Memo JSON */}
        <div>
          <label style={lbl}>Remark</label>
          <div style={{ position: 'relative' }}>
            <select value={selectedRemark} onChange={e => setSelectedRemark(e.target.value)} style={sel}
              onFocus={e => { e.target.style.borderColor = '#4F46E5'; }}
              onBlur={e => { e.target.style.borderColor = '#E2E8F0'; }}>
              {REMARK_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <ChevronDown size={14} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: '#94A3B8' }} />
          </div>
          {selectedRemark === 'Other' && (
            <textarea
              value={customRemark}
              onChange={e => setCustomRemark(e.target.value)}
              placeholder="Describe the payment purpose…"
              rows={2}
              style={{ marginTop: 8, width: '100%', padding: '10px 14px', border: '1.5px solid #E2E8F0', borderRadius: 10, fontSize: 13, fontFamily: 'inherit', resize: 'vertical', outline: 'none', boxSizing: 'border-box' }}
              onFocus={e => { e.target.style.borderColor = '#4F46E5'; }}
              onBlur={e => { e.target.style.borderColor = '#E2E8F0'; }}
            />
          )}
          <p style={{ fontSize: 11, color: '#94A3B8', marginTop: 5 }}>Attached to on-chain memo for each payment batch.</p>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
          <button onClick={onClose} style={{ flex: 1, padding: '11px 0', borderRadius: 10, border: '1.5px solid #E2E8F0', background: 'transparent', fontSize: 14, fontWeight: 500, cursor: 'pointer', color: '#475569', fontFamily: 'inherit' }}>
            Cancel
          </button>
          <Button variant="primary" disabled={!selectedToken || loadingTokens} onClick={handleConfirm} style={{ flex: 1 }}>
            Confirm Payment
          </Button>
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </Modal>
  );
}
