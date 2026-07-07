/**
 * @file lib/agent/scheduleStore.ts
 * SERVER-SIDE ONLY.
 *
 * Store for AI Agent payment schedules, checked by the cron endpoint
 * (app/api/agent/cron/run-schedules/route.ts) to decide what to
 * autonomously execute and when.
 *
 * ── Persistence model ──────────────────────────────────────────────────
 * This used to be a bare in-memory Map, which meant scheduled/recurring
 * payments were unreliable in production: Vercel doesn't guarantee a
 * serverless instance's memory survives between invocations (cold starts,
 * scaling to multiple concurrent instances, redeploys), so the cron job
 * could easily run against an empty store. The mitigation was
 * /api/agent/schedule/sync self-healing the store whenever a user opened
 * "Manage AI Agent" — better than nothing, but a schedule due to fire
 * during a window where nobody had the app open could still be missed.
 *
 * This now mirrors everything into lib/kv.ts (Vercel KV / Upstash Redis)
 * when a KV store is attached to the project, while keeping the exact
 * same in-memory Map as a same-instance fast path AND as the fallback
 * when no KV store is attached — so this still works today with zero
 * config, and upgrades to true cross-instance reliability the moment you
 * attach a KV store in the Vercel dashboard. No new env vars needed:
 * lib/kv.ts reads the standard KV_REST_API_URL / KV_REST_API_TOKEN
 * Vercel injects automatically for you.
 *
 * KV layout (chosen to avoid needing SCAN/sorted-set support in the
 * minimal lib/kv.ts client):
 *   agentSchedules:index              -> JSON array of wallet addresses
 *                                         (lowercased) that have ever synced
 *                                         a schedule
 *   agentSchedules:wallet:<address>   -> JSON array of that wallet's
 *                                         AgentSchedule objects
 *
 * Every write updates the in-memory Map first (so a read immediately
 * after a write on the SAME instance is always correct even if the KV
 * round-trip below it fails or is slow) and then best-effort mirrors to
 * KV. Every read merges KV (cross-instance truth) with the in-memory Map
 * (this instance's freshest truth) so neither source alone needs to be
 * perfectly authoritative.
 */

import type { AgentSchedule } from '@/lib/db/indexeddb';
import { kvGet, kvSet, kvAvailable } from '@/lib/kv';

export function computeNextRun(fromTimestamp: number, recurrence: 'weekly' | 'biweekly' | 'monthly'): number {
  const d = new Date(fromTimestamp);
  if (recurrence === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (recurrence === 'biweekly') d.setUTCDate(d.getUTCDate() + 14);
  else d.setUTCMonth(d.getUTCMonth() + 1); // monthly
  return d.getTime();
}

const _schedules = new Map<string, AgentSchedule>(); // same-instance fast path + fallback when KV isn't attached

const INDEX_KEY = 'agentSchedules:index';
function walletBlobKey(walletAddress: string): string {
  return `agentSchedules:wallet:${walletAddress.toLowerCase()}`;
}

async function readIndex(): Promise<string[]> {
  const idx = await kvGet<string[]>(INDEX_KEY);
  return idx ?? [];
}

async function addToIndex(walletAddress: string): Promise<void> {
  const wallet = walletAddress.toLowerCase();
  const idx = await readIndex();
  if (!idx.includes(wallet)) {
    idx.push(wallet);
    await kvSet(INDEX_KEY, idx);
  }
}

async function readWalletBlob(walletAddress: string): Promise<AgentSchedule[]> {
  const blob = await kvGet<AgentSchedule[]>(walletBlobKey(walletAddress));
  return blob ?? [];
}

async function writeWalletBlob(walletAddress: string, schedules: AgentSchedule[]): Promise<void> {
  await kvSet(walletBlobKey(walletAddress), schedules);
}

/** Merges the in-memory copy for a wallet on top of whatever KV returned,
 *  keyed by schedule id — in-memory wins on conflict, since it's
 *  guaranteed to reflect this instance's most recent write. */
function mergeWithMemory(walletAddress: string, fromKv: AgentSchedule[]): AgentSchedule[] {
  const wallet = walletAddress.toLowerCase();
  const byId = new Map<string, AgentSchedule>(fromKv.map(s => [s.id, s]));
  for (const s of _schedules.values()) {
    if (s.walletAddress.toLowerCase() === wallet) byId.set(s.id, s);
  }
  return [...byId.values()];
}

export async function upsertSchedule(schedule: AgentSchedule): Promise<void> {
  await upsertSchedules([schedule]);
}

// ⚠ KNOWN RACE: if the same wallet syncs schedules from two places at once
// (e.g. two open tabs) within the same moment, both requests read-modify-
// write the same wallet blob, and the second write wins — the first
// request's changes to OTHER schedules in that same blob could be lost
// (each request's own schedules are always preserved, since both include
// their own full intended state; it's a third schedule neither request
// touched, sitting alongside them in the same blob, that could
// theoretically be dropped if updated by exactly the same-millisecond
// concurrent request). This module doesn't have transactional
// read-modify-write (the minimal lib/kv.ts client only exposes plain
// GET/SET/INCR). Acceptable here since schedule syncs are low-frequency,
// human-triggered actions (not a hot concurrent path), and the in-memory
// Map on whichever instance handles the LATER request always reflects
// that request's own writes correctly regardless. If this ever becomes a
// real hot path, the fix is a compare-and-swap or a per-wallet lock key.
export async function upsertSchedules(schedules: AgentSchedule[]): Promise<void> {
  for (const s of schedules) _schedules.set(s.id, s);

  if (!kvAvailable() || schedules.length === 0) return;

  // Group by wallet so each wallet's blob is only read-modified-written once.
  const byWallet = new Map<string, AgentSchedule[]>();
  for (const s of schedules) {
    const wallet = s.walletAddress.toLowerCase();
    if (!byWallet.has(wallet)) byWallet.set(wallet, []);
    byWallet.get(wallet)!.push(s);
  }

  for (const [wallet, incoming] of byWallet) {
    const existing = await readWalletBlob(wallet);
    const byId = new Map(existing.map(s => [s.id, s]));
    for (const s of incoming) byId.set(s.id, s);
    await writeWalletBlob(wallet, [...byId.values()]);
    await addToIndex(wallet);
  }
}

export async function removeSchedule(id: string): Promise<void> {
  const existing = _schedules.get(id);
  _schedules.delete(id);

  if (!kvAvailable() || !existing) return;

  const wallet = existing.walletAddress.toLowerCase();
  const blob = await readWalletBlob(wallet);
  await writeWalletBlob(wallet, blob.filter(s => s.id !== id));
}

export async function getDueSchedules(now: number): Promise<AgentSchedule[]> {
  const isDue = (s: AgentSchedule) => s.status === 'active' && typeof s.nextRunAt === 'number' && s.nextRunAt <= now;

  if (!kvAvailable()) {
    return [..._schedules.values()].filter(isDue);
  }

  const wallets = await readIndex();
  const byId = new Map<string, AgentSchedule>();
  for (const wallet of wallets) {
    const blob = mergeWithMemory(wallet, await readWalletBlob(wallet));
    for (const s of blob) byId.set(s.id, s);
  }
  // Also fold in any in-memory-only wallets that somehow never made it into
  // the index (e.g. addToIndex failed mid-write) — belt and braces.
  for (const s of _schedules.values()) byId.set(s.id, s);

  return [...byId.values()].filter(isDue);
}

export async function getSchedulesForWallet(walletAddress: string): Promise<AgentSchedule[]> {
  const w = walletAddress.toLowerCase();
  if (!kvAvailable()) {
    return [..._schedules.values()].filter(s => s.walletAddress.toLowerCase() === w);
  }
  return mergeWithMemory(walletAddress, await readWalletBlob(walletAddress));
}

export async function markScheduleRun(
  id: string,
  result: { status: 'success' | 'failed'; txHash?: string; nextRunAt?: number },
): Promise<void> {
  const existing = _schedules.get(id);
  if (!existing) return;

  existing.lastRunAt = Date.now();
  existing.runHistory = [...existing.runHistory, { timestamp: Date.now(), status: result.status, txHash: result.txHash }].slice(-50);
  if (result.status === 'failed') {
    existing.status = 'failed';
  } else if (result.nextRunAt) {
    existing.nextRunAt = result.nextRunAt; // recurring — schedule the next run
  } else {
    existing.status = 'completed'; // one-off — done
  }
  _schedules.set(id, existing);

  if (!kvAvailable()) return;
  const wallet = existing.walletAddress.toLowerCase();
  const blob = await readWalletBlob(wallet);
  const idx = blob.findIndex(s => s.id === id);
  if (idx >= 0) blob[idx] = existing; else blob.push(existing);
  await writeWalletBlob(wallet, blob);
}
