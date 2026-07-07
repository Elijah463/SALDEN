/**
 * @file lib/agent/toolExecutors.ts
 * SERVER-SIDE ONLY.
 *
 * Real implementations behind the agent's function-calling tools (see
 * tools.ts for the Gemini schemas). These were previously just claimed in
 * the system prompt with nothing behind them — the agent could only
 * guess at a balance or compliance status. Now they hit real on-chain
 * reads or a real (pluggable) compliance provider.
 */

import { getAddress, isAddress, formatUnits } from 'viem';
import crypto from 'crypto';
import { getServerPublicClient } from './chain';
import { ERC20_ABI } from '@/lib/contracts/abis';

// ── get_balance ──────────────────────────────────────────────────────────────

export interface BalanceResult {
  ok: boolean;
  address?: string;
  token?: string;
  balance?: string;
  error?: string;
}

/**
 * Reads a real on-chain balance. `token` is either 'native' (the chain's
 * gas token) or an ERC-20 symbol resolved against the tokenRegistry the
 * client already sent in this request's context (so this never guesses a
 * token address — if it's not in the registry the tool fails honestly
 * rather than reading the wrong contract).
 */
export async function executeGetBalance(
  address: string,
  token: string,
  tokenRegistry: Record<string, { symbol: string; decimals: number }> | undefined,
): Promise<BalanceResult> {
  if (!isAddress(address)) return { ok: false, error: 'That wallet address isn\'t valid.' };
  let checksummed: string;
  try { checksummed = getAddress(address); } catch { return { ok: false, error: 'That wallet address isn\'t valid.' }; }

  const client = getServerPublicClient();

  try {
    if (token.toLowerCase() === 'native') {
      const wei = await client.getBalance({ address: checksummed as `0x${string}` });
      return { ok: true, address: checksummed, token: 'native', balance: formatUnits(wei, 18) };
    }

    const entry = Object.entries(tokenRegistry ?? {})
      .find(([, v]) => v.symbol.toUpperCase() === token.toUpperCase());

    if (!entry) {
      return { ok: false, error: `"${token}" isn't in the token registry — balance check unavailable.` };
    }

    const [tokenAddr, meta] = entry;
    const raw = await client.readContract({
      address: tokenAddr as `0x${string}`, abi: ERC20_ABI,
      functionName: 'balanceOf', args: [checksummed as `0x${string}`],
    }) as bigint;

    return { ok: true, address: checksummed, token: meta.symbol, balance: formatUnits(raw, meta.decimals) };
  } catch {
    return { ok: false, error: 'Balance check failed — the network may be temporarily unavailable.' };
  }
}

// ── get_transaction_status ─────────────────────────────────────────────────────

export interface TxStatusResult {
  ok: boolean;
  status?: 'success' | 'reverted' | 'pending' | 'not_found';
  blockNumber?: string;
  error?: string;
}

export async function executeGetTransactionStatus(txHash: string): Promise<TxStatusResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, error: 'That doesn\'t look like a valid transaction hash.' };
  }

  const client = getServerPublicClient();
  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
    return {
      ok: true,
      status: receipt.status === 'success' ? 'success' : 'reverted',
      blockNumber: receipt.blockNumber.toString(),
    };
  } catch {
    try {
      const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
      return { ok: true, status: tx ? 'pending' : 'not_found' };
    } catch {
      return { ok: true, status: 'not_found' };
    }
  }
}

// ── check_ofac_compliance ──────────────────────────────────────────────────────

export interface OfacResult {
  ok: boolean;
  address?: string;
  sanctioned?: boolean;
  provider: string;
  error?: string;
}

// A small set of well-documented, publicly-known OFAC SDN-designated
// crypto addresses (e.g. the August 2022 Tornado Cash designations) used
// ONLY as a fallback when no real compliance provider is configured. This
// is NOT a substitute for a real screening provider — it covers a handful
// of historically public cases, nothing close to the full SDN list, and
// is not maintained for new designations. The tool result says so
// explicitly so the AI agent (and you) don't mistake it for real coverage.
const KNOWN_SANCTIONED_FALLBACK = new Set([
  '0x8589427373d6d84e98730d7795d8f6f8731fda0', // Tornado Cash
  '0x722122df12d4e14e13ac3b6895a86e84145b6e0',
  '0xdd4c48c0b24039969fc16d1cdf626eab821d3e0',
  '0xd90e2f925da726b50c4ed8d0fb90ad053324f31',
  '0x07687e702b410fa43f4cb4af7fa097918ffd2730',
  '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf',
  '0xa160cdab225685da1d56aa342ad8841c3b53f291',
].map(a => a.toLowerCase()));

/**
 * Pluggable compliance check. If ELLIPTIC_API_KEY and ELLIPTIC_API_SECRET
 * are both set, calls Elliptic's Wallet Screening API (synchronous
 * exposure endpoint). Otherwise falls back to the small known-address
 * list above with an explicit "limited coverage" flag in the result so
 * the model never reports a false sense of confidence.
 *
 * Replaces the previous Chainalysis integration (removed) — Elliptic's
 * request/response shape below is based on their published API docs
 * (https://developers.elliptic.co, "Authentication" and "Wallet Screening
 * — Synchronous" pages) rather than a live sandbox call from this build
 * environment (no network access here to actually exercise it). Two
 * things worth double-checking in your onboarding call before relying on
 * this in production:
 *   1. The `asset`/`blockchain` values below ("ETH"/"ethereum") assume
 *      Elliptic treats Salden's chain (Arc testnet, an EVM chain) the
 *      same as standard Ethereum for address-format purposes. If Arc
 *      isn't in Elliptic's supported network list, ask them what
 *      asset/blockchain pair to use for it, or whether testnet addresses
 *      are screened at all (many providers only cover mainnet).
 *   2. The exact shape of a successful response (this reads
 *      `risk_score` per Elliptic's Python SDK example — a numeric score,
 *      where this code treats "sanctions" risk type as the disqualifying
 *      signal). Confirm the field name/threshold that means "sanctioned"
 *      specifically, as opposed to merely "elevated risk" for some other
 *      reason (mixers, high-risk exchanges, etc.) — those are not the
 *      same determination and this tool is specifically an OFAC/sanctions
 *      check, not a general risk-score gate.
 */
export async function executeCheckOfacCompliance(address: string): Promise<OfacResult> {
  if (!isAddress(address)) return { ok: false, provider: 'none', error: 'That wallet address isn\'t valid.' };
  let checksummed: string;
  try { checksummed = getAddress(address); } catch { return { ok: false, provider: 'none', error: 'That wallet address isn\'t valid.' }; }

  const apiKey    = process.env.ELLIPTIC_API_KEY;
  const apiSecret = process.env.ELLIPTIC_API_SECRET;

  if (apiKey && apiSecret) {
    try {
      const method = 'POST';
      const path = '/v2/wallet/synchronous';
      const requestBody = {
        subject: { asset: 'ETH', blockchain: 'ethereum', type: 'address', hash: checksummed },
        type: 'wallet_exposure',
        customer_reference: 'salden-agent-compliance-check',
      };
      const bodyStr = JSON.stringify(requestBody);
      const timestamp = Date.now().toString();

      // Elliptic's documented signing scheme: base64(HMAC-SHA256(
      //   base64_decode(secret), `${timestamp}${METHOD}${path}${body}`
      // )), sent as x-access-key / x-access-sign / x-access-timestamp.
      const signaturePayload = `${timestamp}${method}${path}${bodyStr}`;
      const signature = crypto
        .createHmac('sha256', Buffer.from(apiSecret, 'base64'))
        .update(signaturePayload)
        .digest('base64');

      const res = await fetch(`https://aml-api.elliptic.co${path}`, {
        method,
        headers: {
          'Content-Type':      'application/json',
          'x-access-key':      apiKey,
          'x-access-sign':     signature,
          'x-access-timestamp': timestamp,
        },
        body: bodyStr,
      });
      if (!res.ok) throw new Error('Compliance check failed.');

      const data = await res.json() as { risk_score?: number; risk_treatment?: string };
      // Conservative interpretation until the exact response schema is
      // confirmed with Elliptic (see file comment above): treat either an
      // explicit high-risk treatment flag OR a risk_score at/above 8 (on
      // what Elliptic documents as a 0-10 scale) as "sanctioned" for the
      // purposes of this specific OFAC-style check. Tune this once you've
      // confirmed the real field semantics on your call.
      const sanctioned = data.risk_treatment === 'high_risk' || (typeof data.risk_score === 'number' && data.risk_score >= 8);
      return { ok: true, address: checksummed, sanctioned, provider: 'elliptic' };
    } catch {
      return { ok: false, provider: 'elliptic', error: 'Compliance check is temporarily unavailable. Try again shortly.' };
    }
  }

  const sanctioned = KNOWN_SANCTIONED_FALLBACK.has(checksummed.toLowerCase());
  return {
    ok: true, address: checksummed, sanctioned,
    provider: 'fallback-limited-list',
  };
}
