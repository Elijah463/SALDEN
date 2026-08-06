/**
 * @file lib/circle/faucet.ts
 * SERVER-SIDE ONLY — never import in client components.
 *
 * Lets the AI Agent autonomously top up testnet USDC for either its own
 * Circle-managed wallet or the employer's wallet (connected EOA or Circle
 * embedded wallet — both resolve to a single on-chain address upstream).
 *
 * Circle Faucet API reference:
 *   POST https://api.circle.com/v1/faucet/drips
 *   Docs: https://developers.circle.com/w3s/developer-console-faucet
 *
 * Rate limit (enforced by Circle, not by us): 20 USDC per address, per
 * blockchain, every 2 hours. We don't duplicate that bookkeeping here — we
 * just read Circle's response and report it back to the caller faithfully.
 */

import { createPublicClient, http, formatEther, isAddress } from 'viem';
import { arcTestnet } from '@/lib/contracts/config';

const FAUCET_URL = 'https://api.circle.com/v1/faucet/drips';
const ARC_BLOCKCHAIN_ID = 'ARC-TESTNET';

function getApiKey(): string {
  const key = process.env.CIRCLE_API_KEY;
  if (!key) throw new Error('CIRCLE_API_KEY is not configured');
  return key;
}

// Single shared read client — balance checks are public on-chain reads,
// identical whether the address belongs to a Circle wallet or a plain EOA.
const publicClient = createPublicClient({
  chain:     arcTestnet,
  transport: http(arcTestnet.rpcUrls.default.http[0]),
});

// ── Balance check ───────────────────────────────────────────────────────────
// Arc Testnet's native gas token IS USDC (18-decimal native balance — see
// the dual-decimal note in lib/contracts/config.ts). A plain native balance
// read is the correct, simplest way to check "does this wallet have USDC".

export interface BalanceResult {
  address: string;
  balance: string;   // formatted decimal string, e.g. "12.5"
}

export async function getUsdcBalance(address: string): Promise<BalanceResult> {
  if (!isAddress(address)) throw new Error(`Invalid address: ${address}`);
  const wei = await publicClient.getBalance({ address: address as `0x${string}` });
  return { address, balance: formatEther(wei) };
}

// ── Faucet drip ─────────────────────────────────────────────────────────────

export type FaucetOutcome =
  | { status: 'funded';      address: string; balanceBefore: string; balanceAfter: string }
  | { status: 'pending';     address: string; message: string }
  | { status: 'rate_limited'; address: string; message: string }
  | { status: 'error';       address: string; message: string };

/**
 * Requests testnet USDC for `address`, then polls the on-chain balance for
 * a short window to confirm it actually landed before reporting back.
 *
 * Polling is intentionally short (≈12s total) to stay well inside typical
 * serverless function time limits — if funds haven't landed by then, we
 * return 'pending' rather than blocking the whole chat response further.
 */
export async function requestFaucetDrip(address: string): Promise<FaucetOutcome> {
  if (!isAddress(address)) {
    return { status: 'error', address, message: `"${address}" is not a valid wallet address.` };
  }

  const { balance: balanceBefore } = await getUsdcBalance(address);

  let res: Response;
  try {
    res = await fetch(FAUCET_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${getApiKey()}`,
      },
      body: JSON.stringify({
        address,
        blockchain: ARC_BLOCKCHAIN_ID,
        usdc:       true,
        native:     false,
        eurc:       false,
      }),
    });
  } catch (err) {
    return { status: 'error', address, message: `Could not reach Circle's faucet: ${(err as Error).message}` };
  }

  if (res.status === 429) {
    // Read Circle's actual response body instead of assuming why — a 429
    // here doesn't necessarily mean THIS address's own 2-hour allowance
    // was hit; it's also the generic status Circle (or any API) returns
    // for other throttling (e.g. a shared-API-key-level limit if this
    // backend's faucet calls are running in a tight burst — see
    // lib/agent/autonomousExecution.ts's automatic top-up, which can call
    // this same endpoint for the agent wallet without the person ever
    // directly asking for it). Reporting Circle's own message when
    // available beats confidently asserting a specific cause we haven't
    // actually verified.
    const body = await res.json().catch(() => null) as { message?: string; error?: string } | null;
    const circleReason = body?.message ?? body?.error;
    return {
      status:  'rate_limited',
      address,
      message: circleReason
        ? `Circle's faucet returned: "${circleReason}"`
        : 'Circle\'s testnet faucet is rate-limiting this request (HTTP 429). This is normally the 20 USDC / 2-hour per-address limit, but can also happen from other requests in quick succession — please try again in a few minutes.',
    };
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const reason = body?.message ?? body?.error ?? `HTTP ${res.status}`;
    return { status: 'error', address, message: `Faucet request failed: ${reason}` };
  }

  // ── Poll briefly for the balance to actually increase ──────────────────────
  const POLL_ATTEMPTS = 4;
  const POLL_INTERVAL_MS = 3000;

  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const { balance: current } = await getUsdcBalance(address);
    if (Number(current) > Number(balanceBefore)) {
      return { status: 'funded', address, balanceBefore, balanceAfter: current };
    }
  }

  return {
    status:  'pending',
    address,
    message: 'The faucet accepted the request, but the funds had not arrived on-chain yet after ~12 seconds. They typically land within a minute — check the balance again shortly.',
  };
}
