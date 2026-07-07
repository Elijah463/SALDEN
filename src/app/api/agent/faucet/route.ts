/**
 * @file app/api/agent/faucet/route.ts
 * SERVER-SIDE ONLY.
 *
 * POST /api/agent/faucet
 * Body: { address: string; checkOnly?: boolean }
 *
 * - checkOnly=true  → just returns the current USDC balance (no drip)
 * - checkOnly=false → calls Circle testnet faucet then polls for confirmation
 *
 * Rate limit enforcement is handled by Circle's API (20 USDC per address
 * per blockchain every 2 hours). We surface Circle's 429 response as
 * status: 'rate_limited' so the UI can show a helpful message.
 *
 * Authorization: caller must supply the employer or agent wallet address.
 * We validate it is a well-formed EVM address. We do NOT allow arbitrary
 * addresses to be funded (faucet is testnet-only and rate-limited by Circle,
 * but we still only allow addresses present in our known set).
 *
 * Known-address check: the route accepts an optional `ownerWallet` param.
 * If provided, only the ownerWallet itself or its agent wallet can be funded.
 * If omitted, any well-formed address is allowed (permissive — testnet only).
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAddress, getAddress }     from 'viem';
import { requestFaucetDrip, getUsdcBalance } from '@/lib/circle/faucet';
import { verifySessionToken } from '@/lib/agent/auth';
import { resolveAgentWallet } from '@/lib/agent/agentIdentity';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      address:       string;
      ownerWallet?:  string;   // optional — restricts which addresses can be funded
      checkOnly?:    boolean;
    };

    const { address, ownerWallet, checkOnly = false } = body;

    // ── Validate address is a string FIRST — auth check uses it as a fallback
    if (!address || typeof address !== 'string') {
      return NextResponse.json({ error: 'A wallet address is required.' }, { status: 400 });
    }

    // ── Auth: verify this request is from a valid session ─────────────────────
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const session = verifySessionToken(token, ownerWallet ?? address);
    if (!session.ok) {
      return NextResponse.json({ error: 'Your session has expired. Please sign in again.' }, { status: 401 });
    }

    if (!isAddress(address)) {
      return NextResponse.json({ error: 'That wallet address isn\'t valid.' }, { status: 400 });
    }

    try {
      getAddress(address);
    } catch {
      return NextResponse.json({ error: 'That wallet address isn\'t valid.' }, { status: 400 });
    }

    // ── Optional ownerWallet guard ─────────────────────────────────────────────
    // If the caller tells us who the employer is, only allow funding that
    // wallet or ITS OWN agent wallet — resolved server-side (Circle refId
    // lookup, see lib/agent/agentIdentity.ts), never from a client-supplied
    // `agentAddress` field. This is a low-stakes fix on its own (worst case
    // of the old trust model was funding a stranger's testnet wallet with
    // free faucet USDC — a griefing nuisance, not a fund-theft risk), but
    // it's cheap to make consistent with the same pattern used everywhere
    // else money-adjacent addresses are resolved in this codebase.
    if (ownerWallet && isAddress(ownerWallet)) {
      const normalised  = getAddress(address).toLowerCase();
      const ownerNormal = getAddress(ownerWallet).toLowerCase();
      const resolvedAgent = await resolveAgentWallet(ownerWallet);
      const agentNormal = resolvedAgent?.address.toLowerCase() ?? null;
      if (normalised !== ownerNormal && normalised !== agentNormal) {
        return NextResponse.json(
          { error: 'This faucet route only funds the employer wallet or its known agent wallet.' },
          { status: 403 }
        );
      }
    }

    // ── Balance check only ─────────────────────────────────────────────────────
    if (checkOnly) {
      const { balance } = await getUsdcBalance(address);
      return NextResponse.json({ status: 'balance', address, balance });
    }

    // ── Faucet drip ────────────────────────────────────────────────────────────
    const result = await requestFaucetDrip(address);
    return NextResponse.json(result);

  } catch {
    return NextResponse.json(
      { status: 'error', message: 'Faucet request failed. Please try again.' },
      { status: 500 }
    );
  }
}
