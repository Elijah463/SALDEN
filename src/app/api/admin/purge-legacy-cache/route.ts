/**
 * @file app/api/admin/purge-legacy-cache/route.ts
 * SERVER-SIDE ONLY. One-off maintenance endpoint.
 *
 * Deletes server-side KV entries written before cache keys were scoped by chain ID, which
 * is how entries from the testnet deployment can still be sitting in the store. Keys are
 * now `<name>:<chainId>:<wallet>`; the legacy ones are `<name>:<wallet>` (a 0x address
 * right after the prefix), so these patterns never match an entry written by the current code.
 *
 * Protected with the existing CRON_SECRET (Authorization: Bearer <CRON_SECRET>), so no new
 * environment variable is needed. Dry run by default: nothing is deleted unless
 * `confirm=true` is passed.
 *
 *   scope=caches (default)  clones, profile, permission-grant caches. Safe: all of it is
 *                           re-derived from on-chain reads the next time it is needed.
 *   scope=all               also agent settings and state that is not chain-tagged: autonomous
 *                           mode, employer daily limits, saved schedules and their index,
 *                           daily spend counters, free-chat counters. These cannot be told
 *                           apart from entries made on this network since launch, so
 *                           scope=all removes both.
 *
 * Examples (replace the host and secret):
 *   curl -H "Authorization: Bearer $CRON_SECRET" "https://HOST/api/admin/purge-legacy-cache"
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" "https://HOST/api/admin/purge-legacy-cache?confirm=true"
 */

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { kvAvailable, kvScanKeys, kvDeleteMany } from '@/lib/kv';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CACHE_PATTERNS = [
  'clones:0x*',
  'profile:0x*',
  'agentPermissionsGranted:0x*',
];

const STATE_PATTERNS = [
  'agentMode:0x*',
  'employerDailyLimit:0x*',
  'agentSchedules:*',
  'agent:spend:0x*',
  'agent:free:0x*',
];

function authorised(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  const header = req.headers.get('authorization') ?? '';
  if (!expected) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handle(req: NextRequest, mayDelete: boolean) {
  if (!authorised(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!kvAvailable()) {
    return NextResponse.json({
      ok: true,
      kvConfigured: false,
      message: 'No KV store is attached to this deployment, so there is no server-side cache here to clear.',
    });
  }

  const scope = req.nextUrl.searchParams.get('scope') === 'all' ? 'all' : 'caches';
  const confirm = req.nextUrl.searchParams.get('confirm') === 'true' && mayDelete;
  const patterns = scope === 'all' ? [...CACHE_PATTERNS, ...STATE_PATTERNS] : CACHE_PATTERNS;

  try {
    const report: Array<{ pattern: string; found: number; deleted: number }> = [];
    for (const pattern of patterns) {
      const keys = await kvScanKeys(pattern);
      const deleted = confirm && keys.length > 0 ? await kvDeleteMany(keys) : 0;
      report.push({ pattern, found: keys.length, deleted });
    }
    return NextResponse.json({
      ok: true,
      kvConfigured: true,
      scope,
      dryRun: !confirm,
      note: confirm
        ? 'Deleted.'
        : 'Dry run, nothing was deleted. Send a POST with ?confirm=true to delete.',
      report,
    });
  } catch (err) {
    console.error('[purge-legacy-cache] failed:', err);
    return NextResponse.json({ ok: false, error: 'Purge failed. Check the server logs.' }, { status: 500 });
  }
}

// GET is always a dry run; deletion needs a POST so a stray link or prefetch can never delete anything.
export async function GET(req: NextRequest)  { return handle(req, false); }
export async function POST(req: NextRequest) { return handle(req, true); }
