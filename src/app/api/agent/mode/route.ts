/**
 * @file app/api/agent/mode/route.ts
 *
 * GET  /api/agent/mode?wallet=<address>                        — read-only, no auth (see reasoning below)
 * POST /api/agent/mode  { walletAddress, mode }  Bearer <token> — requires a signed session
 *
 * Same auth reasoning as /api/agent/limits/route.ts: reading which mode is
 * active grants no capability and exposes nothing sensitive, so GET isn't
 * gated behind a signature (that would mean prompting a signature just to
 * open Settings or load the agent page). Actually CHANGING the mode always
 * requires one, same as changing the spend limit.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '@/lib/agent/auth';
import { getAgentMode, setAgentMode, type AgentMode } from '@/lib/agent/agentMode';

function getSession(req: NextRequest, walletAddress: string) {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  return verifySessionToken(token, walletAddress);
}

export async function GET(req: NextRequest) {
  try {
    const walletAddress = req.nextUrl.searchParams.get('wallet');
    if (!walletAddress) return NextResponse.json({ error: 'wallet required' }, { status: 400 });

    const mode = await getAgentMode(walletAddress);
    return NextResponse.json({ mode });
  } catch (err) {
    console.error('[agent/mode GET] Error:', err);
    return NextResponse.json({ error: 'Could not load agent mode.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { walletAddress?: string; mode?: string };
    const { walletAddress, mode } = body;

    if (!walletAddress) return NextResponse.json({ error: 'walletAddress required' }, { status: 400 });
    if (mode !== 'confirm' && mode !== 'autonomous') {
      return NextResponse.json({ error: "mode must be 'confirm' or 'autonomous'." }, { status: 400 });
    }

    const session = getSession(req, walletAddress);
    if (!session.ok) return NextResponse.json({ error: session.error }, { status: 401 });

    await setAgentMode(walletAddress, mode as AgentMode);
    return NextResponse.json({ ok: true, mode });
  } catch (err) {
    console.error('[agent/mode POST] Error:', err);
    return NextResponse.json({ error: 'Could not save agent mode.' }, { status: 500 });
  }
}
