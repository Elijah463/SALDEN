/**
 * @file app/api/agent/limits/route.ts
 * Lets an employer view and set their own daily AI-agent spend limit
 * (Settings page). See lib/agent/employerLimits.ts and the updated
 * lib/agent/spendLimits.ts for how this interacts with the platform-wide
 * absolute ceiling (AGENT_MAX_DAILY_TOTAL) — this is an additional,
 * tighter-or-equal limit the employer chooses, never a way to exceed the
 * platform ceiling.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '@/lib/agent/auth';
import { getEmployerDailyLimit, setEmployerDailyLimit } from '@/lib/agent/employerLimits';
import { PLATFORM_MAX_DAILY_TOTAL, MAX_SINGLE_PAYMENT } from '@/lib/agent/spendLimits';

function getSession(req: NextRequest, walletAddress: string) {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  return verifySessionToken(token, walletAddress);
}

export async function GET(req: NextRequest) {
  try {
    const walletAddress = req.nextUrl.searchParams.get('wallet');
    if (!walletAddress) return NextResponse.json({ error: 'wallet required' }, { status: 400 });

    const session = getSession(req, walletAddress);
    if (!session.ok) {
      return NextResponse.json({ error: 'Your session has expired. Please sign in again.' }, { status: 401 });
    }

    const employerLimit = await getEmployerDailyLimit(walletAddress);
    return NextResponse.json({
      employerLimit,                      // null if never configured — Settings should show the platform default as a placeholder in that case
      platformCeiling: PLATFORM_MAX_DAILY_TOTAL,
      maxSinglePayment: MAX_SINGLE_PAYMENT,
    });
  } catch (err) {
    console.error('[agent/limits GET]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { walletAddress?: string; amount?: number; grossPayrollTotal?: number };
    const { walletAddress, amount, grossPayrollTotal } = body;

    if (!walletAddress || typeof amount !== 'number' || typeof grossPayrollTotal !== 'number') {
      return NextResponse.json({ error: 'walletAddress, amount, and grossPayrollTotal are required.' }, { status: 400 });
    }

    const session = getSession(req, walletAddress);
    if (!session.ok) {
      return NextResponse.json({ error: 'Your session has expired. Please sign in again.' }, { status: 401 });
    }

    // grossPayrollTotal is client-supplied (the client is the only party
    // that can decrypt the employee list — see indexeddb.ts's note on
    // resolvedPayments for the same architectural constraint). This is
    // deliberately low-stakes to trust: the only thing a client could gain
    // by lying about it is setting a HIGHER limit for themselves, which
    // they could already do directly by passing a higher `amount` — the
    // floor check exists to catch honest mistakes (e.g. an employer
    // fat-fingering a limit lower than their own payroll), not to defend
    // against a malicious employer defrauding themselves.
    const result = await setEmployerDailyLimit(walletAddress, amount, grossPayrollTotal);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({ ok: true, employerLimit: amount });
  } catch (err) {
    console.error('[agent/limits POST]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
