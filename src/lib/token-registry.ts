/**
 * @file lib/token-registry.ts
 * Human-readable names for ERC-20 tokens used in payroll.
 *
 * The smart contract only knows addresses. This registry maps
 * address → { name, symbol, decimals } so the UI can show
 * "USD Coin (USDC)" instead of "0x3600000000000000000000000000000000000000".
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

// CONTRACTS.USDC comes from NEXT_PUBLIC_USDC_ADDRESS with no hardcoded
// fallback (by design — see lib/contracts/config.ts). If that env var is
// ever unset, CONTRACTS.USDC is `undefined`, and calling .toLowerCase() on
// it directly here — at module scope, evaluated the instant this file is
// imported — would crash every single page that transitively imports this
// module (i.e. the entire app, since AppContext imports it). Guard it so a
// missing env var degrades to "no pre-seeded token" instead of a hard
// build-time crash.
const USDC_ADDRESS = (CONTRACTS.USDC ?? '') as string;

export const DEFAULT_TOKEN_REGISTRY: TokenRegistry = USDC_ADDRESS ? {
  [USDC_ADDRESS.toLowerCase()]: {
    address:  USDC_ADDRESS,
    name:     'USD Coin',
    symbol:   'USDC',
    decimals: 6,
    addedAt:  '2024-01-01T00:00:00.000Z',
    addedBy:  'system',
  },
} : {};

/**
 * Real token logos, shared by every page that lists tokens (wallet
 * balances, the send-token dropdown, etc.) — one place to update instead
 * of each page hand-drawing its own placeholder icon.
 */
export const TOKEN_ICON_PATHS: Record<string, string> = {
  USDC:   '/images/tokens/usdc.webp',
  EURC:   '/images/tokens/eurc.svg',
  cirBTC: '/images/tokens/cirbtc.png',
};

/** Icon path for a symbol, or null if there's no real logo for it (caller
 *  should fall back to a generic placeholder — e.g. first-letter circle). */
export function tokenIconPath(symbol: string): string | null {
  return TOKEN_ICON_PATHS[symbol] ?? null;
}

/**
 * Some token logo source files have extra internal padding baked in, so
 * rendering every icon at the same <img> width/height still leaves that
 * one looking visibly smaller than the rest. EURC's SVG circle is drawn
 * inside a 24x24 canvas but only spans a 18px-diameter circle centered in
 * it (25% margin on every side — a ~0.75 fill ratio), versus USDC's and
 * cirBTC's raster logos, which are cropped tight to ~98-100% of their
 * canvas. Multiplying by this scale (while the surrounding container
 * stays clipped to a circle via overflow:hidden) zooms the image in just
 * enough to cancel that padding out, so every token reads as the same
 * size at a glance.
 */
export const TOKEN_ICON_VISUAL_SCALE: Record<string, number> = {
  // EURC previously needed a 1.32x compensation here because its old SVG
  // had ~25% padding baked in. It's since been replaced with the official
  // Circle brand-kit asset (already correctly sized, no internal padding),
  // so no entry is needed — leaving this empty (rather than deleting the
  // mechanism) so it's ready if a future token logo has the same issue.
};

/** Pixel size an icon's <img> should be rendered at (width AND height, it's
 *  always square) to visually fill a `containerSize`-px circular slot,
 *  compensating for the source-file padding differences noted above. Pass
 *  the same `containerSize` you use for the wrapping circle's width/height
 *  — the container itself never changes size, only the image inside it. */
export function tokenIconRenderSize(symbol: string, containerSize: number): number {
  return Math.round(containerSize * (TOKEN_ICON_VISUAL_SCALE[symbol] ?? 1));
}

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
  if (USDC_ADDRESS && address.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
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
