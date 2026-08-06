'use client';
/**
 * @file app/settings/page.tsx
 * Settings — company profile, contract functions, premium tools, danger zone.
 * Cooldown removed per spec. Restructured to match new design.
 */

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { usePublicClient } from 'wagmi';
import { type PayrollSetup } from '@/context/AppContext';
import {
  Zap, Trash2, AlertTriangle, Loader2, Plus, X, ChevronRight, ExternalLink, Pencil,
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/shared/Button';
import { useApp } from '@/context/AppContext';
import { Modal } from '@/components/shared/Modal';
import { addressLink, arcTestnet } from '@/lib/contracts/config';
import { REGISTRY_ABI } from '@/lib/contracts/abis';
import { truncAddr, sanitizeString } from '@/lib/validation';
import { useAgentSession } from '@/lib/agent/useAgentSession';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { useUniversalWrite } from '@/lib/circle/useUniversalWrite';
import { useCachedSignMessage } from '@/lib/circle/useCachedSignMessage';
import { usePayrollSync } from '@/lib/usePayrollSync';
import { useCloneAccess } from '@/lib/useCloneAccess';
import { useRegistryCloneAccess } from '@/lib/useRegistryCloneAccess';
import { waitForSuccessfulReceipt } from '@/lib/txReceipt';

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16, overflow: 'hidden' }}>
      <div style={{ padding: '16px 24px', borderBottom: '1px solid #F1F5F9' }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', margin: 0 }}>{title}</h3>
      </div>
      <div style={{ padding: '20px 24px' }}>
        {children}
      </div>
    </div>
  );
}

// ── Editable field — plain text + edit icon by default; the input only
//    appears once the edit icon is clicked (saved via the section's own
//    Save button, same as before) ──────────────────────────────────────────

function EditableField({
  value, onChange, placeholder, emptyLabel, type = 'text', inputStyle,
}: {
  value:        string;
  onChange:     (v: string) => void;
  placeholder:  string;
  emptyLabel:   string;
  type?:        string;
  inputStyle:   React.CSSProperties;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={type === 'text' ? 100 : undefined}
        autoFocus
        style={inputStyle}
        onFocus={e => (e.target.style.borderColor = '#4F46E5')}
        onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
      />
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <button
        onClick={() => setEditing(true)}
        aria-label="Edit"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 26, height: 26, borderRadius: 8, flexShrink: 0,
          background: '#F8F9FA', border: '1px solid #E2E8F0', cursor: 'pointer', color: '#64748B',
        }}
      >
        <Pencil size={13} />
      </button>
      <span style={{ fontSize: 14, color: value ? '#0F172A' : '#94A3B8' }}>
        {value || emptyLabel}
      </span>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', alignItems: 'center', gap: 16, marginBottom: 18 }}>
      <label style={{ fontSize: 13, fontWeight: 600, color: '#475569' }}>{label}</label>
      {children}
    </div>
  );
}

// ── Main settings page ────────────────────────────────────────────────────────

export default function SettingsPage() {
  // useEffectiveAddress resolves wagmi OR Circle session — without this,
  // `address` was always undefined for Google/email social-login users
  // (useAccount only ever tracks an externally-connected wagmi wallet),
  // which silently broke profile save + group add/remove sync on this
  // page for every non-external-wallet login.
  const { address }      = useEffectiveAddress();
  const publicClient     = usePublicClient({ chainId: arcTestnet.id });
  const { state, dispatch, addToast, syncData, hydrateFromCache } = useApp();
  const { payrollSetup, isPremiumUser, payrollClone, registryClone, groups, employees } = state;
  usePayrollSync({ registryClone, address, publicClient });
  // Settings never had its own resolution for either clone address — it
  // only ever read state.payrollClone/state.registryClone as populated by
  // whatever page the person happened to visit earlier this session (or
  // payrollSetup's cached/synced value). Landing here directly — a fresh
  // browser/device, or opening Settings straight from a bookmark — left
  // both null, which is why Contract Information's rows disappeared
  // entirely rather than showing stale-but-correct data. These two hooks
  // are the same self-healing lookups dashboard/ai-agent already rely on
  // (see their file comments for the full history).
  useCloneAccess();
  useRegistryCloneAccess();

  // BUG FIX: this page is the primary place users check/edit their company
  // name and receipt email, so it should show whatever is already saved as
  // fast and reliably as possible — straight from the local cache, not
  // gated behind usePayrollSync's full flow (which needs registryClone AND
  // publicClient ready before its own "instant local cache" step even
  // starts). Runs as soon as the wallet address is known, independent of
  // everything else.
  useEffect(() => {
    if (address) void hydrateFromCache(address);
  }, [address, hydrateFromCache]);

  // Used for sync/anchor (profile + groups) below and by the shared
  // cached-sign hook — branches to a Circle SIGN_MESSAGE/PIN challenge for
  // social login, wagmi for an external wallet.
  const { writeContract: universalWrite, signMessage: universalSignMessage, canWrite } = useUniversalWrite();

  // Latest CID we've successfully anchored Onchain — lets anchorCid skip a
  // redundant transaction if the data hasn't actually changed since.
  // (IPFS "previousCid" bookkeeping for Pinata cleanup is handled centrally
  // by AppContext's syncData/loadData — no need to duplicate it here.)
  const lastAnchoredCidRef = useRef<string | null>(null);

  /** Anchors a freshly-synced IPFS CID Onchain. Mirrors the dashboard's
   *  anchorCid — without this, group/profile/token-registry edits made here
   *  would sync to IPFS but never update the Onchain pointer, so they'd be
   *  invisible after a reload or from another device. */
  const anchorCid = async (cid?: string) => {
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
      console.error('[Settings] Failed to anchor CID Onchain:', err);
      addToast('Saved, but the Onchain record could not be updated. Please try again.', 'warning');
    }
  };

  const sign = useCachedSignMessage();
  const signMsg = canWrite ? sign : undefined;

  /** Sync current state to IPFS, then anchor the resulting CID Onchain. */
  async function syncAndAnchor(freshPayrollSetup?: PayrollSetup) {
    const { cid } = await syncData({ walletAddress: address ?? '', signMessage: signMsg, payrollSetup: freshPayrollSetup });
    await anchorCid(cid);
  }

  // Profile form
  const [companyName, setCompanyName] = useState(payrollSetup?.companyName ?? '');
  const [email,       setEmail]       = useState(payrollSetup?.email       ?? '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaveVersion, setProfileSaveVersion] = useState(0);
  const profileHydrated = useRef(false);

  // payrollSetup can arrive asynchronously (usePayrollSync's cache/IPFS
  // hydration above happens after this component's first render) — the
  // useState initializers only ever see whatever was in AppContext at
  // mount time. Without this, company name and receipt email rendered
  // blank on any page load where this was the first page visited this
  // session, even though the data existed and was seconds away. Syncs
  // once, the first time real data shows up; never overwrites the form
  // again after that (so it doesn't clobber whatever the user is
  // actively typing, including after their own save).
  useEffect(() => {
    if (profileHydrated.current || !payrollSetup) return;
    setCompanyName(payrollSetup.companyName ?? '');
    setEmail(payrollSetup.email ?? '');
    profileHydrated.current = true;
  }, [payrollSetup]);

  // Fast cross-device/browser path: the IPFS hydration above needs a
  // wallet signature (to derive the decryption key) plus an IPFS fetch, so
  // on a brand-new browser or device it can take a few seconds — or never
  // resolve at all until the wallet reconnects. This reads the same two
  // fields from the server-side cache (lib/serverProfileCache.ts, kept in
  // sync by the write-through below and by the setup wizard) so they
  // render immediately instead of blank. Whichever source — this cache or
  // the IPFS effect above — resolves first with real data wins and marks
  // profileHydrated so the other is a no-op, same "hydrate once" guard
  // already protecting the user's active typing.
  useEffect(() => {
    if (!address) return;
    fetch(`/api/profile?address=${address}`)
      .then(res => res.json())
      .then((data: { companyName: string | null; email: string | null }) => {
        if (profileHydrated.current) return;
        if (!data.companyName && !data.email) return;
        setCompanyName(data.companyName ?? '');
        setEmail(data.email ?? '');
        profileHydrated.current = true;
      })
      .catch(() => { /* best-effort fast path — IPFS hydration above is unaffected */ });
  }, [address]);

  // Group management
  const [newGroup,     setNewGroup]     = useState('');
  const [groupError,   setGroupError]   = useState('');
  const [groupSaving,  setGroupSaving]  = useState(false);

  // AI Agent execution mode — 'confirm' (default, human always signs from
  // their own wallet) vs 'autonomous' (agent's own Circle-managed wallet
  // executes execute_* actions with no per-action human signature). See
  // lib/agent/agentMode.ts and app/api/agent/mode/route.ts — both already
  // fully wired into chat/route.ts's tool selection; this section is the
  // missing piece that actually lets an employer control it.
  const [agentMode,      setAgentModeState] = useState<'confirm' | 'autonomous'>('confirm');
  const [modeLoading,    setModeLoading]    = useState(false);
  const [modeSaving,     setModeSaving]     = useState(false);
  const [modeError,      setModeError]      = useState('');
  const [modeSaved,      setModeSaved]      = useState(false);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    (async () => {
      setModeLoading(true);
      try {
        const res = await fetch(`/api/agent/mode?wallet=${address}`);
        if (!res.ok) throw new Error('Could not load current mode.');
        const data = await res.json() as { mode?: 'confirm' | 'autonomous' };
        if (!cancelled && data.mode) setAgentModeState(data.mode);
      } catch {
        // Non-fatal — the toggle still renders at the safe 'confirm'
        // default even if we couldn't fetch the actual current value.
      } finally {
        if (!cancelled) setModeLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [address]);

  // AI Agent daily spend limit — per-employer configurable ceiling, see
  // app/api/agent/limits/route.ts and lib/agent/employerLimits.ts. This
  // sits BELOW the platform-wide absolute limit (AGENT_MAX_DAILY_TOTAL);
  // it can never be used to exceed that, only to set something tighter
  // (or, up to the platform ceiling, looser than the previous shared
  // default every employer used to be stuck with).
  const { getToken } = useAgentSession();

  async function handleSetAgentMode(nextMode: 'confirm' | 'autonomous') {
    if (!address || !canWrite || nextMode === agentMode) return;
    setModeSaving(true);
    setModeError('');
    setModeSaved(false);
    try {
      const token = await getToken(address, universalSignMessage);
      const res = await fetch('/api/agent/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ walletAddress: address, mode: nextMode }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setModeError(data.error ?? 'Could not save your setting.');
        return;
      }
      setAgentModeState(nextMode);
      setModeSaved(true);
      setTimeout(() => setModeSaved(false), 3000);
    } catch {
      setModeError('Could not save your setting. Please try again.');
    } finally {
      setModeSaving(false);
    }
  }

  const [dailyLimitInput, setDailyLimitInput] = useState('');
  const [platformCeiling, setPlatformCeiling] = useState<number | null>(null);
  const [limitLoading,    setLimitLoading]    = useState(false);
  const [limitSaving,     setLimitSaving]     = useState(false);
  const [limitError,      setLimitError]      = useState('');
  const [limitSaved,      setLimitSaved]       = useState(false);

  const grossPayrollTotal = (state.employees ?? []).reduce((sum, e) => sum + (e.salaryAmount ?? 0), 0);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    (async () => {
      setLimitLoading(true);
      try {
        const res = await fetch(`/api/agent/limits?wallet=${address}`);
        if (!res.ok) throw new Error('Could not load current limit.');
        const data = await res.json() as { employerLimit: number | null; platformCeiling: number };
        if (!cancelled) {
          setPlatformCeiling(data.platformCeiling);
          setDailyLimitInput(data.employerLimit != null ? String(data.employerLimit) : '');
        }
      } catch {
        // Non-fatal — the section still renders and lets them set a fresh
        // value even if we couldn't fetch the existing one.
      } finally {
        if (!cancelled) setLimitLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [address]);

  async function handleSaveDailyLimit() {
    if (!address || !canWrite) return;
    const amount = Number(dailyLimitInput);
    if (!Number.isFinite(amount) || amount <= 0) {
      setLimitError('Enter a valid amount.');
      return;
    }
    setLimitSaving(true);
    setLimitError('');
    setLimitSaved(false);
    try {
      // Signature is requested here — the first (and only) time this
      // section needs one — not when the page/section merely loads.
      const token = await getToken(address, universalSignMessage);
      const res = await fetch('/api/agent/limits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ walletAddress: address, amount, grossPayrollTotal }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setLimitError(data.error ?? 'Could not save your limit.');
        return;
      }
      setLimitSaved(true);
      setTimeout(() => setLimitSaved(false), 3000);
    } catch {
      setLimitError('Could not save your limit. Please try again.');
    } finally {
      setLimitSaving(false);
    }
  }

  // Delete all data modal
  const [deleteOpen,    setDeleteOpen]    = useState(false);

  // ── Save profile ────────────────────────────────────────────────────────────

  async function handleSaveProfile() {
    setSavingProfile(true);
    try {
      const updated: PayrollSetup = {
        companyName:   sanitizeString(companyName),
        email:         email.trim(),
        registryClone: payrollSetup?.registryClone,
        payrollClone:  payrollSetup?.payrollClone,
      };
      dispatch({ type: 'SET_PAYROLL_DATA', payload: { payrollSetup: updated } });
      dispatch({ type: 'SET_COMPANY_NAME', payload: updated.companyName });
      await syncAndAnchor(updated);
      // Best-effort write-through to the cross-device/browser fast-path
      // cache (lib/serverProfileCache.ts) — never blocks or fails the
      // save itself; the IPFS record above is already the real save.
      if (address) {
        fetch('/api/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, companyName: updated.companyName, email: updated.email }),
        }).catch(() => { /* best-effort */ });
      }
      setProfileSaveVersion(v => v + 1);
      addToast('Profile saved.', 'success');
    } catch { addToast('Failed to save profile.', 'error'); }
    finally { setSavingProfile(false); }
  }

  // ── Group management ────────────────────────────────────────────────────────

  async function handleAddGroup() {
    const g = sanitizeString(newGroup);
    if (!g) { setGroupError('Group name cannot be empty.'); return; }
    if (groups.includes(g)) { setGroupError('Group already exists.'); return; }
    const next = [...groups, g];
    dispatch({ type: 'SET_GROUPS', payload: next });
    setNewGroup('');
    setGroupError('');
    setGroupSaving(true);
    try {
      const { cid } = await syncData({ walletAddress: address ?? '', signMessage: signMsg, groups: next });
      await anchorCid(cid);
      addToast(`Group "${g}" created.`, 'success');
    } catch { addToast('Saved locally — sync failed.', 'warning'); }
    finally { setGroupSaving(false); }
  }

  async function handleRemoveGroup(g: string) {
    const next = groups.filter(x => x !== g);
    dispatch({ type: 'SET_GROUPS', payload: next });
    setGroupSaving(true);
    try {
      const { cid } = await syncData({ walletAddress: address ?? '', signMessage: signMsg, groups: next });
      await anchorCid(cid);
      addToast(`Group "${g}" removed.`, 'success');
    } catch { addToast('Saved locally — sync failed.', 'warning'); }
    finally { setGroupSaving(false); }
  }

  // ── Delete all local data ─────────────────────────────────────────────────

  function handleDeleteAllData() {
    dispatch({ type: 'RESET' });
    setDeleteOpen(false);
    addToast('All local data cleared.', 'success');
  }

  const inputStyle: React.CSSProperties = {
    padding: '9px 14px', border: '1.5px solid #E2E8F0',
    borderRadius: 10, fontSize: 14, fontFamily: 'inherit',
    color: '#0F172A', background: '#fff', outline: 'none', width: '100%',
  };

  return (
    <AppLayout title="Settings">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 780 }}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: '#0F172A', marginBottom: 4 }}>Settings</h1>
            <p style={{ fontSize: 14, color: '#64748B' }}>Manage your profile, groups, and contract configuration.</p>
          </div>
        </div>

        {/* ── Company Profile ─────────────────────────────────────────────── */}
        <Section title="Company Profile">
          <FieldRow label="Company Name">
            <EditableField
              key={`company-${profileSaveVersion}`}
              value={companyName}
              onChange={setCompanyName}
              placeholder="Acme Corp"
              emptyLabel="Add your company's name"
              inputStyle={inputStyle}
            />
          </FieldRow>
          <FieldRow label="Payroll Receipt Email">
            <EditableField
              key={`email-${profileSaveVersion}`}
              value={email}
              onChange={setEmail}
              type="email"
              placeholder="payroll@yourcompany.com"
              emptyLabel="Add payroll receipt email"
              inputStyle={inputStyle}
            />
          </FieldRow>
          <FieldRow label="Wallet Address">
            <div style={{
              padding: '9px 14px', background: '#F8F9FA',
              border: '1px solid #E2E8F0', borderRadius: 10,
              fontSize: 13, fontFamily: "'JetBrains Mono', monospace",
              color: '#475569',
            }}>
              {address ? (
                <a href={addressLink(address)} target="_blank" rel="noreferrer"
                  style={{ color: '#4F46E5', display: 'flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
                  {truncAddr(address, 12, 8)}
                  <ExternalLink size={12} />
                </a>
              ) : 'Not connected'}
            </div>
          </FieldRow>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="brand" loading={savingProfile} onClick={handleSaveProfile} size="sm">
              Save Profile
            </Button>
          </div>
        </Section>

        {/* ── Contract Info ───────────────────────────────────────────────── */}
        <Section title="Contract Information">
          {(() => {
            const rows = [
              ...(payrollClone  ? [{ label: 'Your Payroll Contract',  addr: payrollClone }]  : []),
              ...(registryClone ? [{ label: 'Your Registry Contract', addr: registryClone }] : []),
            ];
            if (rows.length === 0) {
              return (
                <p style={{ fontSize: 13, color: '#94A3B8', padding: '8px 0' }}>
                  You do not have any available smart contract.
                </p>
              );
            }
            return rows.map(({ label, addr }) => (
              <FieldRow key={label} label={label}>
                <a href={addressLink(addr)} target="_blank" rel="noreferrer"
                  style={{
                    padding: '8px 14px', background: '#F8F9FA',
                    border: '1px solid #E2E8F0', borderRadius: 10,
                    fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
                    color: '#4F46E5', textDecoration: 'none',
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                  {truncAddr(addr, 14, 8)}
                  <ExternalLink size={12} />
                </a>
              </FieldRow>
            ));
          })()}
        </Section>

        {/* ── Group Management ────────────────────────────────────────────── */}
        <Section title="Employee Groups">
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <input
              value={newGroup}
              onChange={e => { setNewGroup(e.target.value); setGroupError(''); }}
              placeholder="e.g. Remote Workers, Contractors…"
              maxLength={50}
              style={{ ...inputStyle, flex: 1 }}
              onFocus={e => (e.target.style.borderColor = '#4F46E5')}
              onBlur={e => (e.target.style.borderColor = '#E2E8F0')}
              onKeyDown={e => e.key === 'Enter' && handleAddGroup()}
            />
            <Button variant="brand" icon={groupSaving ? <Loader2 size={14} style={{ animation: 'spin 0.7s linear infinite' }} /> : <Plus size={14} />} onClick={handleAddGroup} size="sm" disabled={groupSaving}>
              Add Group
            </Button>
          </div>
          {groupError && <p style={{ fontSize: 12, color: '#DC2626', marginBottom: 12 }}>{groupError}</p>}


          {groups.length === 0 ? (
            <p style={{ fontSize: 13, color: '#94A3B8', textAlign: 'center', padding: '16px 0' }}>
              No groups yet. Add a group to organise employees.
            </p>
          ) : (
            <div style={{ border: '1px solid #E2E8F0', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 180px 36px',
                padding: '10px 14px', background: '#F8FAFC', borderBottom: '1px solid #E2E8F0',
              }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.4 }}>Group</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.4, borderLeft: '1px solid #E2E8F0', paddingLeft: 14 }}>Number of Members</span>
                <span />
              </div>
              {groups.map((g, i) => (
                <div key={g} style={{
                  display: 'grid', gridTemplateColumns: '1fr 180px 36px', alignItems: 'center',
                  padding: '10px 14px',
                  borderBottom: i < groups.length - 1 ? '1px solid #F1F5F9' : 'none',
                }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{g}</span>
                  <span style={{ fontSize: 13, color: '#0F172A', borderLeft: '1px solid #F1F5F9', paddingLeft: 14, alignSelf: 'stretch', display: 'flex', alignItems: 'center' }}>
                    {employees.filter(e => e.group === g).length}
                  </span>
                  <button onClick={() => handleRemoveGroup(g)} title={`Remove ${g}`}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', justifyContent: 'flex-end', color: '#94A3B8' }}>
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* ── Contract Functions tile ─────────────────────────────────────── */}
        {isPremiumUser ? (
          <Link href="/settings/contract-functions" style={{ textDecoration: 'none' }}>
            <div style={{
              background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16,
              padding: '18px 24px', display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', cursor: 'pointer',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 38, height: 38, borderRadius: 10, background: '#EEF2FF',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <Zap size={18} color="#4F46E5" />
                </div>
                <div>
                  <p style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', margin: '0 0 2px' }}>Contract Functions</p>
                  <p style={{ fontSize: 12, color: '#64748B', margin: 0 }}>Agents, payment tokens, withdrawals, and the circuit breaker</p>
                </div>
              </div>
              <ChevronRight size={18} color="#94A3B8" />
            </div>
          </Link>
        ) : (
          <div style={{
            background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16,
            padding: '18px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 38, height: 38, borderRadius: 10, background: '#F8F9FA',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <Zap size={18} color="#E2E8F0" />
              </div>
              <div>
                <p style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', margin: '0 0 2px' }}>Contract Functions</p>
                <p style={{ fontSize: 12, color: '#64748B', margin: 0 }}>Requires the Premium plan</p>
              </div>
            </div>
            <a href="/pricing" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', borderRadius: 9,
              background: '#14B8A6', color: '#fff',
              fontSize: 12, fontWeight: 600, textDecoration: 'none', flexShrink: 0,
            }}>
              Upgrade
            </a>
          </div>
        )}

        {/* ── AI Agent Execution Mode ──────────────────────────────────────── */}
        <Section title="AI Agent Execution Mode">
          <p style={{ fontSize: 13, color: '#64748B', marginBottom: 16, lineHeight: 1.6 }}>
            By default the AI Agent always <strong>proposes</strong> a transaction and waits for you to
            confirm and sign it yourself — whether you're using an external wallet (MetaMask, Rabby,
            etc.) or a Salden social-login wallet. Turning this on lets the agent also{' '}
            <strong>execute</strong> clear, unambiguous chat requests immediately from its own
            dedicated agent wallet, with no signature from you for that action.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <p style={{ fontSize: 14, fontWeight: 600, color: '#0F172A', margin: '0 0 2px' }}>
                {agentMode === 'autonomous' ? 'Autonomous mode is ON' : 'Human confirmation required (default)'}
              </p>
              <p style={{ fontSize: 12, color: '#64748B', margin: 0 }}>
                {agentMode === 'autonomous'
                  ? 'The agent may execute clear requests from its own wallet without asking you to sign.'
                  : 'Every agent action is proposed to your wallet for you to review, confirm, and sign.'}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={agentMode === 'autonomous'}
              aria-label="Toggle AI Agent autonomous execution mode"
              disabled={modeLoading || modeSaving || !address || !canWrite}
              onClick={() => handleSetAgentMode(agentMode === 'autonomous' ? 'confirm' : 'autonomous')}
              style={{
                position: 'relative', width: 46, height: 26, borderRadius: 999, border: 'none',
                cursor: (modeLoading || modeSaving || !address || !canWrite) ? 'default' : 'pointer',
                background: agentMode === 'autonomous' ? '#4F46E5' : '#CBD5E1',
                transition: 'background 0.15s', flexShrink: 0,
                opacity: (modeSaving || modeLoading) ? 0.7 : 1,
              }}
            >
              <span style={{
                position: 'absolute', top: 3, left: agentMode === 'autonomous' ? 23 : 3,
                width: 20, height: 20, borderRadius: '50%', background: '#fff',
                transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
              }} />
            </button>
          </div>
          {modeError && <p style={{ fontSize: 12, color: '#DC2626', marginTop: 10 }}>{modeError}</p>}
          {modeSaved && <p style={{ fontSize: 12, color: '#16A34A', marginTop: 10 }}>Saved.</p>}
          {agentMode === 'autonomous' && (
            <div style={{
              marginTop: 14, padding: '10px 12px', background: '#FFFBEB', border: '1px solid #FDE68A',
              borderRadius: 10, fontSize: 12, color: '#92400E', lineHeight: 1.5,
            }}>
              Keep the agent wallet funded with USDC so it can pay autonomously —{' '}
              <a href="/ai-agent/agent-wallet" style={{ color: '#92400E', fontWeight: 700 }}>view/fund it here</a>.
              Note: scheduled/recurring payments always run from the agent wallet regardless of this
              setting, since a schedule has to execute with no one present by definition — this toggle
              only controls whether the agent can also skip your confirmation for immediate chat requests.
            </div>
          )}
        </Section>

        {/* ── AI Agent Daily Spend Limit ──────────────────────────────────── */}
        <Section title="AI Agent Daily Spend Limit">
          <p style={{ fontSize: 13, color: '#64748B', marginBottom: 16, lineHeight: 1.6 }}>
            The most the AI Agent may move in a single day, across every payment it makes on your behalf.
            This must be at least your current gross payroll total (${grossPayrollTotal.toFixed(2)}) so a
            full payroll run is never blocked partway through.
            {platformCeiling != null && (
              <> The platform-wide maximum is ${platformCeiling.toLocaleString()} — you can set anything up
                to that, but never above it.</>
            )}
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <input
                type="number"
                min={0}
                step="0.01"
                value={dailyLimitInput}
                onChange={e => { setDailyLimitInput(e.target.value); setLimitError(''); setLimitSaved(false); }}
                placeholder={limitLoading ? 'Loading…' : `e.g. ${Math.max(grossPayrollTotal, 100).toFixed(2)}`}
                disabled={limitLoading}
                style={inputStyle}
              />
              {limitError && <p style={{ fontSize: 12, color: '#DC2626', marginTop: 6 }}>{limitError}</p>}
              {limitSaved && <p style={{ fontSize: 12, color: '#16A34A', marginTop: 6 }}>Saved.</p>}
            </div>
            <Button variant="brand" loading={limitSaving} onClick={handleSaveDailyLimit} size="sm">
              Save Limit
            </Button>
          </div>
        </Section>

        {/* ── Danger Zone ─────────────────────────────────────────────────── */}
        <div style={{
          background: '#FFFAFA', border: '1px solid #FCA5A5',
          borderRadius: 16, overflow: 'hidden',
        }}>
          <div style={{ padding: '16px 24px', borderBottom: '1px solid #FEE2E2' }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: '#DC2626', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={16} /> Danger Zone
            </h3>
          </div>
          <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <p style={{ fontSize: 14, fontWeight: 600, color: '#0F172A', margin: '0 0 2px' }}>Clear All Local Data</p>
                <p style={{ fontSize: 12, color: '#64748B', margin: 0 }}>Removes all employees, groups, and settings from this device. On-chain data is unaffected.</p>
              </div>
              <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => setDeleteOpen(true)} size="sm">
                Clear Data
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Delete data confirm modal */}
      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} maxWidth={380}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: 52, height: 52, borderRadius: '50%',
            background: '#FEF2F2', border: '1px solid #FCA5A5',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
          }}>
            <Trash2 size={22} color="#DC2626" />
          </div>
          <h3 style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', marginBottom: 8 }}>Clear all data?</h3>
          <p style={{ fontSize: 14, color: '#64748B', marginBottom: 24, lineHeight: 1.6 }}>
            All local employees, groups, and settings will be erased. Your Onchain contracts and IPFS data remain intact.
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => setDeleteOpen(false)} style={{
              flex: 1, padding: '10px 0', borderRadius: 10,
              border: '1.5px solid #E2E8F0', background: 'transparent',
              fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: '#475569',
            }}>Cancel</button>
            <Button variant="danger" onClick={handleDeleteAllData} style={{ flex: 1 }}>
              Yes, Clear All
            </Button>
          </div>
        </div>
      </Modal>

    </AppLayout>
  );
}
