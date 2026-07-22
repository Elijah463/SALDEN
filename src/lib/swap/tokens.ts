/**
 * @file lib/swap/tokens.ts
 * Token configuration and raw-amount<->human-amount conversion helpers for
 * the swap feature. Extracted from app/wallet/swap/page.tsx so a
 * token-list or decimals bug has one obvious place to look, independent
 * of UI or quote-fetching code.
 */

import { CONTRACTS } from '@/lib/contracts/config';

export type ChainToken = 'USDC' | 'EURC' | 'cirBTC';

export interface TokenMeta {
  symbol:   ChainToken;
  name:     string;
  color:    string;
  bg:       string;
  icon:     string;     // emoji or short char for simplicity
  address:  `0x${string}` | undefined;
  decimals: number;
}

export const TOKENS: TokenMeta[] = [
  { symbol: 'USDC',   name: 'USD Coin',      color: '#2775CA', bg: '#EFF6FF', icon: '$', address: CONTRACTS.USDC, decimals: 6 },
  { symbol: 'EURC',   name: 'Euro Coin',      color: '#1B3A6B', bg: '#EEF2FF', icon: '€', address: process.env.NEXT_PUBLIC_EURC_ADDRESS as `0x${string}` | undefined, decimals: 6 },
  { symbol: 'cirBTC', name: 'Circle Bitcoin', color: '#F7931A', bg: '#FFF7ED', icon: '₿', address: process.env.NEXT_PUBLIC_CIRBTC_ADDRESS as `0x${string}` | undefined, decimals: 8 },
];

/** Human-readable amount string (e.g. "12.5") -> raw on-chain integer
 *  amount scaled by `decimals`, as a bigint. */
export function toRawAmount(amount: string, decimals: number): bigint {
  const [whole, frac = ''] = amount.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt((whole || '0') + fracPadded);
}

/** Raw on-chain integer amount (string, already scaled by `decimals`) ->
 *  a trimmed human-readable string, e.g. "12.5" (not "12.500000"). Caps
 *  displayed fractional digits at 6 regardless of the token's real
 *  decimals (cirBTC's 8) purely for readable UI — this is a display
 *  helper, not used for anything that needs full on-chain precision. */
export function fromRawAmount(raw: string, decimals: number): string {
  try {
    const n = BigInt(raw);
    const div = 10n ** BigInt(decimals);
    const whole = n / div;
    const frac  = n % div;
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, Math.min(decimals, 6)).replace(/0+$/, '');
    return fracStr ? `${whole}.${fracStr}` : whole.toString();
  } catch {
    return '';
  }
}
