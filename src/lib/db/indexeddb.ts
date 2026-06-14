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

const DB_NAME    = 'salden-db';
const DB_VERSION = 2;             // bumped: adds tokenCache store

export interface TxRecord {
  id: string;            // txHash
  hash: string;
  type: 'batchPay' | 'deploy' | 'addAgent' | 'approve' | 'other';
  walletAddress: string;
  amount: string;        // human-readable, e.g. "1,250.00"
  token: string;         // e.g. "USDC"
  recipientCount: number;
  timestamp: number;     // unix ms
  blockNumber?: number;
  invoiceEmailStatus?: 'sent' | 'failed' | 'pending' | null;
  invoiceEmailSentAt?: number | null;
  description?: string;
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
