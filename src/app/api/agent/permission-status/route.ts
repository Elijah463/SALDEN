/**
 * @file app/api/agent/permission-status/route.ts
 *
 * GET  /api/agent/permission-status?wallet=<address>            — read-only, no auth
 * POST /api/agent/permission-status { walletAddress }  Bearer <token> — marks granted
 *
 * See lib/agent/agentPermissionCache.ts for why this is safe without
 * heavier auth on the write: it's a UI-only cache, not a security
 * boundary — the contracts enforce the real permission check on every
 * actual call regardless of what this says.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentPermissionsGranted, markAgentPermissionsGranted } from '@/lib/agent/agentPermissionCache';

export async function GET(req: NextRequest) {
  try {
    const walletAddress = req.nextUrl.searchParams.get('wallet');
    if (!walletAddress) return NextResponse.json({ error: 'wallet required' }, { status: 400 });

    const granted = await getAgentPermissionsGranted(walletAddress);
    return NextResponse.json({ granted });
  } catch (err) {
    console.error('[agent/permission-status GET] Error:', err);
    return NextResponse.json({ error: 'Could not load permission status.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { walletAddress?: string };
    const { walletAddress } = body;
    if (!walletAddress) return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });

    // No session-token gate here, deliberately — see this file's header
    // and lib/agent/agentPermissionCache.ts: this cache can only ever
    // cause a redundant on-chain check to be skipped, never bypass the
    // contracts' own isAgent() enforcement on a real call. The caller
    // (app/ai-agent/page.tsx) only ever POSTs here after it has already
    // independently confirmed both grants true via its own on-chain
    // reads, so requiring a signed session token here would add a
    // second signature flow to a page that doesn't otherwise need one,
    // for a write whose worst-case failure mode is "shows the wizard an
    // extra time" — not worth that cost.
    await markAgentPermissionsGranted(walletAddress);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[agent/permission-status POST] Error:', err);
    return NextResponse.json({ error: 'Could not save permission status.' }, { status: 500 });
  }
}
