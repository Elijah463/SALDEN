import { NextResponse } from 'next/server';
import { getLifiSupportedChains } from '@/lib/lifi/client';
import { arcChain } from '@/lib/contracts/config';
import { mainnet, base, arbitrum, avalanche, linea } from 'viem/chains';

// Salden's bridge-candidate chains on Arc mainnet. Arc's chain ID comes from the
// same NEXT_PUBLIC_CHAIN_ID env var as the rest of the app; the others are the
// standard mainnet IDs. Bridging itself is handled by Circle Bridge Kit (see
// lib/circle/appKit.ts); this endpoint only gates the optional price hint.
const SALDEN_BRIDGE_CANDIDATES = [
  { chainId: arcChain.id,  key: 'arct', name: 'Arc Network' },
  { chainId: mainnet.id,   key: 'eth',  name: 'Ethereum' },
  { chainId: base.id,      key: 'bas',  name: 'Base' },
  { chainId: arbitrum.id,  key: 'arb',  name: 'Arbitrum' },
  { chainId: avalanche.id, key: 'ava',  name: 'Avalanche' },
  { chainId: linea.id,     key: 'lin',  name: 'Linea' },
] as const;

export async function GET() {
  // Pricing hint only: if LI.FI is unreachable, report no pricing rather than failing the page.
  const lifiChains = await getLifiSupportedChains().catch(() => []) ?? [];
  const lifiChainIds = new Set(lifiChains.map(c => c.id));

  const supported = SALDEN_BRIDGE_CANDIDATES.map(c => ({
    ...c,
    lifiPricingAvailable: lifiChainIds.has(c.chainId),
  }));

  return NextResponse.json({ chains: supported });
}
