/**
 * @file lib/contracts/config.ts
 * Contract addresses and chain configuration for Salden Protocol on Arc Testnet.
 *
 * IMPORTANT: every network-specific value (chain ID, RPC URL, block explorer,
 * and every contract address) is sourced from environment variables ONLY —
 * nothing here is hardcoded as a fallback. Set these in your Vercel project
 * (or .env.local for local development):
 *   NEXT_PUBLIC_CHAIN_ID
 *   NEXT_PUBLIC_RPC_URL
 *   NEXT_PUBLIC_BLOCK_EXPLORER_URL
 *   NEXT_PUBLIC_USDC_ADDRESS
 *   NEXT_PUBLIC_ENTERPRISE_PAYROLL_ADDRESS
 *   NEXT_PUBLIC_MULTI_TOKEN_FACTORY_ADDRESS
 *   NEXT_PUBLIC_REGISTRY_FACTORY_ADDRESS
 *
 * The only thing hardcoded below is the native currency symbol — "USDC" —
 * since Arc Testnet uses USDC as its native gas token (not ETH).
 */

import { defineChain } from 'viem';

const RPC_URL       = process.env.NEXT_PUBLIC_RPC_URL as string;
const EXPLORER_URL  = process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL as string;

// ─── Arc Testnet chain definition ─────────────────────────────────────────────
export const arcTestnet = defineChain({
  id: Number(process.env.NEXT_PUBLIC_CHAIN_ID),
  name: 'Arc Testnet',
  // Arc Testnet's native gas token is USDC (18-decimal native balance —
  // distinct from the 6-decimal ERC-20 USDC interface used for transfers).
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_URL] },
  },
  blockExplorers: {
    default: { name: 'ArcScan', url: EXPLORER_URL },
  },
  testnet: true,
});

// ─── Contract addresses ────────────────────────────────────────────────────────
export const CONTRACTS = {
  ENTERPRISE_PAYROLL:  process.env.NEXT_PUBLIC_ENTERPRISE_PAYROLL_ADDRESS  as `0x${string}`,
  MULTI_TOKEN_FACTORY: process.env.NEXT_PUBLIC_MULTI_TOKEN_FACTORY_ADDRESS as `0x${string}`,
  REGISTRY_FACTORY:    process.env.NEXT_PUBLIC_REGISTRY_FACTORY_ADDRESS   as `0x${string}`,
  // ERC-20 interface for USDC on Arc Testnet (6 decimals — see note above).
  USDC: process.env.NEXT_PUBLIC_USDC_ADDRESS as `0x${string}`,
} as const;

// ─── Block explorer helpers ────────────────────────────────────────────────────
export const ARCSCAN_BASE = EXPLORER_URL;

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
