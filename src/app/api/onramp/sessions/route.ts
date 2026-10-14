/**
 * @file app/api/onramp/sessions/route.ts
 *
 * STUBBED. This previously imported '@circle-fin/onramp-kit/server', which
 * is not a real package (confirmed against the npm registry and Circle's
 * actual published package list, there is no Circle SDK by that name).
 * That broken import was failing the Vercel build for the whole app.
 *
 * The fiat-onramp feature itself is being rebuilt against a real provider
 * (Circle's actual On/Off-Ramps product is an institutional/KYB treasury
 * flow, not a retail card widget, so a retail onramp needs a different
 * provider, Coinbase Onramp/MoonPay/Transak are the realistic options).
 * Until that lands, this route cleanly reports itself as not available
 * instead of 404ing or breaking the build. The "Deposit fiat" tile on
 * /wallet/deposit is marked `soon` and doesn't call this route.
 */

import { NextResponse } from 'next/server';

export async function POST(): Promise<Response> {
  return NextResponse.json(
    { error: { name: 'not_implemented', message: 'Fiat deposit is not available yet.' } },
    { status: 501, headers: { 'Cache-Control': 'no-store' } },
  );
}
