'use client';
/**
 * Records Circle onramp (card / bank) deposits in wallet activity.
 *
 * Why this exists: the on-chain detector only looks back a few thousand blocks, and
 * card and bank deposits can take far longer than that to settle. So the deposit is
 * recorded from the widget's own event when it is submitted, and updated when it
 * settles. The row is keyed by session id, so both events update one entry.
 */
import { saveWalletActivity, type WalletActivityRecord } from '@/lib/db/indexeddb';

export async function recordOnrampDeposit(params: {
  walletAddress: string;
  sessionId: string;
  amount: number;
  token: string;
  status: 'submitted' | 'settled';
}): Promise<void> {
  const record: WalletActivityRecord = {
    id: `onramp:${params.sessionId}`,
    hash: `onramp:${params.sessionId}`,
    type: 'deposit',
    walletAddress: params.walletAddress,
    timestamp: Date.now(),
    token: params.token,
    amount: String(params.amount),
    fromAddress: 'Circle onramp',
    source: 'onramp',
    status: params.status,
  };
  await saveWalletActivity(record);
}
