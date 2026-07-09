/**
 * @file lib/db/indexeddb.ts
 * IndexedDB persistence for transaction history using the `idb` library.
 * Data is stored per wallet address and loads instantly on app open.
 */

import { openDB, type IDBPDatabase } from 'idb';

export interface TokenCacheEntry {
  walletAddress:  string;         // employer's payroll clone owner
  contractAddr:   string;         // payroll clone address
  tokenAddresses: string[];       // raw addresses from getSupportedTokens()
  cachedAt:       number;         // unix ms — used for 30-min TTL
}

/**
 * Local snapshot of the last-known-good payroll dataset, keyed per wallet.
 * This is NOT a source of truth — the IPFS CID anchored on SaldenRegistry
 * always is — it exists purely so the UI can paint instantly on
 * load/refresh instead of showing an empty dashboard while the
 * signature -> RPC -> IPFS -> decrypt round trip completes. `cidHash` (the
 * same keccak256 the registry contract stores) is what lets the frontend
 * cheaply tell "is this cache still current?" without re-fetching anything.
 *
 * `payload` is an ENCRYPTED envelope, not plaintext. The app's entire sync
 * design exists to keep employee names/wallets/salaries encrypted at rest
 * (via a wallet-signature-derived key) before they ever touch IPFS — a
 * plaintext local cache of that same data would quietly undermine that,
 * since IndexedDB content is trivially readable via devtools or a disk/
 * backup dump. This envelope is encrypted with a separate, non-wallet
 * device key (see getOrCreateDeviceKey) specifically so the fast path
 * never needs a wallet signature, while the data still isn't sitting in
 * the clear on disk. See AppContext.tsx's hydrateFromCache/syncData/
 * loadData for where this is encrypted/decrypted.
 */
export interface PayrollCacheEntry {
  walletAddress: string;
  cid:           string;
  cidHash:       string;    // keccak256(cid) — matches SaldenRegistry.getCIDHash()
  payload:       { iv: string; ciphertext: string };  // AES-GCM envelope, device-key encrypted
  cachedAt:      number;
}

const DB_NAME    = 'salden-db';
const DB_VERSION = 4;             // bumped: adds payrollCache + deviceKey stores

export interface TxRecord {
  id: string;            // txHash
  hash: string;
  ref: string;           // alphanumeric reference e.g. "SLD-A3F9K2"
  type: 'batchPay' | 'deploy' | 'addAgent' | 'approve' | 'other';
  status: 'success' | 'failed';
  walletAddress: string;
  amount: string;        // human-readable, e.g. "1,250.00"
  token: string;         // e.g. "USDC"
  remark?: string;       // memo remark e.g. "Salary Payment"
  recipientCount: number;
  timestamp: number;     // unix ms
  blockNumber?: number;
  invoiceEmailStatus?: 'sent' | 'failed' | 'pending' | null;
  invoiceEmailSentAt?: number | null;
  description?: string;
  /** Who triggered this transaction — drives invoice email wording and audit trail. */
  executedBy?: 'manual' | 'ai_agent';
}

export interface AgentLog {
  id: string;
  walletAddress: string;
  timestamp: number;
  action: string;         // human-readable description
  status: 'success' | 'failed';
  txHash?: string;
  details?: string;
}

export interface AgentSchedule {
  id: string;
  walletAddress: string;
  type: 'recurring' | 'scheduled';
  label: string;
  group?: string;
  employees?: string[];
  token: string;
  amount: string;
  cronExpression?: string;
  nextRunAt?: number;
  lastRunAt?: number;
  status: 'active' | 'paused' | 'completed' | 'failed';
  createdAt: number;
  runHistory: Array<{ timestamp: number; status: 'success' | 'failed'; txHash?: string }>;
  /**
   * Snapshot of exactly who gets paid how much, resolved CLIENT-SIDE (where
   * the decrypted employee list exists) at the moment this schedule was
   * created or last refreshed. This is what the server-side cron executor
   * actually pays — it has no way to decrypt the live employee list itself
   * (the AES key is derived from a wallet signature and never leaves the
   * browser, see AppContext.tsx's encryptionKeyRef). This means a salary
   * change AFTER scheduling won't be reflected until the schedule is
   * refreshed/recreated — an inherent constraint of this architecture, not
   * a bug. recipientCount lets the UI show "3 employees" without needing
   * to re-decrypt anything.
   */
  resolvedPayments?: Array<{ address: string; amount: string }>;
  recurrence?: 'weekly' | 'biweekly' | 'monthly';
  /** Snapshotted at creation time — the cron executor has no live session to
   *  look these up with. */
  agentWalletId?:      string;
  agentWalletAddress?: string;
  payrollCloneAddress?: string;
  tokenAddress?:        string;
  tokenDecimals?:       number;
  /**
   * Snapshot of payrollSetup.email at schedule-creation time, used to send
   * the invoice receipt once a scheduled payment confirms on-chain. This
   * cannot be live-fetched later — payrollSetup is only ever available
   * decrypted in the browser (see PayrollCacheEntry doc comment above), so
   * if this isn't captured now, it is permanently unavailable to the
   * server-side executor. Optional: schedules created before this field
   * existed, or by a user who never set a company email in Settings,
   * simply won't have an invoice email sent — handled as a graceful skip
   * wherever this is read, not an error state.
   */
  recipientEmail?: string;
}

let db: IDBPDatabase | null = null;
let dbPromise: Promise<IDBPDatabase> | null = null;  // lock prevents concurrent openDB calls

async function getDB(): Promise<IDBPDatabase> {
  // Guard: IndexedDB is not available in Node.js / SSR
  if (typeof window === 'undefined' || !window.indexedDB) {
    throw new Error('IndexedDB is only available in the browser');
  }

  // Return cached instance
  if (db) return db;

  // If already opening, wait for the same promise (prevents race condition)
  if (dbPromise) return dbPromise;

  dbPromise = openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains('transactions')) {
        const txStore = database.createObjectStore('transactions', { keyPath: 'id' });
        txStore.createIndex('by-wallet', 'walletAddress');
        txStore.createIndex('by-timestamp', 'timestamp');
      }
      if (!database.objectStoreNames.contains('agentLogs')) {
        const logStore = database.createObjectStore('agentLogs', { keyPath: 'id' });
        logStore.createIndex('by-wallet', 'walletAddress');
        logStore.createIndex('by-timestamp', 'timestamp');
      }
      if (!database.objectStoreNames.contains('agentSchedules')) {
        const schedStore = database.createObjectStore('agentSchedules', { keyPath: 'id' });
        schedStore.createIndex('by-wallet', 'walletAddress');
      }
      // v2 — token address cache (avoids on-chain read on every modal open)
      if (!database.objectStoreNames.contains('tokenCache')) {
        database.createObjectStore('tokenCache', { keyPath: 'contractAddr' });
      }
      // v3 — last-known-good payroll snapshot, for instant paint on
      // load/refresh (see PayrollCacheEntry doc comment above).
      if (!database.objectStoreNames.contains('payrollCache')) {
        database.createObjectStore('payrollCache', { keyPath: 'walletAddress' });
      }
      // v4 — device-local key used to encrypt payrollCache entries at rest.
      if (!database.objectStoreNames.contains('deviceKey')) {
        database.createObjectStore('deviceKey', { keyPath: 'id' });
      }
    },
  }).then(instance => {
    db        = instance;
    dbPromise = null;   // clear lock after success
    return instance;
  }).catch(err => {
    dbPromise = null;   // clear lock on failure so next call retries
    console.error('[IndexedDB] Failed to open database:', err);
    throw err;
  });

  return dbPromise;
}

// ── Transactions ──────────────────────────────────────────────────────────────

export async function saveTx(record: TxRecord): Promise<void> {
  const database = await getDB();
  await database.put('transactions', record);
}

export async function getTxsByWallet(walletAddress: string): Promise<TxRecord[]> {
  const database = await getDB();
  const all = await database.getAllFromIndex('transactions', 'by-wallet', walletAddress);
  return all.sort((a, b) => b.timestamp - a.timestamp);
}

export async function updateTxInvoiceStatus(
  id: string,
  status: 'sent' | 'failed',
  sentAt: number
): Promise<void> {
  const database = await getDB();
  const record = await database.get('transactions', id) as TxRecord | undefined;
  if (record) {
    record.invoiceEmailStatus = status;
    record.invoiceEmailSentAt = sentAt;
    await database.put('transactions', record);
  }
}

// ── Agent Logs ────────────────────────────────────────────────────────────────

export async function saveAgentLog(log: AgentLog): Promise<void> {
  const database = await getDB();
  await database.put('agentLogs', log);
}

export async function getAgentLogs(walletAddress: string): Promise<AgentLog[]> {
  const database = await getDB();
  const all = await database.getAllFromIndex('agentLogs', 'by-wallet', walletAddress);
  return all.sort((a, b) => b.timestamp - a.timestamp);
}

// ── Token Cache (on-chain supported tokens, 30-min TTL) ───────────────────────

const TOKEN_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export async function getCachedTokens(
  contractAddr: string
): Promise<string[] | null> {
  try {
    const database = await getDB();
    const entry    = await database.get('tokenCache', contractAddr) as TokenCacheEntry | undefined;
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > TOKEN_CACHE_TTL) return null; // expired
    return entry.tokenAddresses;
  } catch (err) {
    console.error('[IndexedDB] getCachedTokens error:', err);
    return null;
  }
}

export async function setCachedTokens(
  entry: TokenCacheEntry
): Promise<void> {
  try {
    const database = await getDB();
    await database.put('tokenCache', entry);
  } catch (err) {
    console.error('[IndexedDB] setCachedTokens error:', err);
  }
}

export async function saveAgentSchedule(schedule: AgentSchedule): Promise<void> {
  const database = await getDB();
  await database.put('agentSchedules', schedule);
}

export async function getAgentSchedules(walletAddress: string): Promise<AgentSchedule[]> {
  const database = await getDB();
  return database.getAllFromIndex('agentSchedules', 'by-wallet', walletAddress);
}

export async function deleteAgentSchedule(id: string): Promise<void> {
  const database = await getDB();
  await database.delete('agentSchedules', id);
}

// ── Payroll data cache (instant-paint snapshot, see PayrollCacheEntry) ────────

export async function getCachedPayrollSnapshot(
  walletAddress: string
): Promise<PayrollCacheEntry | null> {
  try {
    const database = await getDB();
    const entry = await database.get('payrollCache', walletAddress.toLowerCase()) as PayrollCacheEntry | undefined;
    return entry ?? null;
  } catch (err) {
    console.error('[IndexedDB] getCachedPayrollSnapshot error:', err);
    return null;
  }
}

export async function setCachedPayrollSnapshot(entry: PayrollCacheEntry): Promise<void> {
  try {
    const database = await getDB();
    await database.put('payrollCache', { ...entry, walletAddress: entry.walletAddress.toLowerCase() });
  } catch (err) {
    console.error('[IndexedDB] setCachedPayrollSnapshot error:', err);
  }
}

export async function clearCachedPayrollSnapshot(walletAddress: string): Promise<void> {
  try {
    const database = await getDB();
    await database.delete('payrollCache', walletAddress.toLowerCase());
  } catch (err) {
    console.error('[IndexedDB] clearCachedPayrollSnapshot error:', err);
  }
}

// ── Device-local encryption key for the payroll cache ────────────────────────
//
// This key is NOT derived from a wallet signature — it's a random AES-GCM
// key generated once per browser profile and persisted locally. That's a
// deliberate choice: deriving it from a signature would mean reading the
// local cache needs a wallet prompt, which defeats the entire point of
// caching (instant paint with zero wallet interaction). It's also
// meaningfully better than plaintext: IndexedDB content is trivially
// readable by opening devtools or dumping a browser profile from disk, and
// this key means that inspection doesn't hand over employee names/wallets/
// salaries directly. It does NOT protect against a malicious script already
// running in this origin (it could read the key from the same store) — no
// client-side-only scheme can fully protect against that; the actual
// confidentiality guarantee for data at rest in the outside world remains
// the wallet-signature-derived key used for the real IPFS-synced payload.
let _deviceKeyPromise: Promise<CryptoKey> | null = null;

export async function getOrCreateDeviceKey(): Promise<CryptoKey> {
  if (_deviceKeyPromise) return _deviceKeyPromise;

  _deviceKeyPromise = (async () => {
    const database = await getDB();
    const existing = await database.get('deviceKey', 'default') as { id: string; keyB64: string } | undefined;

    if (existing?.keyB64) {
      const raw = Uint8Array.from(atob(existing.keyB64), c => c.charCodeAt(0));
      return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }

    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const exported = await crypto.subtle.exportKey('raw', key);
    const bytes = new Uint8Array(exported);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    await database.put('deviceKey', { id: 'default', keyB64: btoa(binary) });

    // Re-import as non-extractable for actual use, so the live CryptoKey
    // object itself can't be exported again by other code in this origin.
    return crypto.subtle.importKey('raw', exported, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  })();

  return _deviceKeyPromise;
}
