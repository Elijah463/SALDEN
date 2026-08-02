/**
 * @file app/api/circle/contract-execution-challenge/route.ts
 *
 * POST /api/circle/contract-execution-challenge
 * Body: { email, contractAddress, callData, value? }
 *
 * THE current write path for user-controlled (social-login) wallets —
 * replaces /api/circle/sign-transaction-challenge (see that route's
 * header for why it existed and why it's no longer used). That route
 * was a workaround for wallets created under the generic "Other EVM
 * blockchains" classification, which genuinely doesn't support
 * /user/transactions/contractExecution for user-controlled wallets.
 * Now that lib/circle/user-wallet.ts creates wallets under the real
 * `ARC-TESTNET` chain code (verified against Circle's own supported-
 * blockchains doc — Arc has full Wallets API support, it was never
 * actually restricted), contractExecution works directly: Circle
 * handles simulation, gas estimation, signing and broadcasting
 * server-side, and we just create the challenge and hand it to the
 * client to approve with their PIN (lib/circle/executeChallenge.ts's
 * executeCircleTransactionChallenge).
 *
 * `callData` (not `abiFunctionSignature`/`abiParameters`) is required
 * here — the caller already has ABI-encoded calldata built by viem's
 * encodeFunctionData (see lib/circle/useUniversalWrite.ts), and Circle's
 * docs list callData as an equally valid, mutually-exclusive alternative
 * to abiFunctionSignature — no need for a second, redundant encoding
 * path that could get a signature string wrong.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { getUserFirstWallet, createContractExecutionChallenge } from '@/lib/circle/user-wallet';

const IP_RATE_MAP = new Map<string, { count: number; resetAt: number }>();
const IP_RATE_LIMIT  = 30;
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

interface ContractExecutionBody {
  email?:           string;
  contractAddress?: string;
  callData?:        string;
  value?:           string;
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!checkIPRateLimit(ip)) {
      return NextResponse.json({ error: 'Too many requests. Please wait a moment and try again.' }, { status: 429 });
    }

    const body = await req.json() as ContractExecutionBody;
    const { email, contractAddress, callData, value } = body;

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'email is required.' }, { status: 400 });
    }
    if (!contractAddress || !isAddress(contractAddress)) {
      return NextResponse.json({ error: 'A valid contractAddress is required.' }, { status: 400 });
    }
    if (!callData || !/^0x[0-9a-fA-F]*$/.test(callData)) {
      return NextResponse.json({ error: 'callData must be 0x-prefixed hex.' }, { status: 400 });
    }

    const { session, wallet } = await getUserFirstWallet(email);

    if (!wallet) {
      return NextResponse.json({ error: 'No wallet found for this account yet — finish setting up your wallet first.' }, { status: 400 });
    }

    const challengeId = await createContractExecutionChallenge({
      userToken:       session.userToken,
      walletId:        wallet.id,
      contractAddress,
      callData,
      value,
      idempotencyKey:  `contract-exec-${wallet.id}-${Date.now()}`,
    });

    return NextResponse.json({
      challengeId,
      walletId:      wallet.id,
      userToken:     session.userToken,
      encryptionKey: session.encryptionKey,
    });
  } catch (err) {
    console.error('[contract-execution-challenge] Error:', err);
    const message = err instanceof Error ? err.message : 'Could not create contract execution challenge';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
