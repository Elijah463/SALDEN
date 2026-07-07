/**
 * @file lib/kv.ts
 * SERVER-SIDE ONLY.
 *
 * Optional, zero-dependency Vercel KV client. This codebase previously had
 * no persistent store anywhere — every "server state" (rate limits, spend
 * limits, session nonces, agent schedules) lived in a plain in-memory Map,
 * which only works correctly on a single long-lived Node process. On
 * Vercel's serverless platform, separate invocations can land on separate
 * instances with separate memory, so those Maps silently lose data.
 *
 * This module talks directly to the Vercel KV / Upstash Redis REST API
 * using plain `fetch` — no new npm dependency, no new env var invented by
 * us. It reads the exact env var names Vercel itself injects automatically
 * the moment you attach a KV store to this project in the Vercel dashboard:
 *
 *   KV_REST_API_URL
 *   KV_REST_API_TOKEN
 *
 * If you haven't attached a KV store yet, both of those are simply undefined
 * and every function below becomes a safe no-op (`kvAvailable()` returns
 * false, reads return null, writes return false). Every caller of this
 * module is written to fall back to its existing in-memory Map in that
 * case — so nothing breaks today, and everything upgrades to real
 * cross-instance persistence the moment you attach a KV store, with no
 * further code changes and no new env vars to configure by hand.
 *
 * Deliberately minimal: GET / SET (with optional TTL) / DEL. That's all
 * every caller in this codebase needs.
 */

function restUrl(): string | null {
  return process.env.KV_REST_API_URL ?? null;
}

function restToken(): string | null {
  return process.env.KV_REST_API_TOKEN ?? null;
}

/** True once a KV store is attached (both env vars present). Callers use
 *  this to decide whether to even attempt a round-trip, or to skip
 *  straight to their in-memory fallback. */
export function kvAvailable(): boolean {
  return !!restUrl() && !!restToken();
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${restToken()}` };
}

/** Fetch a value. Returns null on any failure (not configured, network
 *  error, key missing) — callers never need to distinguish "not
 *  configured" from "not found", since the correct behaviour is the same
 *  either way: fall back to the in-memory path. */
export async function kvGet<T>(key: string): Promise<T | null> {
  if (!kvAvailable()) return null;
  try {
    const res = await fetch(`${restUrl()}/get/${encodeURIComponent(key)}`, {
      headers: authHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json() as { result: string | null };
    if (data.result == null) return null;
    return JSON.parse(data.result) as T;
  } catch {
    return null;
  }
}

/** Set a value, optionally with a TTL in seconds. Returns true on success,
 *  false on any failure (including "not configured") — callers should
 *  treat false as "the in-memory copy is now the only copy" and proceed
 *  with that, rather than surfacing an error to the end user. */
export async function kvSet(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
  if (!kvAvailable()) return false;
  try {
    const body = encodeURIComponent(JSON.stringify(value));
    const path = ttlSeconds
      ? `/set/${encodeURIComponent(key)}/${body}/EX/${ttlSeconds}`
      : `/set/${encodeURIComponent(key)}/${body}`;
    const res = await fetch(`${restUrl()}${path}`, { method: 'POST', headers: authHeaders() });
    return res.ok;
  } catch {
    return false;
  }
}

/** Atomic increment of an integer counter, creating it at 0 first if
 *  needed. Returns null on any failure so callers fall back to their
 *  in-memory counter for this operation. Used for rate limiting, where
 *  atomicity across instances actually matters (a plain get-then-set
 *  would race under concurrent requests). */
export async function kvIncr(key: string, ttlSeconds?: number): Promise<number | null> {
  if (!kvAvailable()) return null;
  try {
    const res = await fetch(`${restUrl()}/incr/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) return null;
    const data = await res.json() as { result: number };
    // Set the TTL only on first creation (result === 1) so repeated
    // increments within the window don't keep pushing the expiry back.
    if (ttlSeconds && data.result === 1) {
      await fetch(`${restUrl()}/expire/${encodeURIComponent(key)}/${ttlSeconds}`, {
        method: 'POST', headers: authHeaders(),
      }).catch(() => { /* best-effort — a missing TTL just means the key never expires, not a correctness bug */ });
    }
    return data.result;
  } catch {
    return null;
  }
}

export async function kvDelete(key: string): Promise<boolean> {
  if (!kvAvailable()) return false;
  try {
    const res = await fetch(`${restUrl()}/del/${encodeURIComponent(key)}`, {
      method: 'POST', headers: authHeaders(),
    });
    return res.ok;
  } catch {
    return false;
  }
}
