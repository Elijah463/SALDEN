/**
 * @file lib/contracts/config.ts
 * Contract addresses and chain configuration for Salden Protocol on Arc Testnet.
 */

import { defineChain } from 'viem';

// ─── Arc Testnet chain definition ─────────────────────────────────────────────
export const arcTestnet = defineChain({
  id: 23295,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.arc.network'] },
  },
  blockExplorers: {
    default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' },
  },
  testnet: true,
});

// ─── Contract addresses ────────────────────────────────────────────────────────
export const CONTRACTS = {
  ENTERPRISE_PAYROLL: (process.env.NEXT_PUBLIC_ENTERPRISE_PAYROLL_ADDRESS ?? '0x32B2b3F9EAA03F942B4d170d6343fdb27a795D87') as `0x${string}`,
  MULTI_TOKEN_FACTORY: (process.env.NEXT_PUBLIC_MULTI_TOKEN_FACTORY_ADDRESS ?? '0x3dB2362b5a4029ed116955c05A42B910aA80851d') as `0x${string}`,
  REGISTRY_FACTORY: (process.env.NEXT_PUBLIC_REGISTRY_FACTORY_ADDRESS ?? '0x5e9dDD4bc4aC8ae17263061275Bd319b4a09bDB5') as `0x${string}`,
  // USDC on Arc Testnet
  USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as `0x${string}`,
} as const;

// ─── Block explorer helpers ────────────────────────────────────────────────────
export const ARCSCAN_BASE = 'https://testnet.arcscan.app';

export function txLink(hash: string): string {
  return `${ARCSCAN_BASE}/tx/${hash}`;
}

export function addressLink(address: string): string {
  return `${ARCSCAN_BASE}/address/${address}`;
}

// ─── Design tokens ────────────────────────────────────────────────────────────
export const COLORS = {
  brand: '#4F46E5',       // Deep Indigo — headers, nav, illustrations
  action: '#14B8A6',      // Soft Teal — buttons, links, badges
  bg: '#F8F9FA',          // Off-white background
  bgCard: '#FFFFFF',
  text: '#0F172A',
  textMuted: '#64748B',
  border: '#E2E8F0',
  success: '#059669',
  error: '#DC2626',
  warning: '#D97706',
} as const;
