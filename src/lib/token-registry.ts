/**
 * @file lib/token-registry.ts
 * Human-readable names for ERC-20 tokens used in payroll.
 *
 * The smart contract only knows addresses. This registry maps
 * address → { name, symbol, decimals } so the UI can show
 * "USD Coin (USDC)" instead of "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238".
 *
 * Storage: part of the IPFS-synced AppContext state.
 * The AI agent receives this registry as context so it can
 * refer to tokens by name (e.g., "pay in USDC").
 *
 * USDC is always pre-seeded — it is the primary payroll token.
 */

import { CONTRACTS } from '@/lib/contracts/config';
import { isValidEthAddress } from '@/lib/validation';

export interface TokenEntry {
  address:   string;   // EIP-55 checksummed contract address
  name:      string;   // "USD Coin"
  symbol:    string;   // "USDC"
  decimals:  number;   // 6 for USDC
  addedAt:   string;   // ISO 8601
  addedBy?:  string;   // wallet address of who added it
}

/** Registry keyed by lowercase address for O(1) lookup */
export type TokenRegistry = Record<string, TokenEntry>;

// ── Pre-seeded tokens ─────────────────────────────────────────────────────────

export const DEFAULT_TOKEN_REGISTRY: TokenRegistry = {
  [CONTRACTS.USDC.toLowerCase()]: {
    address:  CONTRACTS.USDC,
    name:     'USD Coin',
    symbol:   'USDC',
    decimals: 6,
    addedAt:  '2024-01-01T00:00:00.000Z',
    addedBy:  'system',
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Lookup token entry by address (case-insensitive) */
export function getToken(
  registry: TokenRegistry,
  address: string,
): TokenEntry | undefined {
  return registry[address.toLowerCase()];
}

/** Display label shown in dropdowns and tables: "USD Coin (USDC)" */
export function tokenLabel(entry: TokenEntry): string {
  return `${entry.name} (${entry.symbol})`;
}

/** Add or update a token entry. Returns error string or null on success. */
export function upsertToken(
  registry: TokenRegistry,
  entry: Omit<TokenEntry, 'addedAt'> & { addedAt?: string },
): { registry: TokenRegistry; error: string | null } {
  if (!isValidEthAddress(entry.address)) {
    return { registry, error: 'Invalid contract address — must be a valid Ethereum address.' };
  }
  if (!entry.name.trim()) {
    return { registry, error: 'Token name is required.' };
  }
  if (!entry.symbol.trim()) {
    return { registry, error: 'Token symbol is required.' };
  }
  if (entry.symbol.length > 12) {
    return { registry, error: 'Token symbol must be 12 characters or fewer.' };
  }
  if (!Number.isInteger(entry.decimals) || entry.decimals < 0 || entry.decimals > 18) {
    return { registry, error: 'Decimals must be an integer between 0 and 18.' };
  }

  const key = entry.address.toLowerCase();
  const updated: TokenRegistry = {
    ...registry,
    [key]: {
      ...entry,
      address: entry.address,  // store as-is (EIP-55)
      addedAt: entry.addedAt ?? new Date().toISOString(),
    },
  };
  return { registry: updated, error: null };
}

/** Remove a token. USDC cannot be removed. */
export function removeToken(
  registry: TokenRegistry,
  address: string,
): { registry: TokenRegistry; error: string | null } {
  if (address.toLowerCase() === CONTRACTS.USDC.toLowerCase()) {
    return { registry, error: 'USDC cannot be removed — it is the primary payroll token.' };
  }
  const updated = { ...registry };
  delete updated[address.toLowerCase()];
  return { registry: updated, error: null };
}

/**
 * Build an AI-readable context string listing known tokens.
 * Injected into the Gemini system prompt so the agent refers
 * to tokens by name, not address.
 */
export function buildTokenContext(registry: TokenRegistry): string {
  const entries = Object.values(registry);
  if (!entries.length) return 'No custom tokens registered.';
  return entries
    .map(t => `${t.symbol} (${t.name}) — contract: ${t.address}, decimals: ${t.decimals}`)
    .join('\n');
}
