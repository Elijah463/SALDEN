/**
 * @file app/api/onramp/sessions/route.ts
 *
 * Mints a short-lived Circle Onramp session for the signed-in wallet, so
 * the browser can mount Circle's hosted fiat-onramp widget (card, Apple
 * Pay, Google Pay, bank transfer) and have the purchased USDC delivered
 * straight to that wallet.
 *
 * BUILD FIX: '@circle-fin/app-kit' does NOT export a './server' subpath
 * (that is what broke the Vercel build: "Package path ./server is not
 * exported"). The server half of Onramp ships in the standalone package
 * '@circle-fin/onramp-kit', via '@circle-fin/onramp-kit/server'
 * (createOnrampServerKit). Install it with:
 *
 *   npm install @circle-fin/onramp-kit --legacy-peer-deps
 *
 * and commit package.json + package-lock.json.
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
import { createOnrampServerKit } from '@circle-fin/onramp-kit/server';

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
// production, which is exactly what the SDK wants: the default IS the
// production endpoint, so production deployments don't set this at all.
// Both sides (this server value and NEXT_PUBLIC_ONRAMP_WIDGET_BASE_URL
// read client-side) must agree, see OnrampWidget.tsx.
const ONRAMP_API_BASE_URL = process.env.ONRAMP_API_BASE_URL || undefined;

// Created lazily so a missing CIRCLE_API_KEY can never crash the build
// while Next.js imports this module to collect route data.
let serverKit: ReturnType<typeof createOnrampServerKit> | null = null;

function getServerKit() {
  if (!serverKit) {
    serverKit = createOnrampServerKit({
      apiKey: process.env.CIRCLE_API_KEY!,
      // Required by Circle for debit card, Apple Pay, and Google Pay.
      // Bare hostname only: no scheme, port, path, or wildcard.
      referrerDomain: process.env.NEXT_PUBLIC_APP_DOMAIN || 'salden.xyz',
      ...(ONRAMP_API_BASE_URL ? { baseUrl: ONRAMP_API_BASE_URL } : {}),
    });
  }
  return serverKit;
}

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
    const session = await getServerKit().createSession({ appUserId, destinationAddress });
    return NextResponse.json(session, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('onramp session creation failed:', err);
    return NextResponse.json(
      { error: { message: 'Could not start a fiat deposit right now, please try again shortly.' } },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
