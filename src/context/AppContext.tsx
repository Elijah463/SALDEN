'use client';
/**
 * @file context/AppContext.tsx
 * Global application state — migrated from ThirdWeb to wagmi + Circle.
 * Preserves all existing data patterns: IPFS + encryption + IndexedDB.
 */

import {
  createContext, useContext, useReducer, useCallback,
  useRef, useEffect, ReactNode,
} from 'react';
import { saveTx, type TxRecord } from '@/lib/db/indexeddb';
import { getCachedPayrollSnapshot, setCachedPayrollSnapshot, getOrCreateDeviceKey } from '@/lib/db/indexeddb';
import { keccak256, toHex } from 'viem';
import { DEFAULT_GROUPS } from '@/lib/groups';
import {
  DEFAULT_TOKEN_REGISTRY,
  type TokenRegistry,
} from '@/lib/token-registry';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Employee {
  fullName:      string;
  department:    string;
  walletAddress: string;
  salaryAmount:  number;
  group?:        string;
}

export interface PayrollSetup {
  companyName:  string;
  fullName?:    string;
  email:        string;
  employeeRange?: string;
  registryClone?: string;
  payrollClone?: string;
}

interface Toast {
  id:      string;
  message: string;
  type:    'success' | 'error' | 'warning' | 'info';
}

interface AppState {
  account:            string | null;
  isWalletConnected:  boolean;
  encryptionKey:      string | null;
  hasSignedMessage:   boolean;
  registryClone:      string | null;
  payrollClone:       string | null;   // premium clone (MultiTokenPayroll)
  isPremiumUser:      boolean;
  payrollSetup:       PayrollSetup | null;
  employees:          Employee[];
  groups:             string[];
  activeGroup:        string;          // 'All Employees' | group name
  isSyncing:          boolean;
  syncError:          string | null;
  lastSyncedAt:       string | null;
  /** True when checkCidFreshness (via usePayrollSync) has detected that the
   *  on-chain CID hash no longer matches what's currently loaded/cached,
   *  AND there's local data on screen that a silent overwrite could clobber.
   *  Drives a "Newer data available — Sync now" prompt rather than a silent
   *  background overwrite. */
  syncAvailable:      boolean;
  pendingCid:         string | null;
  toasts:             Toast[];
  companyName:        string;
  tokenRegistry:      TokenRegistry;
};

type Action =
  | { type: 'SET_ACCOUNT';        payload: string | null }
  | { type: 'SET_ENCRYPTION_KEY'; payload: string }
  | { type: 'SET_REGISTRY';       payload: string }
  | { type: 'SET_PAYROLL_CLONE';  payload: string }
  | { type: 'SET_PREMIUM';        payload: boolean }
  | { type: 'SET_PAYROLL_DATA';   payload: Partial<AppState> }
  | { type: 'SET_EMPLOYEES';      payload: Employee[] }
  | { type: 'SET_GROUPS';         payload: string[] }
  | { type: 'SET_ACTIVE_GROUP';   payload: string }
  | { type: 'SET_SYNCING';        payload: boolean }
  | { type: 'SET_SYNC_ERROR';     payload: string | null }
  | { type: 'SET_LAST_SYNCED';    payload: string }
  | { type: 'SET_SYNC_AVAILABLE'; payload: { available: boolean; cid: string | null } }
  | { type: 'ADD_TOAST';          payload: Toast }
  | { type: 'REMOVE_TOAST';       payload: string }
  | { type: 'SET_COMPANY_NAME';   payload: string }
  | { type: 'SET_TOKEN_REGISTRY'; payload: TokenRegistry }
  | { type: 'RESET' };

const initial: AppState = {
  account:           null,
  isWalletConnected: false,
  encryptionKey:     null,
  hasSignedMessage:  false,
  registryClone:     null,
  payrollClone:      null,
  isPremiumUser:     false,
  payrollSetup:      null,
  employees:         [],
  groups:            [...DEFAULT_GROUPS],
  activeGroup:       'All Employees',
  isSyncing:         false,
  syncError:         null,
  lastSyncedAt:      null,
  syncAvailable:     false,
  pendingCid:        null,
  toasts:            [],
  companyName:       '',
  tokenRegistry:     DEFAULT_TOKEN_REGISTRY,
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_ACCOUNT':
      return { ...state, account: action.payload, isWalletConnected: !!action.payload };
    case 'SET_ENCRYPTION_KEY':
      return { ...state, encryptionKey: action.payload, hasSignedMessage: true };
    case 'SET_REGISTRY':
      return { ...state, registryClone: action.payload };
    case 'SET_PAYROLL_CLONE':
      return { ...state, payrollClone: action.payload, isPremiumUser: true };
    case 'SET_PREMIUM':
      return { ...state, isPremiumUser: action.payload };
    case 'SET_PAYROLL_DATA':
      return { ...state, ...action.payload };
    case 'SET_EMPLOYEES':
      return { ...state, employees: action.payload };
    case 'SET_GROUPS':
      return { ...state, groups: action.payload };
    case 'SET_ACTIVE_GROUP':
      return { ...state, activeGroup: action.payload };
    case 'SET_SYNCING':
      return { ...state, isSyncing: action.payload };
    case 'SET_SYNC_ERROR':
      return { ...state, syncError: action.payload };
    case 'SET_LAST_SYNCED':
      return { ...state, lastSyncedAt: action.payload };
    case 'SET_SYNC_AVAILABLE':
      return { ...state, syncAvailable: action.payload.available, pendingCid: action.payload.cid };
    case 'ADD_TOAST':
      return { ...state, toasts: [...state.toasts, action.payload] };
    case 'REMOVE_TOAST':
      return { ...state, toasts: state.toasts.filter(t => t.id !== action.payload) };
    case 'SET_COMPANY_NAME':
      return { ...state, companyName: action.payload };
    case 'SET_TOKEN_REGISTRY':
      return { ...state, tokenRegistry: action.payload };
    case 'RESET':
      return { ...initial };
    default:
      return state;
  }
}

// ── Context ────────────────────────────────────────────────────────────────────

interface AppContextValue {
  state:        AppState;
  dispatch:     React.Dispatch<Action>;
  addToast:     (message: string, type?: Toast['type'], duration?: number) => void;
  removeToast:  (id: string) => void;
  syncData:     (opts: {
    employees?:   Employee[];
    walletAddress: string;
    /** Pass walletClient.signMessage to enable authenticated sync */
    signMessage?: (msg: string) => Promise<string>;
    /** Previous IPFS CID — server unpins it after successful upload */
    previousCid?: string;
  }) => Promise<{ cid?: string }>;
  /** Loads + decrypts previously-synced data from IPFS (via a known CID,
   *  normally read from SaldenRegistry.getCID()) and hydrates app state. */
  loadData:     (opts: {
    walletAddress: string;
    cid:           string;
    signMessage:   (msg: string) => Promise<string>;
  }) => Promise<{ loaded: boolean }>;
  /** Instant, no-network, no-signature hydration from the local IndexedDB
   *  snapshot left by the last successful syncData/loadData for this wallet.
   *  This is what lets employees/groups/payrollSetup paint immediately on
   *  page load instead of waiting on the signature -> RPC -> IPFS -> decrypt
   *  round trip. Returns the cached CID hash (if any) so the caller
   *  (usePayrollSync) can cheaply compare it against the on-chain
   *  getCIDHash() to decide whether a background sync is needed. This never
   *  talks to the network — it only reads local browser storage. */
  hydrateFromCache: (walletAddress: string) => Promise<{ hydrated: boolean; cid: string | null; cidHash: string | null }>;
  saveTxRecord: (record: Omit<TxRecord, 'walletAddress'>, walletAddress: string) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const stateRef = useRef(state);
  stateRef.current = state;

  // ── Toast ──────────────────────────────────────────────────────────────────

  // Track toast timeout IDs so we can clear them if toasts are manually dismissed
  const toastTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Clear ALL pending toast timers when the provider unmounts
  useEffect(() => {
    return () => {
      toastTimers.current.forEach(timer => clearTimeout(timer));
      toastTimers.current.clear();
    };
  }, []);

  const addToast = useCallback((message: string, type: Toast['type'] = 'info', duration = 4000) => {
    const id = crypto.randomUUID();
    dispatch({ type: 'ADD_TOAST', payload: { id, message, type } });

    const timer = setTimeout(() => {
      dispatch({ type: 'REMOVE_TOAST', payload: id });
      toastTimers.current.delete(id);
    }, duration);

    toastTimers.current.set(id, timer);
  }, []);

  // Cached derived encryption key — derived once per session, reset on page reload
  const encryptionKeyRef  = useRef<CryptoKey | null>(null);
  // Track which wallet the cached key belongs to — reset if wallet changes
  const encryptionWallet  = useRef<string | null>(null);
  // Latest known IPFS CID, shared across every page — keeps "previousCid"
  // bookkeeping correct regardless of which page last synced or loaded data.
  const lastCidRef = useRef<string | null>(null);

  /** Convert a hex string to Uint8Array without using Node.js Buffer (browser-safe) */
  function hexToUint8Array(hex: string): Uint8Array {
    const clean = hex.replace(/^0x/, '');
    const arr   = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) {
      arr[i / 2] = parseInt(clean.slice(i, i + 2), 16);
    }
    return arr;
  }

  /**
   * Fixed, non-timestamped message used ONLY to derive the local data
   * encryption key. Ethereum personal-message signatures are deterministic
   * (RFC 6979) — signing this exact same string always reproduces the exact
   * same signature (and therefore the exact same derived key) for a given
   * wallet, forever, across every session and device.
   *
   * IMPORTANT: this must NEVER include a timestamp, nonce, or anything else
   * that changes between calls. The auth signature used for sync/load
   * requests (`Salden Sync: {timestamp}`) is intentionally a SEPARATE,
   * freshly-signed message — reusing it for key material (as a previous
   * version of this file did) meant the derived key rotated on every single
   * sync, permanently locking out any previously-uploaded data.
   */
  const ENCRYPTION_KEY_MESSAGE =
    'Salden Payroll: sign to derive your local data-encryption key.\n\nThis signature is never sent anywhere — it only unlocks your own encrypted data on this device.';

  /** Derive AES-GCM key from a signature's bytes. */
  async function deriveKeyFromSignature(signature: string): Promise<CryptoKey> {
    const keyBytes = hexToUint8Array(signature).slice(0, 32);
    return crypto.subtle.importKey(
      'raw', keyBytes as BufferSource,
      { name: 'AES-GCM', length: 256 },
      false, ['encrypt', 'decrypt']
    );
  }

  /**
   * Returns the cached encryption key for this wallet, deriving (and
   * prompting one signature) only the first time it's needed per session.
   */
  async function getEncryptionKey(
    walletAddress: string,
    signMessage:   (msg: string) => Promise<string>,
  ): Promise<CryptoKey> {
    if (encryptionKeyRef.current && encryptionWallet.current === walletAddress) {
      return encryptionKeyRef.current;
    }
    const signature = await signMessage(ENCRYPTION_KEY_MESSAGE);
    const key        = await deriveKeyFromSignature(signature);
    encryptionKeyRef.current = key;
    encryptionWallet.current = walletAddress;
    return key;
  }

  /** Browser-safe base64 encode — no spread operator (avoids call-stack limits on large payloads). */
  function toBase64(input: ArrayBuffer | Uint8Array): string {
    const arr    = input instanceof Uint8Array ? input : new Uint8Array(input);
    let   binary = '';
    for (let i = 0; i < arr.length; i++) {
      binary += String.fromCharCode(arr[i]);
    }
    return btoa(binary);
  }

  /** Browser-safe base64 decode → Uint8Array. */
  function fromBase64(b64: string): Uint8Array {
    const binary = atob(b64);
    const arr    = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    return arr;
  }

  async function encryptPayload(payload: unknown, key: CryptoKey): Promise<{
    iv: string; ciphertext: string; encoding: string;
  }> {
    const iv        = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext as BufferSource);

    return {
      iv:         toBase64(iv),
      ciphertext: toBase64(encrypted),
      encoding:   'aes-gcm-v1',
    };
  }

  /** Symmetric counterpart to encryptPayload — decrypts a previously-encrypted blob. */
  async function decryptPayload<T = unknown>(
    blob: { iv: string; ciphertext: string; encoding?: string },
    key:  CryptoKey,
  ): Promise<T> {
    const iv         = fromBase64(blob.iv);
    const ciphertext = fromBase64(blob.ciphertext);
    const decrypted  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ciphertext as BufferSource);
    return JSON.parse(new TextDecoder().decode(decrypted)) as T;
  }

  /** Type guard: does this look like an encrypted envelope (vs. a plaintext fallback payload)? */
  function isEncryptedBlob(v: unknown): v is { iv: string; ciphertext: string; encoding?: string } {
    return !!v && typeof v === 'object' && typeof (v as { iv?: unknown }).iv === 'string'
      && typeof (v as { ciphertext?: unknown }).ciphertext === 'string';
  }

  // ── Sync data to IPFS via Pinata ─────────────────────────────────────────

  const syncData = useCallback(async (opts: {
    employees?:    Employee[];
    walletAddress: string;
    signMessage?:  (msg: string) => Promise<string>;
    previousCid?:  string;
  }): Promise<{ cid?: string }> => {
    const s = stateRef.current;
    if (!opts.walletAddress) return {};

    dispatch({ type: 'SET_SYNCING', payload: true });
    try {
      const employees  = opts.employees ?? s.employees;
      const rawPayload = {
        setup:         s.payrollSetup,
        employees,
        groups:        s.groups,
        tokenRegistry: s.tokenRegistry,  // token names persist to IPFS
      };

      // ── Auth signature: fresh, timestamp-bound, sent to the server so it
      //    can verify + replay-protect this specific request.
      let signature:    string | undefined;
      let timestamp:    number | undefined;
      let encryptedData: unknown = rawPayload; // plaintext fallback

      if (opts.signMessage) {
        timestamp = Date.now();
        signature = await opts.signMessage(`Salden Sync: ${timestamp}`);

        try {
          // ── Encryption key: STABLE per wallet, derived from a fixed
          //    message (never the timestamped auth signature above) so the
          //    same key can re-derive and decrypt this data in any future
          //    session. Cached after first use — only prompts once.
          if (encryptionWallet.current !== opts.walletAddress) {
            encryptionKeyRef.current = null;
          }
          const key = await getEncryptionKey(opts.walletAddress, opts.signMessage);
          encryptedData = await encryptPayload(rawPayload, key);
        } catch (encErr) {
          console.warn('[AppContext] Encryption failed, storing plaintext:', encErr);
          encryptedData = rawPayload;
        }
      }

      const res = await fetch('/api/data/sync', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress: opts.walletAddress,
          encryptedData,
          signature,
          timestamp,
          previousCid: opts.previousCid ?? lastCidRef.current ?? undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Sync failed');

      lastCidRef.current = data.cid ?? lastCidRef.current;
      dispatch({ type: 'SET_LAST_SYNCED', payload: new Date().toISOString() });
      dispatch({ type: 'SET_SYNC_ERROR',  payload: null });
      dispatch({ type: 'SET_SYNC_AVAILABLE', payload: { available: false, cid: null } });

      // Cache what we just wrote — a syncData call always reflects the
      // current in-memory state, so this is by definition fresh. Encrypted
      // at rest with the device key (see getOrCreateDeviceKey) — this is
      // the same employee/salary data the app deliberately encrypts before
      // it ever touches IPFS, so it must not sit in plaintext in
      // IndexedDB either.
      if (data.cid) {
        try {
          const cidHash = keccak256(toHex(data.cid));
          const deviceKey = await getOrCreateDeviceKey();
          const encrypted = await encryptPayload(rawPayload, deviceKey);
          await setCachedPayrollSnapshot({
            walletAddress: opts.walletAddress,
            cid:           data.cid,
            cidHash,
            payload:       encrypted,
            cachedAt:      Date.now(),
          });
        } catch (cacheErr) {
          // Never let a local-cache write failure surface as a sync failure —
          // the actual IPFS sync already succeeded at this point.
          console.warn('[AppContext] Failed to update local payroll cache:', cacheErr);
        }
      }

      console.info('[AppContext] Synced to IPFS. CID:', data.cid);
      return { cid: data.cid };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sync failed';
      console.error('[AppContext] syncData error:', err);
      dispatch({ type: 'SET_SYNC_ERROR', payload: msg });
      throw err;
    } finally {
      dispatch({ type: 'SET_SYNCING', payload: false });
    }
  }, []);

  // ── Load data back from IPFS (via a known CID) and hydrate state ────────────
  // This is the read-side counterpart to syncData — without it, employees /
  // groups / payrollSetup only ever existed in memory for the current tab,
  // and reset to empty on every reload or new session.
  const loadData = useCallback(async (opts: {
    walletAddress: string;
    cid:           string;
    signMessage:   (msg: string) => Promise<string>;
  }): Promise<{ loaded: boolean }> => {
    if (!opts.walletAddress || !opts.cid) return { loaded: false };

    const timestamp = Date.now();
    const signature = await opts.signMessage(`Salden Sync: ${timestamp}`);

    const params = new URLSearchParams({
      wallet:    opts.walletAddress,
      cid:       opts.cid,
      signature,
      timestamp: String(timestamp),
    });
    const res  = await fetch(`/api/data/sync?${params.toString()}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'Failed to load data');
    if (!body.data) return { loaded: false };

    let payload: { setup?: PayrollSetup; employees?: Employee[]; groups?: string[]; tokenRegistry?: TokenRegistry };

    if (isEncryptedBlob(body.data)) {
      const key = await getEncryptionKey(opts.walletAddress, opts.signMessage);
      payload   = await decryptPayload(body.data, key);
    } else {
      // Plaintext fallback (encryption failed at write-time, or IPFS disabled in dev)
      payload = body.data as typeof payload;
    }

    dispatch({ type: 'SET_PAYROLL_DATA', payload: {
      employees:     payload.employees     ?? [],
      groups:        (payload.groups && payload.groups.length > 0) ? payload.groups : [...DEFAULT_GROUPS],
      payrollSetup:  payload.setup         ?? stateRef.current.payrollSetup,
      tokenRegistry: payload.tokenRegistry ?? stateRef.current.tokenRegistry,
      lastSyncedAt:  new Date().toISOString(),
    } });
    dispatch({ type: 'SET_SYNC_AVAILABLE', payload: { available: false, cid: null } });
    lastCidRef.current = opts.cid;

    try {
      const cidHash = keccak256(toHex(opts.cid));
      const deviceKey = await getOrCreateDeviceKey();
      const encrypted = await encryptPayload(payload, deviceKey);
      await setCachedPayrollSnapshot({
        walletAddress: opts.walletAddress,
        cid:           opts.cid,
        cidHash,
        payload:       encrypted,
        cachedAt:      Date.now(),
      });
    } catch (cacheErr) {
      console.warn('[AppContext] Failed to update local payroll cache:', cacheErr);
    }

    return { loaded: true };
  }, []);

  // ── Instant local hydration (no network, no signature) ──────────────────────
  const hydrateFromCache = useCallback(async (
    walletAddress: string,
  ): Promise<{ hydrated: boolean; cid: string | null; cidHash: string | null }> => {
    if (!walletAddress) return { hydrated: false, cid: null, cidHash: null };
    const entry = await getCachedPayrollSnapshot(walletAddress);
    if (!entry) return { hydrated: false, cid: null, cidHash: null };

    let payload: { setup?: PayrollSetup; employees?: Employee[]; groups?: string[]; tokenRegistry?: TokenRegistry };
    try {
      const deviceKey = await getOrCreateDeviceKey();
      payload = await decryptPayload(entry.payload, deviceKey);
    } catch (err) {
      // Envelope unreadable (corrupted, or a device key generated by a
      // different browser profile/environment) — treat as a cache miss
      // rather than crashing the app on a bad local cache entry.
      console.warn('[AppContext] Failed to decrypt local payroll cache, ignoring it:', err);
      return { hydrated: false, cid: null, cidHash: null };
    }

    dispatch({ type: 'SET_PAYROLL_DATA', payload: {
      employees:     payload.employees     ?? [],
      groups:        (payload.groups && payload.groups.length > 0) ? payload.groups : [...DEFAULT_GROUPS],
      payrollSetup:  payload.setup         ?? stateRef.current.payrollSetup,
      tokenRegistry: payload.tokenRegistry ?? stateRef.current.tokenRegistry,
      lastSyncedAt:  new Date(entry.cachedAt).toISOString(),
    } });
    lastCidRef.current = entry.cid;

    return { hydrated: true, cid: entry.cid, cidHash: entry.cidHash };
  }, []);

  const saveTxRecord = useCallback(async (
    record: Omit<TxRecord, 'walletAddress'>,
    walletAddress: string,
  ) => {
    if (!walletAddress) return;
    await saveTx({ ...record, walletAddress });
  }, []);

  const removeToast = useCallback((id: string) => {
    const timer = toastTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimers.current.delete(id);
    }
    dispatch({ type: 'REMOVE_TOAST', payload: id });
  }, []);

  return (
    <AppContext.Provider value={{ state, dispatch, addToast, removeToast, syncData, loadData, hydrateFromCache, saveTxRecord }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
