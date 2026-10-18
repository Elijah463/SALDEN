/**
 * Server-side access tier for the AI agent. SERVER ONLY.
 *
 * A wallet is Pro only when BOTH hold:
 *   1. it owns a payroll clone (`payrollOf(wallet)` on the factory), and
 *   2. that clone's subscription is still running (`isProActive(clone)`).
 *
 * The clone address is cached because it never changes. The expiry is never cached:
 * it is read from the chain on every check, so a lapsed subscription takes effect
 * immediately. If the chain cannot be read, the wallet is treated as not Pro.
 */
import { NextResponse } from 'next/server';
import { getServerPublicClient } from './chain';
import { CONTRACTS } from '@/lib/contracts/config';
import { MULTI_TOKEN_FACTORY_ABI } from '@/lib/contracts/abis';
import { getCachedClones, setCachedClones } from '@/lib/serverCloneCache';
import { kvIncr, kvGet, kvAvailable } from '@/lib/kv';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Free-tier allowance: messages per window. */
export const FREE_MESSAGE_LIMIT = 5;
/** Free-tier window length, in fixed clock-aligned buckets. */
export const FREE_WINDOW_SECONDS = 5 * 60 * 60;

async function cloneFor(address: string): Promise<string | null> {
  try {
    const cached = await getCachedClones(address);
    if (cached?.payrollClone && cached.payrollClone.toLowerCase() !== ZERO_ADDRESS) {
      return cached.payrollClone;
    }
  } catch { /* the cache is an optimisation only */ }

  const existing = await getServerPublicClient().readContract({
    address:      CONTRACTS.MULTI_TOKEN_FACTORY,
    abi:          MULTI_TOKEN_FACTORY_ABI,
    functionName: 'payrollOf',
    args:         [address as `0x${string}`],
  }) as `0x${string}`;

  if (!existing || existing.toLowerCase() === ZERO_ADDRESS) return null;
  await setCachedClones(address, { payrollClone: existing }).catch(() => {});
  return existing;
}

export interface ProStatus {
  clone: string | null;
  /** Unix seconds when the subscription ends (0 if none). */
  expiresAt: number;
  active: boolean;
}

/** Full Pro status for a wallet. Fails closed: any read error means not Pro. */
export async function getProStatus(address: string): Promise<ProStatus> {
  try {
    const clone = await cloneFor(address);
    if (!clone) return { clone: null, expiresAt: 0, active: false };

    const client = getServerPublicClient();
    const [expiresAt, active] = await Promise.all([
      client.readContract({
        address: CONTRACTS.MULTI_TOKEN_FACTORY, abi: MULTI_TOKEN_FACTORY_ABI,
        functionName: 'proExpiry', args: [clone as `0x${string}`],
      }) as Promise<bigint>,
      client.readContract({
        address: CONTRACTS.MULTI_TOKEN_FACTORY, abi: MULTI_TOKEN_FACTORY_ABI,
        functionName: 'isProActive', args: [clone as `0x${string}`],
      }) as Promise<boolean>,
    ]);
    return { clone, expiresAt: Number(expiresAt), active: active === true };
  } catch {
    return { clone: null, expiresAt: 0, active: false };
  }
}

export async function isProWallet(address: string): Promise<boolean> {
  return (await getProStatus(address)).active;
}

// Per-instance fallback counter, used only when no KV store is attached or a KV call
// fails. Without it, free chat was refused outright on every message.
const _freeLocal = new Map<string, number>();

function bumpFreeLocal(key: string): number {
  if (_freeLocal.size > 5000) _freeLocal.clear(); // buckets rotate every few hours; a reset only grants a fresh allowance
  const next = (_freeLocal.get(key) ?? 0) + 1;
  _freeLocal.set(key, next);
  return next;
}

/**
 * Counts one free-tier message in the current fixed window. Uses the shared KV counter
 * when available, otherwise a per-instance counter (so the allowance is approximate
 * across serverless instances until a KV store is attached).
 */
export async function consumeFreeMessage(address: string): Promise<{ allowed: boolean; retryAfterSeconds?: number; remaining: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(nowSec / FREE_WINDOW_SECONDS);
  const retryAfterSeconds = (bucket + 1) * FREE_WINDOW_SECONDS - nowSec;
  const key = `agent:free:${address.toLowerCase()}:${bucket}`;
  let count: number | null = null;
  if (kvAvailable()) count = await kvIncr(key, FREE_WINDOW_SECONDS * 2);
  if (count === null) count = bumpFreeLocal(key);
  // Computed from the SAME count this call just incremented, no extra KV
  // round trip, so the chat route can tell the client (and the model, so
  // it can actually answer "how many messages do I have left?" instead of
  // deflecting) how many remain after this message, not just whether this
  // one was allowed.
  const remaining = Math.max(0, FREE_MESSAGE_LIMIT - count);
  if (count > FREE_MESSAGE_LIMIT) return { allowed: false, retryAfterSeconds, remaining: 0 };
  return { allowed: true, remaining };
}

/**
 * Read-only peek at a wallet's free-tier quota for the CURRENT window, without
 * consuming a message. Used by the status endpoint so the client can know
 * it's locked out BEFORE it ever lets the person type another message, e.g.
 * right after a page refresh or when a brand-new chat is opened, instead of
 * only finding out once a message is sent. Keyed and windowed exactly like
 * consumeFreeMessage, so a value this reports as "locked" is one that
 * consumeFreeMessage would also refuse, same bucket, same source of truth.
 */
export async function getFreeStatus(address: string): Promise<{ limitReached: boolean; remaining: number; retryAfterSeconds: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(nowSec / FREE_WINDOW_SECONDS);
  const retryAfterSeconds = (bucket + 1) * FREE_WINDOW_SECONDS - nowSec;
  const key = `agent:free:${address.toLowerCase()}:${bucket}`;
  let count: number | null = null;
  if (kvAvailable()) count = await kvGet<number>(key);
  if (count === null) count = _freeLocal.get(key) ?? 0;
  const remaining = Math.max(0, FREE_MESSAGE_LIMIT - count);
  return { limitReached: count >= FREE_MESSAGE_LIMIT, remaining, retryAfterSeconds };
}

/** A 403 for wallets without an active Salden Pro subscription, or null to continue. */
export async function requirePro(address: string): Promise<NextResponse | null> {
  if (await isProWallet(address)) return null;
  return NextResponse.json(
    { error: 'An active Salden Pro subscription is required to use the AI agent.', upgradeRequired: true },
    { status: 403 },
  );
}
