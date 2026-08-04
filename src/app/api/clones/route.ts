/**
 * @file app/api/clones/route.ts
 *
 * GET  /api/clones?address=0x...            → { registryClone, payrollClone }
 * POST /api/clones  { address, registryClone?, payrollClone? } → { success }
 *
 * Thin HTTP wrapper around lib/serverCloneCache.ts — see that file for the
 * full reasoning. GET is the cache-first read every call site checks before
 * falling back to an on-chain lookup; POST is the write-through every call
 * site fires (fire-and-forget, best-effort) right after a fresh on-chain
 * discovery, so the NEXT lookup for that address — from any page, any
 * device, any browser — hits the cache instead of RPC.
 *
 * Both endpoints fail soft: a cache miss, a misconfigured/unattached KV
 * store, or any internal error here should never block the caller's own
 * on-chain fallback, so errors are swallowed into a "nothing cached" /
 * "not stored" response rather than a hard failure the caller would have
 * to specially handle.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { getCachedClones, setCachedClones } from '@/lib/serverCloneCache';

export const dynamic = 'force-dynamic';

// Light IP throttle on the write path only — reads are cheap/idempotent
// and every page hits GET on load, so it isn't rate-limited; POST only
// ever fires once per genuinely-new on-chain discovery per call site, so a
// generous limit here is purely an abuse guard, not something a real user
// should ever come close to.
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

export async function GET(req: NextRequest) {
  try {
    const address = req.nextUrl.searchParams.get('address');
    if (!address || !isAddress(address)) {
      return NextResponse.json({ error: 'A valid address is required.' }, { status: 400 });
    }
    const cached = await getCachedClones(address);
    return NextResponse.json({
      registryClone: cached?.registryClone ?? null,
      payrollClone:  cached?.payrollClone  ?? null,
    });
  } catch (err) {
    // Fail soft — a cache-read problem should look exactly like a cache
    // miss to the caller, never an error it needs to special-case.
    console.error('[clones GET] Error:', err);
    return NextResponse.json({ registryClone: null, payrollClone: null });
  }
}

interface ClonesUpdateBody {
  address?:        string;
  registryClone?:  string;
  payrollClone?:   string;
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!checkIPRateLimit(ip)) {
      return NextResponse.json({ success: false, error: 'Too many requests.' }, { status: 429 });
    }

    const body = await req.json() as ClonesUpdateBody;
    const { address, registryClone, payrollClone } = body;

    if (!address || !isAddress(address)) {
      return NextResponse.json({ error: 'A valid address is required.' }, { status: 400 });
    }
    if (registryClone && !isAddress(registryClone)) {
      return NextResponse.json({ error: 'registryClone must be a valid address.' }, { status: 400 });
    }
    if (payrollClone && !isAddress(payrollClone)) {
      return NextResponse.json({ error: 'payrollClone must be a valid address.' }, { status: 400 });
    }

    const update: { registryClone?: string; payrollClone?: string } = {};
    if (registryClone) update.registryClone = registryClone;
    if (payrollClone)  update.payrollClone  = payrollClone;

    if (Object.keys(update).length > 0) {
      await setCachedClones(address, update);
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    // Best-effort cache — never surface a write failure as an error the
    // caller needs to handle; the on-chain value is already correct in the
    // caller's own state regardless of whether this cache write lands.
    console.error('[clones POST] Error:', err);
    return NextResponse.json({ success: false });
  }
}
