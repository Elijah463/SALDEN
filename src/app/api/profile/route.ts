/**
 * @file app/api/profile/route.ts
 *
 * GET  /api/profile?address=0x...                     → { companyName, email }
 * POST /api/profile  { address, companyName?, email? } → { success }
 *
 * Thin HTTP wrapper around lib/serverProfileCache.ts — see that file for
 * the full reasoning. GET is the fast, no-wallet-signature-required path
 * every page checks first so company name / receipt email render
 * immediately on any browser or device; POST is the write-through fired
 * (best-effort, fire-and-forget) right after Settings > Save Profile and
 * after the initial employee-setup wizard finishes, so the next read from
 * anywhere picks up the new values.
 *
 * Both endpoints fail soft, matching api/clones/route.ts's contract: a
 * cache miss, an unattached KV store, or any internal error here should
 * never block a caller's existing IPFS-hydration fallback.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { getCachedProfile, setCachedProfile } from '@/lib/serverProfileCache';
import { sanitizeString } from '@/lib/validation';

export const dynamic = 'force-dynamic';

// Same light IP throttle shape as api/clones/route.ts — reads are cheap and
// hit on every page load, so only the write path is limited.
const IP_RATE_MAP = new Map<string, { count: number; resetAt: number }>();
const IP_RATE_LIMIT  = 60;
const IP_RATE_WINDOW = 10 * 60 * 1000;

function checkIPRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = IP_RATE_MAP.get(ip);
  if (!record || now > record.resetAt) {
    IP_RATE_MAP.set(ip, { count: 1, resetAt: now + IP_RATE_WINDOW });
    return true;
  }
  if (record.count >= IP_RATE_LIMIT) return false;
  record.count += 1;
  return true;
}

// Loose sanity check only — the same email is already accepted as-is
// wherever it's typed in Settings; this just guards against obviously
// malformed values landing in the cache, not a full RFC validation.
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function GET(req: NextRequest) {
  try {
    const address = req.nextUrl.searchParams.get('address');
    if (!address || !isAddress(address)) {
      return NextResponse.json({ error: 'A valid address is required.' }, { status: 400 });
    }
    const cached = await getCachedProfile(address);
    return NextResponse.json({
      companyName: cached?.companyName ?? null,
      email:       cached?.email       ?? null,
    });
  } catch (err) {
    console.error('[profile GET] Error:', err);
    return NextResponse.json({ companyName: null, email: null });
  }
}

interface ProfileUpdateBody {
  address?:     string;
  companyName?: string;
  email?:       string;
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!checkIPRateLimit(ip)) {
      return NextResponse.json({ success: false, error: 'Too many requests.' }, { status: 429 });
    }

    const body = await req.json() as ProfileUpdateBody;
    const { address } = body;

    if (!address || !isAddress(address)) {
      return NextResponse.json({ error: 'A valid address is required.' }, { status: 400 });
    }

    const companyName = typeof body.companyName === 'string' ? sanitizeString(body.companyName) : undefined;
    const email        = typeof body.email === 'string' ? body.email.trim().slice(0, 254) : undefined;
    if (email && !looksLikeEmail(email)) {
      return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
    }

    // Always writes both fields together (never merges) — Settings > Save
    // Profile and the setup wizard both always have both values in hand
    // when they call this, so there's no "only one field known" case like
    // serverCloneCache.ts has to handle for its two independently-
    // discovered addresses.
    await setCachedProfile(address, { companyName, email });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[profile POST] Error:', err);
    return NextResponse.json({ success: false });
  }
}
