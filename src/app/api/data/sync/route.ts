/**
 * @file app/api/data/sync/route.ts
 *
 * Uploads encrypted payroll data to IPFS via Pinata.
 * Requires wallet signature proof to prevent unauthorised writes.
 * Uses server-authoritative timestamps — client timestamps are never trusted.
 *
 * Flow:
 *   POST → verify wallet signature → upload to IPFS → return CID
 *   GET  → verify wallet signature → fetch from IPFS → return data
 *
 * The CID returned should be stored Onchain by the client via
 *   SaldenRegistry.updateCID(cid)
 *
 * Auth: client signs "Salden Sync: {timestamp}" with their wallet.
 *   Server checks timestamp is within 2 minutes of server time.
 *   Server verifies signature matches claimed walletAddress using viem.
 *
 * Encryption: client is responsible for AES-GCM encrypting the data
 *   before sending. The server stores whatever it receives on IPFS
 *   without reading plaintext employee data.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyMessage }             from 'viem';
import { isValidEthAddress }         from '@/lib/validation';
import { pinJSONToIPFS, fetchFromIPFS, unpinFromIPFS } from '@/lib/ipfs';

// ── IP rate limiter ───────────────────────────────────────────────────────────
const SYNC_RATE_MAP = new Map<string, { count: number; resetAt: number }>();
const SYNC_RATE_LIMIT  = 20;
const SYNC_RATE_WINDOW = 60 * 1000;

function checkSyncRateLimit(ip: string): boolean {
  const now = Date.now();
  const r   = SYNC_RATE_MAP.get(ip);
  if (!r || now > r.resetAt) { SYNC_RATE_MAP.set(ip, { count: 1, resetAt: now + SYNC_RATE_WINDOW }); return true; }
  if (r.count >= SYNC_RATE_LIMIT) return false;
  r.count += 1;
  return true;
}

// ── Nonce cache — prevents replay of valid signatures within the time window ──
// Key: wallet + timestamp + last-16-chars of signature (unique per request)
// Value: expiry timestamp — entries purged lazily on each new request
const NONCE_CACHE = new Map<string, number>();

function checkAndConsumNonce(walletAddress: string, timestamp: number, signature: string): boolean {
  const now = Date.now();

  // Lazy-purge expired nonces to keep Map bounded
  for (const [key, exp] of NONCE_CACHE) {
    if (now > exp) NONCE_CACHE.delete(key);
  }

  // Build a key that uniquely identifies this exact signed payload
  const nonce = `${walletAddress.toLowerCase()}-${timestamp}-${signature.slice(-20)}`;

  if (NONCE_CACHE.has(nonce)) return false; // replay detected

  // Store with the same TTL as the signature window
  NONCE_CACHE.set(nonce, now + SIGNATURE_WINDOW_MS);
  return true;
}

// ── Signature auth constants ───────────────────────────────────────────────────

const SIGNATURE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes — replay protection
const SIGN_MESSAGE_PREFIX  = 'Salden Sync: ';

// ── Simple in-memory CID index (wallet → latest CID) ─────────────────────────
// This is NOT the source of truth — IPFS is.
// It's a fast lookup cache that helps the GET endpoint find the latest CID
// without querying Pinata's list API every time.
// On cold start it's empty; clients should pass their known CID in GET requests.
const CID_INDEX = new Map<string, { cid: string; version: number; syncedAt: string }>();

// ── Shared helpers ────────────────────────────────────────────────────────────

function ipfsDisabled(): boolean {
  return !process.env.PINATA_JWT;
}

async function verifyWalletSignature(
  walletAddress: string,
  signature:     string,
  timestamp:     number,
): Promise<{ ok: boolean; error?: string }> {
  // 1. Timestamp freshness check (server-authoritative)
  const delta = Math.abs(Date.now() - timestamp);
  if (delta > SIGNATURE_WINDOW_MS) {
    return { ok: false, error: 'Signature timestamp expired. Please try again.' };
  }

  // 2. Reconstruct the exact message the client signed
  const message = `${SIGN_MESSAGE_PREFIX}${timestamp}`;

  // 3. Verify signature matches wallet using viem
  try {
    const valid = await verifyMessage({
      address:   walletAddress as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
    if (!valid) return { ok: false, error: 'Invalid wallet signature.' };
    return { ok: true };
  } catch (err) {
    console.error('[sync] Signature verification error:', err);
    return { ok: false, error: 'Signature verification failed.' };
  }
}

// ── POST — upload data to IPFS ─────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // IP rate limiting
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!checkSyncRateLimit(ip)) {
      return NextResponse.json(
        { success: false, error: 'Too many sync requests. Please wait before retrying.' },
        { status: 429 }
      );
    }

    // Parse body with runtime type validation — TypeScript casts give no runtime safety
    const body = await req.json();
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
    }

    const { walletAddress, encryptedData, signature, timestamp, previousCid } =
      body as Record<string, unknown>;

    if (typeof walletAddress !== 'string') {
      return NextResponse.json({ success: false, error: 'walletAddress must be a string' }, { status: 400 });
    }
    if (signature !== undefined && typeof signature !== 'string') {
      return NextResponse.json({ success: false, error: 'signature must be a string' }, { status: 400 });
    }
    if (timestamp !== undefined && typeof timestamp !== 'number') {
      return NextResponse.json({ success: false, error: 'timestamp must be a number' }, { status: 400 });
    }
    // previousCid is optional — only validate if provided
    const safePreviousCid = typeof previousCid === 'string' ? previousCid : undefined;

    // ── Input validation ───────────────────────────────────────────────────────
    if (!walletAddress || !isValidEthAddress(walletAddress)) {
      return NextResponse.json(
        { success: false, error: 'Valid wallet address required' },
        { status: 400 }
      );
    }

    if (!encryptedData) {
      return NextResponse.json(
        { success: false, error: 'encryptedData payload required' },
        { status: 400 }
      );
    }

    if (!signature || !timestamp) {
      return NextResponse.json(
        { success: false, error: 'Wallet signature and timestamp required' },
        { status: 401 }
      );
    }

    // ── Wallet ownership verification ──────────────────────────────────────────
    const authResult = await verifyWalletSignature(walletAddress, signature, timestamp);
    if (!authResult.ok) {
      return NextResponse.json(
        { success: false, error: authResult.error },
        { status: 401 }
      );
    }

    // ── Replay protection — same signature cannot be reused within the window ──
    if (typeof signature === 'string' && typeof timestamp === 'number') {
      if (!checkAndConsumNonce(walletAddress, timestamp, signature)) {
        return NextResponse.json(
          { success: false, error: 'Replay detected — this signed request has already been used.' },
          { status: 401 }
        );
      }
    }

    // ── Build envelope — server adds authoritative metadata ────────────────────
    const serverSyncedAt = new Date().toISOString(); // server-authoritative, not client
    const existing       = CID_INDEX.get(walletAddress.toLowerCase());
    const newVersion     = (existing?.version ?? 0) + 1;

    const envelope = {
      walletAddress: walletAddress.toLowerCase(),
      encryptedData,
      version:    newVersion,
      syncedAt:   serverSyncedAt, // server sets this — never trusted from client
    };

    // ── Upload to IPFS ─────────────────────────────────────────────────────────
    let cid:    string;
    let ipfsUrl: string;

    if (ipfsDisabled()) {
      // Development fallback when PINATA_JWT is not set
      console.warn('[sync] PINATA_JWT not set — skipping IPFS upload (dev mode)');
      cid     = `dev-cid-${Date.now()}`;
      ipfsUrl = '';
    } else {
      const pinResult = await pinJSONToIPFS(
        envelope,
        `salden-payroll-${walletAddress.slice(0, 8)}-v${newVersion}`
      );
      cid     = pinResult.cid;
      ipfsUrl = pinResult.url;

      // Unpin previous version to keep storage clean (non-fatal if it fails)
      if (safePreviousCid && safePreviousCid !== cid) {
        unpinFromIPFS(safePreviousCid).catch(err =>
          console.warn('[sync] Failed to unpin old CID:', safePreviousCid, err)
        );
      }
    }

    // ── Update local CID index (fast lookup cache) ─────────────────────────────
    CID_INDEX.set(walletAddress.toLowerCase(), {
      cid,
      version:  newVersion,
      syncedAt: serverSyncedAt,
    });

    console.info(
      `[sync] Uploaded for ${walletAddress.slice(0, 8)}… CID=${cid} v=${newVersion}`
    );

    return NextResponse.json({
      success:  true,
      cid,
      ipfsUrl,
      version:  newVersion,
      syncedAt: serverSyncedAt,  // return server time, not client time
      message:  'Synced to IPFS. Update Onchain CID via SaldenRegistry.updateCID(cid).',
    });
  } catch (err) {
    console.error('[sync] POST error:', err);
    return NextResponse.json(
      { success: false, error: 'Sync failed. Please try again.' },
      { status: 500 }
    );
  }
}

// ── GET — fetch data from IPFS ─────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const wallet    = searchParams.get('wallet');
    const cid       = searchParams.get('cid');        // client can provide known CID
    const signature = searchParams.get('signature');
    const timestamp = Number(searchParams.get('timestamp') ?? '0');

    if (!wallet || !isValidEthAddress(wallet)) {
      return NextResponse.json(
        { success: false, error: 'Valid wallet address required' },
        { status: 400 }
      );
    }

    // Require signature for reads too — prevent data enumeration
    if (!signature || !timestamp) {
      return NextResponse.json(
        { success: false, error: 'Wallet signature and timestamp required' },
        { status: 401 }
      );
    }

    const authResult = await verifyWalletSignature(wallet, signature, timestamp);
    if (!authResult.ok) {
      return NextResponse.json(
        { success: false, error: authResult.error },
        { status: 401 }
      );
    }

    // Resolve CID: client-provided → local cache → not found
    const resolvedCid = cid ?? CID_INDEX.get(wallet.toLowerCase())?.cid ?? null;

    if (!resolvedCid || ipfsDisabled()) {
      return NextResponse.json({ success: true, data: null, cid: null });
    }

    // Fetch from IPFS
    const envelope = await fetchFromIPFS<{
      encryptedData: unknown;
      version:       number;
      syncedAt:      string;
    }>(resolvedCid);

    return NextResponse.json({
      success:  true,
      data:     envelope.encryptedData,
      cid:      resolvedCid,
      version:  envelope.version,
      syncedAt: envelope.syncedAt,
    });
  } catch (err) {
    console.error('[sync] GET error:', err);
    return NextResponse.json(
      { success: false, error: 'Failed to retrieve sync data' },
      { status: 500 }
    );
  }
}
