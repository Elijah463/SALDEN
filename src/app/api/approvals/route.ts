/**
 * @file app/api/approvals/route.ts
 *
 * The client-facing surface of the unified token-approval cache
 * (lib/approvals/approvalCache.ts). Client components never talk to that
 * module (or lib/kv.ts) directly — same reasoning as every other
 * server-only module in this app (lib/circle/user-wallet.ts, lib/kv.ts
 * itself): it would either pull server env vars into a client bundle or
 * silently no-op. lib/approvals/useTokenApproval.ts is the one client hook
 * that talks to this route; every approval call site uses that hook rather
 * than fetching this route directly.
 *
 * GET    ?chainId=&owner=&token=&spender=              -> { amount: string }
 * POST   { chainId, owner, token, spender, amount }     -> { ok: true }
 * DELETE { chainId, owner, token, spender }             -> { ok: true }
 *
 * `amount` is always a decimal string (raw token units, e.g. 6-decimal
 * USDC base units) — never a JS number, to avoid precision loss on amounts
 * above 2^53.
 *
 * No auth check beyond address validation: this cache is advisory only
 * (see approvalCache.ts's header for why a wrong entry can't move funds),
 * so there's nothing here worth gating behind a session check the way a
 * real write endpoint would be.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { getCachedApproval, setCachedApproval, invalidateCachedApproval } from '@/lib/approvals/approvalCache';

function parseParties(chainIdRaw: unknown, owner: unknown, token: unknown, spender: unknown):
  { chainId: number; owner: string; token: string; spender: string } | null {
  const chainId = Number(chainIdRaw);
  if (!Number.isFinite(chainId) || chainId <= 0) return null;
  if (typeof owner !== 'string' || !isAddress(owner)) return null;
  if (typeof token !== 'string' || !isAddress(token)) return null;
  if (typeof spender !== 'string' || !isAddress(spender)) return null;
  return { chainId, owner, token, spender };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const parsed = parseParties(sp.get('chainId'), sp.get('owner'), sp.get('token'), sp.get('spender'));
  if (!parsed) {
    return NextResponse.json({ error: 'chainId, owner, token, spender are all required and owner/token/spender must be valid addresses.' }, { status: 400 });
  }
  const cached = await getCachedApproval(parsed.chainId, parsed.owner, parsed.token, parsed.spender);
  return NextResponse.json({ amount: cached.amount.toString() });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });

  const parsed = parseParties(body.chainId, body.owner, body.token, body.spender);
  if (!parsed) {
    return NextResponse.json({ error: 'chainId, owner, token, spender are all required and owner/token/spender must be valid addresses.' }, { status: 400 });
  }

  let amount: bigint;
  try {
    amount = BigInt(body.amount);
    if (amount < 0n) throw new Error('negative');
  } catch {
    return NextResponse.json({ error: 'amount must be a non-negative integer string.' }, { status: 400 });
  }

  await setCachedApproval(parsed.chainId, parsed.owner, parsed.token, parsed.spender, amount);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });

  const parsed = parseParties(body.chainId, body.owner, body.token, body.spender);
  if (!parsed) {
    return NextResponse.json({ error: 'chainId, owner, token, spender are all required and owner/token/spender must be valid addresses.' }, { status: 400 });
  }

  await invalidateCachedApproval(parsed.chainId, parsed.owner, parsed.token, parsed.spender);
  return NextResponse.json({ ok: true });
}
