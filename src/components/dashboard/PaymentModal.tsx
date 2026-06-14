'use client';
/**
 * @file components/dashboard/PaymentModal.tsx
 *
 * Premium-only modal shown when clicking "Process Payment".
 * Free-plan users bypass this modal and go straight to batchPay with USDC.
 *
 * Features:
 *  - Token dropdown: fetched from payrollClone.getSupportedTokens() Onchain,
 *    cached in IndexedDB (30-min TTL), refresh button forces re-fetch.
 *  - Names come from AppContext tokenRegistry (IPFS-synced), not from the chain.
 *  - Group dropdown: defaults to the group active in the dashboard, contains
 *    all groups + "All Employees".
 *  - Cancel / Confirm buttons.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { usePublicClient } from 'wagmi';
import { RefreshCw, ChevronDown, AlertTriangle, Loader2 } from 'lucide-react';
import { Modal } from '@/components/shared/Modal';
import { Button } from '@/components/shared/Button';
import { useApp } from '@/context/AppContext';
import { arcTestnet, CONTRACTS } from '@/lib/contracts/config';
import { MULTI_TOKEN_PAYROLL_ABI } from '@/lib/contracts/abis';
import {
  getCachedTokens, setCachedTokens,
} from '@/lib/db/indexeddb';
import {
  getToken, tokenLabel, DEFAULT_TOKEN_REGISTRY,
  type TokenEntry,
} from '@/lib/token-registry';

interface PaymentModalProps {
  open:         boolean;
  onClose:      () => void;
  activeGroup:  string;           // currently selected group in dashboard
  groups:       string[];         // all groups that exist
  payrollClone: string;           // address of premium payroll clone
  onConfirm: (params: {
    token:      TokenEntry;
    group:      string;           // "All Employees" or a group name
  }) => void;
}

// ── Label helpers ─────────────────────────────────────────────────────────────

function TokenOption({ entry }: { entry: TokenEntry }) {
  return (
    <option value={entry.address}>
      {tokenLabel(entry)}
    </option>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function PaymentModal({
  open, onClose, activeGroup, groups, payrollClone, onConfirm,
}: PaymentModalProps) {
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const { state }    = useApp();
  const { tokenRegistry } = state;

  const [tokens,         setTokens]         = useState<TokenEntry[]>([]);
  const [selectedToken,  setSelectedToken]  = useState<string>('');
  const [selectedGroup,  setSelectedGroup]  = useState<string>(activeGroup);
  const [loadingTokens,  setLoadingTokens]  = useState(true);
  const [refreshing,     setRefreshing]     = useState(false);
  const [fetchError,     setFetchError]     = useState('');
  // Track whether we've set the initial default selection this session
  const hasSetDefault = useRef(false);

  // Reset default flag and group when modal opens
  useEffect(() => {
    if (open) {
      hasSetDefault.current = false;
      setSelectedGroup(activeGroup);
    }
  }, [open, activeGroup]);

  // ── Fetch supported tokens ─────────────────────────────────────────────────

  const fetchTokens = useCallback(async (forceRefresh = false) => {
    setFetchError('');
    if (forceRefresh) setRefreshing(true);
    else              setLoadingTokens(true);

    try {
      let addresses: string[] | null = null;

      // 1. Try IndexedDB cache first (unless forced refresh)
      if (!forceRefresh) {
        addresses = await getCachedTokens(payrollClone);
      }

      // 2. Cache miss or forced refresh → read from smart contract
      if (!addresses) {
        if (!publicClient) throw new Error('No RPC client available');

        const raw = await publicClient.readContract({
          address:      payrollClone as `0x${string}`,
          abi:          MULTI_TOKEN_PAYROLL_ABI,
          functionName: 'getSupportedTokens',
          args:         [],
        }) as string[];

        addresses = raw as string[];

        // Always ensure USDC is present even if not in contract list
        if (!addresses.some(a => a.toLowerCase() === CONTRACTS.USDC.toLowerCase())) {
          addresses = [CONTRACTS.USDC, ...addresses];
        }

        // Write to cache
        await setCachedTokens({
          walletAddress: '',          // not scoped to wallet — same contract same tokens
          contractAddr:  payrollClone,
          tokenAddresses: addresses,
          cachedAt:      Date.now(),
        });
      }

      // 3. Resolve human-readable names from registry
      const resolved: TokenEntry[] = addresses.map(addr => {
        const entry = getToken(tokenRegistry, addr);
        if (entry) return entry;
        // Unknown token: show truncated address as name (prompts user to add to registry)
        return {
          address:  addr,
          name:     `Unknown Token`,
          symbol:   `${addr.slice(0, 6)}…${addr.slice(-4)}`,
          decimals: 18,
          addedAt:  new Date().toISOString(),
        };
      });

      setTokens(resolved);

      // Default to USDC on each fresh open (hasSetDefault resets on modal open)
      if (!hasSetDefault.current) {
        const usdc = resolved.find(t => t.address.toLowerCase() === CONTRACTS.USDC.toLowerCase());
        setSelectedToken((usdc ?? resolved[0])?.address ?? '');
        hasSetDefault.current = true;
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Failed to load tokens');
      const fallback = Object.values(tokenRegistry);
      setTokens(fallback.length ? fallback : Object.values(DEFAULT_TOKEN_REGISTRY));
      if (!hasSetDefault.current) {
        setSelectedToken(CONTRACTS.USDC);
        hasSetDefault.current = true;
      }
    } finally {
      setLoadingTokens(false);
      setRefreshing(false);
    }
  }, [publicClient, payrollClone, tokenRegistry]);  // selectedToken removed — no longer needed

  // Fetch on open
  useEffect(() => {
    if (open) fetchTokens(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, payrollClone]);

  // ── Confirm ────────────────────────────────────────────────────────────────

  function handleConfirm() {
    const tokenEntry = tokens.find(t => t.address === selectedToken);
    if (!tokenEntry) return;
    onConfirm({ token: tokenEntry, group: selectedGroup });
    onClose();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const selectStyle: React.CSSProperties = {
    width: '100%', padding: '10px 14px',
    border: '1.5px solid #E2E8F0', borderRadius: 10,
    fontSize: 14, fontFamily: 'inherit', color: '#0F172A',
    background: '#fff', outline: 'none', cursor: 'pointer',
    appearance: 'none', WebkitAppearance: 'none',
  };

  const allGroups = ['All Employees', ...groups];
  const selectedTokenEntry = tokens.find(t => t.address === selectedToken);

  return (
    <Modal open={open} onClose={onClose} title="Process Payment" maxWidth={440}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* ── Token / Currency ───────────────────────────────────────────── */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Currency / Token
            </label>
            <button
              onClick={() => fetchTokens(true)}
              disabled={refreshing}
              title="Refresh token list from contract"
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: 'none', border: 'none', cursor: refreshing ? 'not-allowed' : 'pointer',
                fontSize: 12, color: '#64748B', fontFamily: 'inherit',
              }}
            >
              <RefreshCw size={12} style={refreshing ? { animation: 'spin 0.7s linear infinite' } : {}} />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          {loadingTokens ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px',
              border: '1.5px solid #E2E8F0', borderRadius: 10, color: '#64748B', fontSize: 14,
            }}>
              <Loader2 size={14} style={{ animation: 'spin 0.7s linear infinite' }} />
              Loading tokens from contract…
            </div>
          ) : (
            <div style={{ position: 'relative' }}>
              <select
                value={selectedToken}
                onChange={e => setSelectedToken(e.target.value)}
                style={selectStyle}
                onFocus={e => (e.target.style.borderColor = '#4F46E5')}
                onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
              >
                {tokens.map(t => <TokenOption key={t.address} entry={t} />)}
              </select>
              <ChevronDown size={14} style={{
                position: 'absolute', right: 12, top: '50%',
                transform: 'translateY(-50%)', pointerEvents: 'none', color: '#94A3B8',
              }} />
            </div>
          )}

          {fetchError && (
            <p style={{ fontSize: 12, color: '#D97706', marginTop: 6, display: 'flex', alignItems: 'center', gap: 5 }}>
              <AlertTriangle size={12} /> {fetchError} — showing cached registry.
            </p>
          )}

          {/* Token details badge */}
          {selectedTokenEntry && !loadingTokens && (
            <div style={{
              marginTop: 8, padding: '6px 12px',
              background: '#EEF2FF', borderRadius: 8,
              fontSize: 12, color: '#4F46E5',
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            }}>
              <span style={{ fontWeight: 700 }}>{selectedTokenEntry.symbol}</span>
              <span style={{ color: '#94A3B8' }}>·</span>
              <span>{selectedTokenEntry.decimals} decimals</span>
              <span style={{ color: '#94A3B8' }}>·</span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
                {selectedTokenEntry.address.slice(0, 8)}…{selectedTokenEntry.address.slice(-6)}
              </span>
            </div>
          )}
        </div>

        {/* ── Group ──────────────────────────────────────────────────────── */}
        <div>
          <label style={{ fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 8 }}>
            Employee Group
          </label>
          <div style={{ position: 'relative' }}>
            <select
              value={selectedGroup}
              onChange={e => setSelectedGroup(e.target.value)}
              style={selectStyle}
              onFocus={e => (e.target.style.borderColor = '#4F46E5')}
              onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
            >
              {allGroups.map(g => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
            <ChevronDown size={14} style={{
              position: 'absolute', right: 12, top: '50%',
              transform: 'translateY(-50%)', pointerEvents: 'none', color: '#94A3B8',
            }} />
          </div>
          <p style={{ fontSize: 12, color: '#94A3B8', marginTop: 6 }}>
            Only employees in this group will receive payment.
          </p>
        </div>

        {/* ── Actions ────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
          <button
            onClick={onClose}
            style={{
              flex: 1, padding: '11px 0', borderRadius: 10,
              border: '1.5px solid #E2E8F0', background: 'transparent',
              fontSize: 14, fontWeight: 500, cursor: 'pointer',
              color: '#475569', fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <Button
            variant="primary"
            disabled={!selectedToken || loadingTokens}
            onClick={handleConfirm}
            style={{ flex: 1 }}
          >
            Confirm Payment
          </Button>
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </Modal>
  );
}
