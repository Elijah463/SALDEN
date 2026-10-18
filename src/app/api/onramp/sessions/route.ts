/**
 * @file app/api/onramp/sessions/route.ts
 *
 * Mints a short-lived Circle Onramp session for the signed-in wallet, so
 * the browser can mount Circle's hosted fiat-onramp widget (card, Apple
 * Pay, Google Pay, bank transfer) and have the purchased USDC delivered
 * straight to that wallet.
 *
 * PREVIOUSLY this imported '@circle-fin/onramp-kit/server', a package
 * that does not exist on npm, confirmed against the registry and
 * Circle's published package list. That broke the Vercel build for the
 * whole app. The real surface (confirmed directly against
 * docs.arc.io/app-kit/onramp and the App Kit Onramp quickstart, not
 * guessed) is `@circle-fin/app-kit/server`'s `createAppServerKit`, the
 * SAME package already installed and already used for Bridge
 * (lib/circle/appKit.ts), just a different capability of it.
 *
 * AUTH: Circle's own quickstart is explicit that this route "doesn't
 * perform authentication" out of the box and that a real deployment
 * needs to add its own check. This app has no general-purpose
 * logged-in-wallet session token (the one in lib/agent/auth.ts is
 * specifically for agent activation, not a fit here), so this follows
 * the same IP-based rate-limit convention already used for a comparable
 * unauthenticated-ish write endpoint, see
 * api/circle/sign-transaction-challenge/route.ts, plus basic input
 * validation. destinationAddress is never trusted beyond "is this a
 * well-formed address", Circle's own KYC step inside the hosted widget
 * is what actually gates real money movement, this route only ever
 * mints a session, it never moves funds itself.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { createAppServerKit } from '@circle-fin/app-kit/server';

const IP_RATE_MAP = new Map<string, { count: number; resetAt: number }>();
const IP_RATE_LIMIT  = 10;
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

// Sandbox override for local development/testing only. Unset in
// production, which is exactly what the SDK wants, per
// docs.arc.io/app-kit/references/onramp-hosting-requirements: the
// default IS the production endpoint, so production deployments don't
// set this at all. Both sides (this server value and
// NEXT_PUBLIC_ONRAMP_WIDGET_BASE_URL read client-side) must agree, see
// OnrampWidget.tsx.
const ONRAMP_API_BASE_URL = process.env.ONRAMP_API_BASE_URL || undefined;

const server = createAppServerKit({
  onramp: {
    apiKey: process.env.CIRCLE_API_KEY!,
    // Required by Circle for debit card, Apple Pay, and Google Pay.
    referrerDomain: process.env.NEXT_PUBLIC_APP_DOMAIN || 'salden.xyz',
    ...(ONRAMP_API_BASE_URL ? { baseUrl: ONRAMP_API_BASE_URL } : {}),
  },
});

export async function POST(req: NextRequest): Promise<Response> {
  if (!process.env.CIRCLE_API_KEY) {
    return NextResponse.json(
      { error: { message: 'Fiat deposit is not configured yet.' } },
      { status: 501, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkIPRateLimit(ip)) {
    return NextResponse.json(
      { error: { message: 'Too many requests, please wait a moment and try again.' } },
      { status: 429, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let body: { appUserId?: unknown; destinationAddress?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { message: 'Invalid request body.' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const { appUserId, destinationAddress } = body;
  if (typeof appUserId !== 'string' || !appUserId) {
    return NextResponse.json(
      { error: { message: 'appUserId is required.' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (typeof destinationAddress !== 'string' || !isAddress(destinationAddress)) {
    return NextResponse.json(
      { error: { message: 'A valid destinationAddress is required.' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const session = await server.onramp.createSession({ appUserId, destinationAddress });
    return NextResponse.json(session, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('onramp session creation failed:', err);
    return NextResponse.json(
      { error: { message: 'Could not start a fiat deposit right now, please try again shortly.' } },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
