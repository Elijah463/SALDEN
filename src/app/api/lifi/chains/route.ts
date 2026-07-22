import { NextResponse } from 'next/server';
import { getLifiSupportedChains } from '@/lib/lifi/client';

// Salden's bridge-candidate testnets — chain IDs confirmed directly against
// LI.FI's live /v1/chains response (Arc Testnet, Base Sepolia, Arbitrum
// Sepolia) or Circle's own official chain-ID references (the other three).
// Bridging itself works on all six regardless of what LI.FI returns here —
// that's Circle Bridge Kit's job, confirmed separately (see
// lib/circle/appKit.ts). This endpoint only gates the optional "≈ $X.XX"
// price hint.
const SALDEN_TESTNET_CANDIDATES = [
  { chainId: 5042002,   key: 'arct',  name: 'Arc Testnet' },
  { chainId: 11155111,  key: 'sep',   name: 'Ethereum Sepolia' },
  { chainId: 84532,     key: 'bast',  name: 'Base Sepolia' },
  { chainId: 421614,    key: 'arbs',  name: 'Arbitrum Sepolia' },
  { chainId: 43113,     key: 'avaf',  name: 'Avalanche Fuji' },
  { chainId: 59141,     key: 'lis',   name: 'Linea Sepolia' },
] as const;

export async function GET() {
  const lifiChains = await getLifiSupportedChains();
  const lifiChainIds = new Set(lifiChains.map(c => c.id));

  const supported = SALDEN_TESTNET_CANDIDATES.map(c => ({
    ...c,
    lifiPricingAvailable: lifiChainIds.has(c.chainId),
  }));

  return NextResponse.json({ chains: supported });
}
