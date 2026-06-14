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
  email:        string;
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
  groups:            [],
  activeGroup:       'All Employees',
  isSyncing:         false,
  syncError:         null,
  lastSyncedAt:      null,
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
   * Derive AES-GCM key from a signature's bytes.
   * The caller provides the signature so we reuse the already-obtained auth
   * signature — avoiding a second wallet popup.
   */
  async function deriveKeyFromSignature(signature: string): Promise<CryptoKey> {
    const keyBytes = hexToUint8Array(signature).slice(0, 32);
    return crypto.subtle.importKey(
      'raw', keyBytes,
      { name: 'AES-GCM', length: 256 },
      false, ['encrypt', 'decrypt']
    );
  }

  async function encryptPayload(payload: unknown, key: CryptoKey): Promise<{
    iv: string; ciphertext: string; encoding: string;
  }> {
    const iv        = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

    /**
     * Browser-safe base64 encoding — does NOT use spread operator.
     * `btoa(String.fromCharCode(...largeArray))` throws "Maximum call stack
     * size exceeded" in V8 for arrays > ~65,536 elements (triggered by
     * organisations with 200+ employees). This loop approach has no limit.
     */
    const toBase64 = (input: ArrayBuffer | Uint8Array): string => {
      const arr    = input instanceof Uint8Array ? input : new Uint8Array(input);
      let   binary = '';
      for (let i = 0; i < arr.length; i++) {
        binary += String.fromCharCode(arr[i]);
      }
      return btoa(binary);
    };

    return {
      iv:         toBase64(iv),
      ciphertext: toBase64(encrypted),
      encoding:   'aes-gcm-v1',
    };
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

      // ── Sign ONCE for auth. Reuse that same signature as encryption key
      //    material so the user only ever sees ONE wallet popup per sync.
      let signature:    string | undefined;
      let timestamp:    number | undefined;
      let encryptedData: unknown = rawPayload; // plaintext fallback

      if (opts.signMessage) {
        timestamp = Date.now();
        signature = await opts.signMessage(`Salden Sync: ${timestamp}`);

        try {
          // If wallet changed since last sync, discard the old key
          if (encryptionWallet.current !== opts.walletAddress) {
            encryptionKeyRef.current = null;
            encryptionWallet.current = opts.walletAddress;
          }

          const key = encryptionKeyRef.current
            ?? await deriveKeyFromSignature(signature);
          encryptionKeyRef.current = key;
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
          previousCid: opts.previousCid,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Sync failed');

      dispatch({ type: 'SET_LAST_SYNCED', payload: new Date().toISOString() });
      dispatch({ type: 'SET_SYNC_ERROR',  payload: null });

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
    <AppContext.Provider value={{ state, dispatch, addToast, removeToast, syncData, saveTxRecord }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
