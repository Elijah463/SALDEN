/**
 * @file app/api/circle/sign-transaction-challenge/route.ts
 *
 * SUPERSEDED — see /api/circle/contract-execution-challenge/route.ts,
 * which is what lib/circle/useUniversalWrite.ts calls now.
 *
 * This route existed because wallets were being created under the
 * generic "Other EVM blockchains" classification, which genuinely
 * doesn't support /user/transactions/contractExecution for
 * user-controlled wallets — confirmed at the time by the exact "the
 * specified blockchain is either not supported or deprecated" error it
 * produced. That diagnosis was correct, but the underlying assumption
 * (that Arc itself only qualifies for the generic fallback) was wrong —
 * Arc has its own fully-supported chain code, `ARC-TESTNET`, confirmed
 * against Circle's own supported-blockchains doc. Once
 * lib/circle/user-wallet.ts's initializeUserWallet() was corrected to
 * use it, contractExecution started working directly, so this
 * sign-then-broadcast-ourselves workaround is no longer needed.
 *
 * Left in place (not deleted) since its general shape/pattern is still a
 * valid reference and it costs nothing to leave unused; nothing calls it
 * anymore. Same convention as write-challenge/route.ts.
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
