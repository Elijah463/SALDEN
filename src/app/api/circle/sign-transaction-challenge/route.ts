/**
 * @file app/api/circle/sign-transaction-challenge/route.ts
 *
 * POST /api/circle/sign-transaction-challenge
 * Body: { email, transaction: { to, data?, value?, gas, maxFeePerGas, maxPriorityFeePerGas, nonce, chainId } }
 *
 * REPLACES the earlier /api/circle/write-challenge approach for actually
 * moving funds/calling contracts. That route called
 * /user/transactions/contractExecution, which Circle's own docs say is
 * NOT supported for user-controlled wallets on "Other EVM blockchains"
 * (the category Arc falls under) — confirmed by the exact "the specified
 * blockchain is either not supported or deprecated" error it produced.
 * Signing IS documented as supported for EVM/EVM-TESTNET, so this route
 * only creates a SIGNING challenge; the CLIENT constructs the raw
 * transaction (nonce/gas/fees, via its own publicClient) and broadcasts
 * the signed result itself — see lib/circle/useUniversalWrite.ts.
 *
 * write-challenge/route.ts is left in place (not deleted) since its
 * general shape/pattern is still a valid reference and it costs nothing
 * to leave unused; nothing calls it anymore.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { getUserFirstWallet, createTransactionSigningChallenge } from '@/lib/circle/user-wallet';

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

interface TransactionInput {
  to?:                    string;
  data?:                  string;
  value?:                 string;
  gas?:                   string;
  maxFeePerGas?:          string;
  maxPriorityFeePerGas?:  string;
  nonce?:                 number;
  chainId?:               number;
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!checkIPRateLimit(ip)) {
      return NextResponse.json({ error: 'Too many requests. Please wait a moment and try again.' }, { status: 429 });
    }

    const body = await req.json() as { email?: string; transaction?: TransactionInput };
    const { email, transaction } = body;

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'email is required.' }, { status: 400 });
    }
    if (!transaction || !transaction.to || !isAddress(transaction.to)) {
      return NextResponse.json({ error: 'A valid transaction.to address is required.' }, { status: 400 });
    }
    if (!transaction.gas || !transaction.maxFeePerGas || !transaction.maxPriorityFeePerGas
        || transaction.nonce == null || !transaction.chainId) {
      return NextResponse.json({ error: 'transaction is missing required gas/fee/nonce/chainId fields.' }, { status: 400 });
    }

    const { session, wallet } = await getUserFirstWallet(email);

    if (!wallet) {
      return NextResponse.json({ error: 'No wallet found for this account yet — finish setting up your wallet first.' }, { status: 400 });
    }

    const challengeId = await createTransactionSigningChallenge({
      userToken: session.userToken,
      walletId:  wallet.id,
      transaction: {
        to:                    transaction.to,
        data:                  transaction.data,
        value:                 transaction.value,
        gas:                   transaction.gas,
        maxFeePerGas:          transaction.maxFeePerGas,
        maxPriorityFeePerGas:  transaction.maxPriorityFeePerGas,
        nonce:                 transaction.nonce,
        chainId:               transaction.chainId,
      },
      idempotencyKey: `sign-tx-${wallet.id}-${transaction.nonce}-${Date.now()}`,
    });

    return NextResponse.json({
      challengeId,
      userToken:     session.userToken,
      encryptionKey: session.encryptionKey,
    });
  } catch (err) {
    console.error('[sign-transaction-challenge] Error:', err);
    const message = err instanceof Error ? err.message : 'Could not create signing challenge';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
