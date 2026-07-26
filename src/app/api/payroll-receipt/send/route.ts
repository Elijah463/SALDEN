/**
 * @file app/api/payroll-receipt/send/route.ts
 *
 * POST /api/payroll-receipt/send
 *
 * Sends a payroll receipt email via Resend after a confirmed on-chain
 * batchPay. Always sent from contact@salden.xyz. Body text states clearly
 * whether the AI Agent or the employer (manual) executed the payment.
 *
 * Used by TWO callers, both currently inside this same codebase:
 *
 *   1. Manual payroll (dashboard/page.tsx) — fires right after
 *      `publicClient.waitForTransactionReceipt()` confirms the manual
 *      batchPay. Sends `executedBy: 'manual'`.
 *
 *   2. AI Agent-proposed payroll (components/agent/AgentConfirmationCards.tsx)
 *      — the agent proposes a batch payment, the user confirms it, and the
 *      confirmation card itself executes the on-chain batchPay client-side.
 *      It calls this same route with `executedBy: 'ai_agent'` immediately
 *      after its own `waitForTransactionReceipt()` confirms the payment.
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
 * Both current callers (dashboard/page.tsx and AgentConfirmationCards.tsx)
 * run in the user's own browser and do have a wallet available — but this
 * route deliberately does NOT require a wallet-signature scheme the way
 * app/api/data/sync does. That's a forward-looking choice: a genuinely
 * external, headless agent-execution server (server-to-server, no browser
 * wallet to sign with) is a planned future capability, not something that
 * exists today. Building the verification around "trust the chain, not
 * the caller" now means that future caller can be added later without
 * reworking this route's security model. Instead:
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
import { sendPayrollReceiptEmail } from '@/lib/email/sendPayrollReceiptEmail';
import { getServerPublicClient } from '@/lib/agent/chain';
import { resolveAgentWallet } from '@/lib/agent/agentIdentity';

function generateRef(txHash: string): string {
  return 'SLD-' + txHash.slice(2, 8).toUpperCase();
}

// ── Rate limiting ────────────────────────────────────────────────────────────
// Three independent limiters, all must pass:
//   - per IP    — blunt bot/script defense
//   - per wallet address  — a single observed (real, public) txHash +
//                            walletAddress pair can't be replayed against many
//                            different recipientEmail values from many IPs
//   - per recipient email — a single target inbox can't be spammed by
//                            cycling through many different real txHashes
//
// IMPORTANT CAVEAT (flagged for a real design decision, not something rate
// limiting alone can fix): this route verifies the TRANSACTION is real and
// was sent by the claimed wallet, but it cannot verify that recipientEmail
// actually belongs to that wallet's organization — payrollSetup.email is
// encrypted client-side with a key derived from a wallet signature before
// ever reaching IPFS (see AppContext.tsx's getEncryptionKey), so the server
// has no way to decrypt and cross-check it without a signature it
// structurally does not have. Since blockchain transactions are public,
// anyone who observes a real batchPay (txHash + sender wallet — both
// public) could in principle direct a legitimate-looking Salden receipt
// email to an inbox of their choosing. Rate limiting shrinks the blast
// radius (no mass abuse) but does not eliminate a single targeted
// request. Closing this fully would mean the server storing each
// employer's receipt email in a plaintext, server-readable location
// (a real product/privacy tradeoff against the current "we never see your
// plaintext data" design) — that decision shouldn't be made silently
// inside a bug fix, so it's surfaced here instead.
const IP_RATE_MAP     = new Map<string, { count: number; resetAt: number }>();
const WALLET_RATE_MAP = new Map<string, { count: number; resetAt: number }>();
const EMAIL_RATE_MAP  = new Map<string, { count: number; resetAt: number }>();

const IP_RATE_LIMIT      = 20;   // per IP, higher — a busy admin can legitimately trigger several in a row
const WALLET_RATE_LIMIT  = 20;   // per wallet address
const EMAIL_RATE_LIMIT   = 10;   // per recipient email — tighter, this is the harassment/spam vector
const RATE_WINDOW        = 10 * 60 * 1000; // 10 minutes, shared by all three

function checkRateLimit(map: Map<string, { count: number; resetAt: number }>, key: string, limit: number): boolean {
  const now = Date.now();
  const record = map.get(key);
  if (!record || now > record.resetAt) {
    map.set(key, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (record.count >= limit) return false;
  record.count += 1;
  return true;
}

export async function POST(req: NextRequest) {
  try {
    // IP rate limit before reading the body, same reasoning as send-otp.
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!checkRateLimit(IP_RATE_MAP, ip, IP_RATE_LIMIT)) {
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

    // Per-wallet and per-recipient-email limits — see the rate limiting
    // comment above for why these exist alongside the IP limit.
    if (!checkRateLimit(WALLET_RATE_MAP, walletAddress.toLowerCase(), WALLET_RATE_LIMIT)) {
      return NextResponse.json(
        { status: 'failed', message: 'Too many receipt requests for this wallet. Please wait before trying again.' },
        { status: 429 }
      );
    }
    if (!checkRateLimit(EMAIL_RATE_MAP, recipientEmail.toLowerCase(), EMAIL_RATE_LIMIT)) {
      return NextResponse.json(
        { status: 'failed', message: 'Too many receipt requests for this email address. Please wait before trying again.' },
        { status: 429 }
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

    // This route is designed to eventually accept an external, untrusted
    // caller (see the note above), so it's held to that standard already.
    // Cap free-text fields so a malformed/hostile caller can't send an
    // unbounded string that blows up the PDF layout in
    // generateReceiptPdf.ts or bloats the outgoing email.
    const boundedRemark = remark ? remark.slice(0, 200) : remark;
    const boundedRef    = ref ? ref.slice(0, 40) : ref;
    const boundedToken  = token.slice(0, 20);

    // Cap at the claimed recipientCount (or 1000, whichever is smaller) —
    // same reasoning: a hostile or malformed caller shouldn't be able to
    // send an unbounded array that blows up the PDF's pagination loop or
    // bloats the outgoing email.
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

    const result = await sendPayrollReceiptEmail({
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
    return NextResponse.json({ status: 'failed', message: 'Payroll receipt could not be sent. Please try again.' }, { status: 500 });
  }
}
