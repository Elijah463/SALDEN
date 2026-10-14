/**
 * @file app/api/onramp/sessions/route.ts
 * Mints a Circle Onramp session for a wallet. The Circle API key stays on the server.
 *
 * Authorisation: the caller must present a signed session token for the same
 * destination wallet. Otherwise anyone could mint a funding session that sends
 * USDC to someone else's wallet through this account's Kit Key.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  createOnrampServerKit,
  createSessionRouteHandler,
  type SessionRouteHandler,
} from '@circle-fin/onramp-kit/server';
import { verifySessionToken } from '@/lib/agent/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Built lazily so a missing CIRCLE_API_KEY returns a clean 500 instead of crashing the module.
let handler: SessionRouteHandler | null = null;
function getHandler(): SessionRouteHandler | null {
  if (handler) return handler;
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) return null;
  handler = createSessionRouteHandler(createOnrampServerKit({ apiKey }));
  return handler;
}

const ETH_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function POST(request: NextRequest): Promise<Response> {
  const h = getHandler();
  if (h === null) {
    return NextResponse.json(
      { error: { name: 'server_misconfigured', message: 'CIRCLE_API_KEY is not set.' } },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Read the body once, so it can be checked and then passed on to the Circle handler.
  const raw = await request.text();
  let destination = '';
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw) as { destinationAddress?: unknown };
    destination = typeof parsed.destinationAddress === 'string' ? parsed.destinationAddress : '';
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  if (!ETH_ADDRESS.test(destination)) {
    return NextResponse.json({ error: 'destinationAddress must be a valid address.' }, { status: 400 });
  }

  const authHeader = request.headers.get('authorization');
  const session = verifySessionToken(authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null, destination);
  if (session.ok === false) {
    return NextResponse.json({ error: session.error }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }

  // Card, Apple Pay and Google Pay require referrerDomain on the session request,
  // per Circle's docs. Derived from this request's own origin, so it always matches
  // the page the widget is mounted on.
  const referrerDomain = request.headers.get('origin') ?? new URL(request.url).origin;
  const withReferrer = JSON.stringify({ ...body, referrerDomain });

  return h(new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body: withReferrer,
  }));
}
