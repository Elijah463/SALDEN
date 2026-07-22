/**
 * @file app/api/invoice/send/route.ts
 *
 * POST /api/invoice/send
 *
 * Sends a payroll receipt email via Resend after a confirmed on-chain
 * batchPay. Always sent from contact@salden.xyz. Body text states clearly
 * whether the AI Agent or the employer (manual) executed the payment.
 *
 * Used by TWO callers:
 *
 *   1. Manual payroll (dashboard/page.tsx) — fires right after
 *      `publicClient.waitForTransactionReceipt()` confirms the manual
 *      batchPay. Sends `executedBy: 'manual'`.
 *
 *   2. AI Agent autonomous payroll (separate agent execution server —
 *      NOT part of this codebase upload) — must call this same route
 *      with `executedBy: 'ai_agent'` immediately after its own
 *      `waitForTransactionReceipt()` confirms the on-chain batchPay it
 *      executed. See AI_AGENT_INTEGRATION_CONTRACT below.
 *
 * Both callers MUST only call this route after on-chain confirmation —
 * never speculatively, and never based on an LLM's claim that a payment
 * "succeeded". The amount/recipientCount/txHash must come from the
 * confirmed transaction, not from AI-generated text.
 *
 * ═══════════════════════════════════════════════
 * SECURITY NOTE (added in this revision)
 * ═══════════════════════════════════════════════
 * Audit finding (critical): this route had NO authentication and NO
 * server-side verification that `txHash` actually existed or matched the
 * claimed `amount`/`walletAddress` — anyone could POST here and get an
 * official-looking "Salden" receipt emailed from the real domain to any
 * address, with a completely fabricated txHash/amount. That's a phishing
 * / brand-abuse vector, and an unthrottled one at that.
 *
 * Since one legitimate caller (the separate AI Agent execution server,
 * per AI_AGENT_INTEGRATION_CONTRACT) is a headless server-to-server
 * caller with no browser wallet to produce a signature with, this can't
 * simply require a wallet-signature scheme the way app/api/data/sync does
 * without breaking that integration contract. Instead:
 *
 *   1. The submitted txHash must correspond to a REAL, CONFIRMED
 *      transaction on-chain (fetched via getServerPublicClient — the
 *      chain itself, not the caller's claim).
 *   2. That transaction's `from` address must match either the claimed
 *      `walletAddress` or that wallet's own resolved agent wallet
 *      (lib/agent/agentIdentity.ts — the same server-verified resolution
 *      used everywhere else money-adjacent addresses are checked).
 *
 * Together, this means an attacker can no longer fabricate a receipt out
 * of thin air — they would need to already control (or find a genuine,
 * already-public) transaction actually sent from the wallet they're
 * claiming to represent, at which point the "attack" degenerates into
 * re-sending a notification for a real event, not phishing with invented
 * content. amount/recipientCount are still not deep-decoded against the
 * transaction's calldata (that would require knowing which of several
 * contract shapes was called and fully ABI-decoding it, which is more
 * complexity than this endpoint's risk profile currently justifies) — if
 * you need that level of certainty later, decode against
 * MULTI_TOKEN_PAYROLL_ABI's batchPay signature and compare arguments.
 *
 * IP-based rate limiting (same pattern as send-otp/route.ts) is also
 * added so this can't be used as a bulk spam relay even for legitimate-
 * looking calls.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAddress, getAddress } from 'viem';
import { sendInvoiceEmail } from '@/lib/email/sendInvoiceEmail';
import { getServerPublicClient } from '@/lib/agent/chain';
import { resolveAgentWallet } from '@/lib/agent/agentIdentity';

function generateRef(txHash: string): string {
  return 'SLD-' + txHash.slice(2, 8).toUpperCase();
}

// IP-based rate limiter — 20 receipt emails per IP per 10 minutes. Higher
// than send-otp's limit since a busy payroll admin legitimately running
// several payroll groups in a row could trigger several of these in
// quick succession; still far below anything a spam campaign would need.
const IP_RATE_MAP = new Map<string, { count: number; resetAt: number }>();
const IP_RATE_LIMIT  = 20;
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

export async function POST(req: NextRequest) {
  try {
    // IP rate limit before reading the body, same reasoning as send-otp.
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!checkIPRateLimit(ip)) {
      return NextResponse.json(
        { status: 'failed', message: 'Too many receipt requests from this IP. Please wait before trying again.' },
        { status: 429 }
      );
    }

    if (!process.env.RESEND_API_KEY) {
      return NextResponse.json(
        { status: 'failed', message: 'RESEND_API_KEY is not configured.' },
        { status: 503 }
      );
    }

    const body = await req.json() as {
      txHash?:         string;
      walletAddress?:  string;
      recipientEmail?: string;
      recipientCount?: number;
      amount?:         string;
      token?:          string;
      remark?:         string;
      ref?:            string;
      timestamp?:      number;
      executedBy?:     'manual' | 'ai_agent';
      employees?: {
        fullName?:      string;
        department?:    string;
        walletAddress?: string;
        salaryAmount?:  string;
        group?:         string;
      }[];
    };

    const {
      txHash, walletAddress, recipientEmail,
      recipientCount, amount, token, remark, ref, timestamp,
      executedBy = 'manual', employees,
    } = body;

    // ── Required fields ─────────────────────────────────────────────────────
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return NextResponse.json({ status: 'failed', message: 'A valid txHash is required' }, { status: 400 });
    }
    if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      return NextResponse.json({ status: 'failed', message: 'A valid recipientEmail is required' }, { status: 400 });
    }
    if (!walletAddress || !isAddress(walletAddress)) {
      return NextResponse.json({ status: 'failed', message: 'A valid walletAddress is required' }, { status: 400 });
    }
    if (recipientCount == null || amount == null || !token) {
      return NextResponse.json(
        { status: 'failed', message: 'recipientCount, amount, and token are required' },
        { status: 400 }
      );
    }
    if (executedBy !== 'manual' && executedBy !== 'ai_agent') {
      return NextResponse.json(
        { status: 'failed', message: "executedBy must be 'manual' or 'ai_agent'" },
        { status: 400 }
      );
    }

    // ── On-chain verification — see the SECURITY NOTE in the file header.
    let receipt;
    try {
      receipt = await getServerPublicClient().getTransactionReceipt({ hash: txHash as `0x${string}` });
    } catch {
      return NextResponse.json(
        { status: 'failed', message: 'That transaction could not be found on-chain.' },
        { status: 400 }
      );
    }
    if (!receipt || receipt.status !== 'success') {
      return NextResponse.json(
        { status: 'failed', message: 'That transaction is not a confirmed, successful on-chain transaction.' },
        { status: 400 }
      );
    }

    const claimedWallet = getAddress(walletAddress);
    const txFrom = getAddress(receipt.from);
    let authorised = txFrom === claimedWallet;
    if (!authorised) {
      const agent = await resolveAgentWallet(walletAddress);
      authorised = !!agent && agent.address === txFrom;
    }
    if (!authorised) {
      return NextResponse.json(
        { status: 'failed', message: 'That transaction was not sent by the claimed wallet or its agent wallet.' },
        { status: 403 }
      );
    }

    // This route is a documented external trust boundary (a separate agent
    // execution server, per AI_AGENT_INTEGRATION_CONTRACT above, is expected
    // to call it). Cap free-text fields so a malformed/hostile caller can't
    // send an unbounded string that blows up the PDF layout in
    // generateReceiptPdf.ts or bloats the outgoing email.
    const boundedRemark = remark ? remark.slice(0, 200) : remark;
    const boundedRef    = ref ? ref.slice(0, 40) : ref;
    const boundedToken  = token.slice(0, 20);

    // Cap at the claimed recipientCount (or 1000, whichever is smaller) —
    // this route is a documented external trust boundary, so a hostile or
    // malformed caller shouldn't be able to send an unbounded array that
    // blows up the PDF's pagination loop or bloats the outgoing email.
    const boundedEmployees = Array.isArray(employees)
      ? employees
          .slice(0, Math.min(recipientCount, 1000))
          .map(e => ({
            fullName:      (e.fullName ?? '').slice(0, 100),
            department:    (e.department ?? '').slice(0, 60),
            walletAddress: (e.walletAddress ?? '').slice(0, 42),
            salaryAmount:  (e.salaryAmount ?? '').slice(0, 30),
            group:         e.group ? e.group.slice(0, 60) : undefined,
          }))
      : undefined;

    const result = await sendInvoiceEmail({
      ref:            boundedRef ?? generateRef(txHash),
      txHash,
      walletAddress,
      recipientEmail,
      recipientCount,
      amount,
      token:          boundedToken,
      remark:         boundedRemark,
      timestamp:      timestamp ?? Date.now(),
      executedBy,
      employees:      boundedEmployees,
    });

    return NextResponse.json(result, { status: result.status === 'sent' ? 200 : 502 });

  } catch {
    return NextResponse.json({ status: 'failed', message: 'Invoice could not be sent. Please try again.' }, { status: 500 });
  }
}
