'use client';
/**
 * @file lib/walletActivity/detectDeposits.ts
 *
 * Detects incoming ERC-20 token transfers (USDC/EURC/cirBTC) to the
 * user's own wallet and records them as local-only "deposit" wallet
 * activity — see WalletActivityRecord in lib/db/indexeddb.ts.
 *
 * SCOPE NOTE: this covers ERC-20 transfers only (the interface most
 * external wallets actually use to send "USDC"/"EURC"/"cirBTC" — standard
 * wallet UX doesn't expose Arc Testnet's native-currency/ERC-20 USDC
 * duality to a sender). It deliberately does NOT attempt to detect
 * incoming NATIVE-currency transfers (a raw value transfer with no ERC-20
 * Transfer event) — reliably detecting those requires scanning full block
 * contents rather than a single indexed getLogs() query, which is a much
 * heavier operation. Flagging this honestly rather than silently shipping
 * partial coverage: if someone sends native-currency USDC directly
 * (uncommon — requires deliberately choosing that on the sender's end),
 * it won't show up here, only in the wallet's own balance.
 *
 * Uses a bounded block-range getLogs() query — most RPC providers cap how
 * many blocks a single getLogs call can span, so this queries the most
 * recent ~5000 blocks each time rather than the whole chain history.
 */

import type { PublicClient } from 'viem';
import { CONTRACTS } from '@/lib/contracts/config';
import { ERC20_ABI } from '@/lib/contracts/abis';
import { saveWalletActivity, getWalletActivity } from '@/lib/db/indexeddb';

const DEPOSIT_LOOKBACK_BLOCKS = 5000n;

const TRACKED_TOKENS: Array<{ symbol: string; address: `0x${string}` | undefined; decimals: number }> = [
  { symbol: 'USDC',   address: CONTRACTS.USDC as `0x${string}` | undefined,                                decimals: 6 },
  { symbol: 'EURC',   address: process.env.NEXT_PUBLIC_EURC_ADDRESS as `0x${string}` | undefined,           decimals: 6 },
  { symbol: 'cirBTC', address: process.env.NEXT_PUBLIC_CIRBTC_ADDRESS as `0x${string}` | undefined,          decimals: 8 },
];

export async function detectIncomingDeposits(address: `0x${string}`, publicClient: PublicClient): Promise<void> {
  try {
    const latestBlock = await publicClient.getBlockNumber();
    const fromBlock = latestBlock > DEPOSIT_LOOKBACK_BLOCKS ? latestBlock - DEPOSIT_LOOKBACK_BLOCKS : 0n;

    // Load what's already recorded once, so we don't re-save the same
    // deposit on every check (getLogs re-returns the same historical logs
    // each time within the lookback window).
    const existing = await getWalletActivity(address);
    const existingIds = new Set(existing.map(a => a.id));

    for (const token of TRACKED_TOKENS) {
      if (!token.address) continue;
      try {
        const logs = await publicClient.getLogs({
          address: token.address,
          event: {
            type: 'event', name: 'Transfer', anonymous: false,
            inputs: [
              { indexed: true, name: 'from', type: 'address' },
              { indexed: true, name: 'to', type: 'address' },
              { indexed: false, name: 'value', type: 'uint256' },
            ],
          },
          args: { to: address },
          fromBlock, toBlock: 'latest',
        });

        for (const log of logs) {
          const id = `${log.transactionHash}-${log.logIndex}`;
          if (existingIds.has(id)) continue;
          const from = (log.args as { from?: string }).from;
          const value = (log.args as { value?: bigint }).value;
          if (!from || value === undefined) continue;

          const block = await publicClient.getBlock({ blockNumber: log.blockNumber });
          const amount = (Number(value) / 10 ** token.decimals).toLocaleString('en-US', {
            minimumFractionDigits: token.symbol === 'cirBTC' ? 6 : 2,
            maximumFractionDigits: token.symbol === 'cirBTC' ? 6 : 2,
          });

          await saveWalletActivity({
            id, hash: log.transactionHash ?? '', type: 'deposit', walletAddress: address,
            timestamp: Number(block.timestamp) * 1000,
            token: token.symbol, amount, fromAddress: from,
          });
          existingIds.add(id);
        }
      } catch (err) {
        // One token's getLogs failing (e.g. an RPC hiccup) shouldn't block
        // checking the others.
        console.error(`[detectIncomingDeposits] ${token.symbol} getLogs failed:`, err);
      }
    }
  } catch (err) {
    console.error('[detectIncomingDeposits] failed:', err);
  }
}
