/**
 * @file app/api/analytics/track/route.ts
 *
 * POST /api/analytics/track
 *
 * The ONLY path by which a browser can cause an analytics event to reach
 * the external Salden Analytics service. lib/analytics.ts's `track()` is
 * server-only (it holds ANALYTICS_INGEST_SECRET) and cannot be called
 * directly from client components — this route exists specifically for
 * the three events that genuinely originate client-side (the user signs
 * the underlying transaction with their own wallet, in the browser):
 *
 *   - user_registered  (dashboard/page.tsx  → ProfileSetupModal, after
 *     RegistryFactory.createRegistry() confirms)
 *   - user_upgraded    (pricing/page.tsx    → handleUpgrade, after
 *     MultiTokenFactory.deployPayroll() confirms)
 *   - batch_paid       (dashboard/page.tsx  → handleExecutePayroll, after
 *     the manual batchPay confirms)
 *
 * `agent_activated` and `payroll_executed` are deliberately NOT accepted
 * here — those only ever happen server-side (activate/route.ts and the
 * autonomous execution paths in chat/route.ts + lib/inngest/functions.ts)
 * and call lib/analytics.ts's track() directly. Accepting them here would
 * let anyone inflate those two metrics from the browser with no
 * corresponding real event.
 *
 * ── Why this route needs no wallet-signature session ────────────────────
 * Requiring the user to sign yet another message just to log a metrics
 * event is bad UX for something this low-stakes (no funds move here).
 * Instead this follows the exact pattern already established by
 * app/api/invoice/send/route.ts for the same class of problem ("a client
 * claims an on-chain event happened"): trust the CHAIN, not the caller.
 * The submitted txHash must be a real, confirmed, successful transaction,
 * and its `from` address must match the claimed walletAddress. A caller
 * can only "spoof" an event by pointing at a transaction that genuinely
 * happened from a wallet they don't control — at which point they've
 * gained nothing (the metric reflects a real event either way) rather
 * than fabricating one from nothing.
 *
 * ── Known limitation ──────────────────────────────────────────────────
 * The analytics service's Event model (see that repo's prisma/schema.prisma)
 * has no unique constraint on txHash, so nothing on the receiving end
 * stops the SAME real, valid txHash from being recorded more than once if
 * this route is called for it repeatedly. The in-memory dedup set below
 * closes the accidental case (double-click, a retried fetch, React
 * effects firing twice) on a best-effort, single-instance basis — same
 * caveat as every other in-memory Map in this codebase (rateLimiter.ts,
 * lib/agent/auth.ts's nonce store, etc.), not a cross-instance or
 * adversarial guarantee. If you need real dedup, add a unique index on
 * (eventType, txHash) in the analytics service's schema and let the
 * insert fail/upsert instead.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAddress, getAddress } from 'viem';
import { getServerPublicClient } from '@/lib/agent/chain';
import { track } from '@/lib/analytics';

type ClientTriggerableEvent = 'user_registered' | 'user_upgraded' | 'batch_paid';

const ALLOWED_EVENTS: ReadonlySet<string> = new Set<ClientTriggerableEvent>([
  'user_registered', 'user_upgraded', 'batch_paid',
]);

// Same lightweight, single-instance, best-effort pattern as
// api/invoice/send/route.ts's own limiter — deliberately not shared with
// that module's instance so the two endpoints' limits stay independently
// tunable.
const IP_RATE_MAP = new Map<string, { count: number; resetAt: number }>();
const IP_RATE_LIMIT  = 30;
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

// Best-effort replay guard — see "Known limitation" above. Bounded so it
// can't grow forever on a long-lived instance.
const SEEN_TX_HASHES = new Set<string>();
const MAX_SEEN_TX_HASHES = 5_000;

function markSeen(txHash: string): boolean {
  const key = txHash.toLowerCase();
  if (SEEN_TX_HASHES.has(key)) return false;
  if (SEEN_TX_HASHES.size >= MAX_SEEN_TX_HASHES) {
    // Cheap eviction: drop the oldest-inserted entry (Set preserves
    // insertion order). Not LRU, just bounds memory.
    const oldest = SEEN_TX_HASHES.values().next().value;
    if (oldest) SEEN_TX_HASHES.delete(oldest);
  }
  SEEN_TX_HASHES.add(key);
  return true;
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!checkIPRateLimit(ip)) {
      return NextResponse.json({ error: 'Too many analytics requests from this IP. Please wait before trying again.' }, { status: 429 });
    }

    const body = await req.json() as {
      event?:         string;
      walletAddress?: string;
      txHash?:        string;
      employeeCount?: number;
      volumeUsdc?:    number;
    };

    const { event, walletAddress, txHash, employeeCount, volumeUsdc } = body;

    if (!event || !ALLOWED_EVENTS.has(event)) {
      return NextResponse.json({ error: 'Unsupported or missing event type for client-triggered analytics.' }, { status: 400 });
    }
    if (!walletAddress || !isAddress(walletAddress)) {
      return NextResponse.json({ error: 'A valid walletAddress is required.' }, { status: 400 });
    }
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return NextResponse.json({ error: 'A valid txHash is required.' }, { status: 400 });
    }
    if (event === 'batch_paid' && (employeeCount == null || volumeUsdc == null)) {
      return NextResponse.json({ error: 'employeeCount and volumeUsdc are required for batch_paid.' }, { status: 400 });
    }

    // ── On-chain verification — see file header ───────────────────────────
    let receipt;
    try {
      receipt = await getServerPublicClient().getTransactionReceipt({ hash: txHash as `0x${string}` });
    } catch {
      return NextResponse.json({ error: 'That transaction could not be found on-chain.' }, { status: 400 });
    }
    if (!receipt || receipt.status !== 'success') {
      return NextResponse.json({ error: 'That transaction is not a confirmed, successful on-chain transaction.' }, { status: 400 });
    }

    const claimedWallet = getAddress(walletAddress);
    const txFrom = getAddress(receipt.from);
    if (txFrom !== claimedWallet) {
      return NextResponse.json({ error: 'That transaction was not sent by the claimed wallet.' }, { status: 403 });
    }

    if (!markSeen(txHash)) {
      // Already forwarded this exact tx — treat as a harmless duplicate,
      // not an error, so a retried client fetch doesn't surface a failure
      // toast for an event that already succeeded.
      return NextResponse.json({ ok: true, deduped: true });
    }

    switch (event as ClientTriggerableEvent) {
      case 'user_registered':
        await track({ event: 'user_registered', walletAddress: claimedWallet });
        break;
      case 'user_upgraded':
        await track({ event: 'user_upgraded', walletAddress: claimedWallet });
        break;
      case 'batch_paid':
        await track({
          event: 'batch_paid', walletAddress: claimedWallet,
          employeeCount: employeeCount!, volumeUsdc: volumeUsdc!, txHash,
        });
        break;
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Could not record analytics event.' }, { status: 500 });
  }
}
