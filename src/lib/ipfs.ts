/**
 * @file lib/ipfs.ts
 * IPFS upload via Pinata REST API.
 * Uses fetch directly — no extra npm package needed.
 *
 * Required env var: PINATA_JWT
 * Get it from: https://app.pinata.cloud → API Keys → New Key → Pinning permissions
 *
 * CID returned uses v1 (base32) — universally compatible with IPFS gateways.
 */

const PINATA_API  = 'https://api.pinata.cloud';
const IPFS_GATEWAY = 'https://gateway.pinata.cloud/ipfs';

function getPinataJWT(): string {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error('PINATA_JWT environment variable is not configured');
  return jwt;
}

// ── Upload JSON to IPFS ───────────────────────────────────────────────────────

export interface PinResult {
  cid:      string;    // IPFS CID (v1)
  url:      string;    // gateway URL
  size:     number;    // bytes pinned
  pinnedAt: string;    // ISO timestamp
}

export async function pinJSONToIPFS(
  content:  unknown,
  name:     string,
): Promise<PinResult> {
  const jwt = getPinataJWT();

  const res = await fetch(`${PINATA_API}/pinning/pinJSONToIPFS`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      pinataContent:  content,
      pinataMetadata: { name, keyvalues: { app: 'salden', version: '1' } },
      pinataOptions:  { cidVersion: 1 },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`Pinata upload failed (${res.status}): ${JSON.stringify(err)}`);
  }

  const data = await res.json() as { IpfsHash: string; PinSize: number; Timestamp: string };

  return {
    cid:      data.IpfsHash,
    url:      `${IPFS_GATEWAY}/${data.IpfsHash}`,
    size:     data.PinSize,
    pinnedAt: data.Timestamp,
  };
}

// ── Fetch JSON from IPFS ──────────────────────────────────────────────────────

export async function fetchFromIPFS<T = unknown>(cid: string): Promise<T> {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 10_000); // 10 s

  try {
    const res = await fetch(`${IPFS_GATEWAY}/${cid}`, {
      headers: { 'Accept': 'application/json' },
      signal:  controller.signal,
    });

    if (!res.ok) {
      throw new Error(`IPFS fetch failed for CID ${cid}: ${res.statusText}`);
    }

    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Unpin CID (cleanup old versions) ─────────────────────────────────────────

export async function unpinFromIPFS(cid: string): Promise<void> {
  const jwt = getPinataJWT();

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 5_000); // 5 s

  try {
    const res = await fetch(`${PINATA_API}/pinning/unpin/${encodeURIComponent(cid)}`, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${jwt}` },
      signal:  controller.signal,
    });

    if (!res.ok && res.status !== 404) {
      console.warn(`[IPFS] Failed to unpin CID ${cid}: ${res.statusText}`);
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.warn(`[IPFS] unpin timed out for CID ${cid}`);
    } else {
      console.warn(`[IPFS] unpin error for CID ${cid}:`, err);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ── Build public IPFS URL ─────────────────────────────────────────────────────

export function ipfsUrl(cid: string): string {
  return `${IPFS_GATEWAY}/${cid}`;
}
