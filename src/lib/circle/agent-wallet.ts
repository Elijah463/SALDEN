/**
 * @file lib/circle/agent-wallet.ts
 * SERVER-SIDE ONLY — never import in client components.
 *
 * Manages the AI Agent's developer-controlled Circle wallet using:
 * - CIRCLE_API_KEY (developer API key)
 * - CIRCLE_ENTITY_SECRET (32-byte hex-encoded entity secret)
 * - CIRCLE_WALLET_SET_ID (the wallet set every agent wallet is created under)
 * - NEXT_PUBLIC_CIRCLE_APP_ID (app ID)
 *
 * The agent wallet is a developer-controlled wallet owned by Salden.
 * It can be authorised (via addAgent on the payroll contract) to execute
 * batch payments on behalf of the employer.
 *
 * ── Entity secret ciphertext — this file's biggest fix ────────────────────
 * Every "critical" (mutating) Developer-Controlled Wallets endpoint —
 * create wallet, execute a contract call, transfer — requires an
 * `entitySecretCiphertext` field IN THE REQUEST BODY: the raw 32-byte
 * entity secret, RSA-OAEP(SHA-256) encrypted with Circle's published
 * public key, then base64-encoded. It must be freshly generated for
 * EVERY request — Circle rejects a reused ciphertext outright as a
 * replay-attack guard. See:
 *   https://developers.circle.com/wallets/dev-controlled/entity-secret-management
 *   https://github.com/circlefin/w3s-entity-secret-sample-code
 *
 * A previous version of this file sent the RAW entity secret as an
 * `X-Entity-Secret-Ciphertext` HTTP header — not encrypted, and not even
 * in the body. That was never going to work; Circle's API has no such
 * header at all. Combined with a missing `walletSetId` and a
 * non-UUID `idempotencyKey` (also required, also rejected), every single
 * developer-controlled-wallet mutation in this codebase was guaranteed to
 * fail with exactly the "field may not be empty" / "not in the correct
 * UUID format" errors this was built to fix.
 *
 * getEntitySecretCiphertext() below implements the real encryption using
 * Node's built-in `crypto` module (no SDK dependency needed for this —
 * it's ~15 lines once you have the algorithm right, which is the part
 * that actually took verifying against Circle's docs). Circle's public
 * key is fetched once and cached in module scope (the KEY itself is
 * static; only the ciphertext must be fresh per-request, which this
 * still does every time it's called).
 */

import { getEntitySecretCiphertext, toUUIDv5 } from './entitySecret';

const CIRCLE_API_BASE = 'https://api.circle.com/v1/w3s';

/** Build headers per-call so env vars are resolved at runtime, not build time.
 *  NOTE: entitySecretCiphertext is deliberately NOT a header — see
 *  entitySecret.ts. It belongs in the body of each individual mutating
 *  request, freshly generated every time. */
function getHeaders(): Record<string, string> {
  const apiKey = process.env.CIRCLE_API_KEY ?? '';
  if (!apiKey) throw new Error('CIRCLE_API_KEY is not set');

  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
}

export interface AgentWalletInfo {
  walletId:   string;
  address:    string;
  blockchain: string;
  state:      string;
}

// ── Create a new developer-controlled wallet for the agent ────────────────────

export async function createAgentWallet(
  idempotencyKey: string
): Promise<AgentWalletInfo> {
  const walletSetId = process.env.CIRCLE_WALLET_SET_ID ?? '';
  if (!walletSetId) throw new Error('CIRCLE_WALLET_SET_ID is not set — create one via POST /v1/w3s/developer/walletSets once and store its id');

  const entitySecretCiphertext = await getEntitySecretCiphertext();

  const res = await fetch(`${CIRCLE_API_BASE}/developer/wallets`, {
    method:  'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      // Circle requires real UUID syntax here — `idempotencyKey` as passed
      // in by callers (e.g. `salden-agent-0xbe2e...`) is not one, so it's
      // deterministically mapped to a UUID. The original string is still
      // used as `refId` below unchanged, so getAgentWalletByRefId() lookups
      // are unaffected.
      idempotencyKey: toUUIDv5(idempotencyKey),
      walletSetId,
      entitySecretCiphertext,
      blockchains: ['ARC-TESTNET'],    // Circle has a native identifier for Arc Testnet — see https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/get-wallets for the full enum. Using 'ETH' here was wrong on two counts: it's Ethereum MAINNET (hence "TEST_API key cannot be used with blockchain mainnets"), and Arc Testnet doesn't need an ETH-compatible stand-in — Circle supports it directly.
      accountType: 'EOA',
      metadata: [{ name: 'Salden AI Agent Wallet', refId: idempotencyKey }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Circle wallet creation failed: ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  const wallet = data.data?.wallets?.[0] ?? data.data?.wallet;
  return {
    walletId:   wallet.id,
    address:    wallet.address,
    blockchain: wallet.blockchain,
    state:      wallet.state,
  };
}

// ── Get an existing wallet by wallet ID ────────────────────────────────────────

export async function getAgentWallet(walletId: string): Promise<AgentWalletInfo> {
  const res = await fetch(`${CIRCLE_API_BASE}/wallets/${walletId}`, {
    headers: getHeaders(),
  });

  if (!res.ok) throw new Error(`Failed to fetch Circle wallet ${walletId}`);

  const data = await res.json();
  const wallet = data.data?.wallet;
  return {
    walletId:   wallet.id,
    address:    wallet.address,
    blockchain: wallet.blockchain,
    state:      wallet.state,
  };
}

// ── Look up a wallet by its refId (authoritative, server-derived lookup) ──────
//
// Every agent wallet is created with `metadata: [{ refId: idempotencyKey }]`
// where idempotencyKey is deterministically derived from the employer's
// wallet address (see lib/agent/agentIdentity.ts). That means the server
// can always ask Circle "which wallet did I create for this employer?"
// instead of trusting a client-supplied walletId/address — this is what
// closes the authorisation gap where a request body could otherwise claim
// any agentWalletId it wanted (see agentIdentity.ts for the full writeup).
//
// NOTE: this filters Circle's wallet-list endpoint by the `refId` query
// parameter. This matches Circle's documented metadata/refId lookup
// pattern, but — like the check_ofac_compliance endpoint shape elsewhere
// in this codebase — it has not been exercised against a live Circle
// account by this author. Verify the exact query param name and response
// shape against your Circle Developer-Controlled Wallets API docs/sandbox
// before relying on this in production; if the param name differs, this
// function is the only place that needs to change (agentIdentity.ts just
// calls it and reacts to null).
export async function getAgentWalletByRefId(refId: string): Promise<AgentWalletInfo | null> {
  const res = await fetch(`${CIRCLE_API_BASE}/wallets?refId=${encodeURIComponent(refId)}`, {
    headers: getHeaders(),
  });

  if (!res.ok) return null;

  const data = await res.json();
  const wallet = data.data?.wallets?.[0];
  if (!wallet) return null;

  return {
    walletId:   wallet.id,
    address:    wallet.address,
    blockchain: wallet.blockchain,
    state:      wallet.state,
  };
}

// ── Initiate a contract call transaction from the agent wallet ────────────────
// Used when the AI Agent executes batchPay via the payroll contract.

export interface ContractCallTxParams {
  walletId:         string;
  contractAddress:  string;
  abiFunctionSignature: string;   // e.g. "batchPay(address[],uint256[],address)"
  abiParameters:    unknown[];
  idempotencyKey:   string;
  feeLevel?:        'LOW' | 'MEDIUM' | 'HIGH';
}

export interface TxResponse {
  id:     string;
  state:  string;
  txHash?: string;
}

export async function executeContractCall(
  params: ContractCallTxParams
): Promise<TxResponse> {
  const entitySecretCiphertext = await getEntitySecretCiphertext();

  const res = await fetch(`${CIRCLE_API_BASE}/developer/transactions/contractExecution`, {
    method:  'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      idempotencyKey:       toUUIDv5(params.idempotencyKey),
      entitySecretCiphertext,
      walletId:             params.walletId,
      contractAddress:      params.contractAddress,
      abiFunctionSignature: params.abiFunctionSignature,
      abiParameters:        params.abiParameters,
      feeLevel:             params.feeLevel ?? 'MEDIUM',
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Circle contract call failed: ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  const tx = data.data?.transaction;
  return { id: tx.id, state: tx.state, txHash: tx.txHash };
}

// ── Poll transaction status until confirmed or failed ─────────────────────────

export async function pollTxStatus(
  txId: string,
  maxAttempts = 30,
  intervalMs = 2000
): Promise<TxResponse> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${CIRCLE_API_BASE}/transactions/${txId}`, {
      headers: getHeaders(),
    });

    if (!res.ok) throw new Error(`Failed to poll tx ${txId}`);
    const data = await res.json();
    const tx = data.data?.transaction;

    if (tx.state === 'CONFIRMED' || tx.state === 'FAILED') {
      return { id: tx.id, state: tx.state, txHash: tx.txHash };
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

  throw new Error('Transaction polling timed out after ' + maxAttempts + ' attempts.');
}

// ── Single-shot transaction status check (no internal loop/sleep) ────────────
//
// pollTxStatus() above loops internally with its own setTimeout, which is
// exactly what you want for a short, blocking, best-effort check inside a
// single synchronous request (see autonomousExecution.ts). It is NOT what
// you want when the caller itself is driving a poll loop externally (e.g.
// Inngest's step.run + step.sleep pattern in lib/inngest/functions.ts) —
// looping internally there would either block Vercel compute for the
// entire wait, or throw a "timed out" error on every single check that
// hasn't confirmed yet, which the caller would then have to specifically
// swallow. This does exactly one fetch and returns whatever state Circle
// reports right now (including PENDING/QUEUED/etc, unlike pollTxStatus
// which never returns those to the caller).
export async function getTxStatus(txId: string): Promise<TxResponse> {
  const res = await fetch(`${CIRCLE_API_BASE}/transactions/${txId}`, {
    headers: getHeaders(),
  });

  if (!res.ok) throw new Error(`Failed to fetch status for tx ${txId}`);
  const data = await res.json();
  const tx = data.data?.transaction;
  return { id: tx.id, state: tx.state, txHash: tx.txHash };
}

// ── Send USDC from the agent wallet (for fee top-ups etc.) ────────────────────

export async function sendUSDC(params: {
  fromWalletId: string;
  toAddress:    string;
  amount:       string;   // decimal string e.g. "100.00"
  tokenId:      string;   // Circle USDC token ID
  idempotencyKey: string;
}): Promise<TxResponse> {
  const entitySecretCiphertext = await getEntitySecretCiphertext();

  const res = await fetch(`${CIRCLE_API_BASE}/developer/transactions/transfer`, {
    method:  'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      idempotencyKey: toUUIDv5(params.idempotencyKey),
      entitySecretCiphertext,
      walletId:       params.fromWalletId,
      destinationAddress: params.toAddress,
      amounts:        [params.amount],
      tokenId:        params.tokenId,
      feeLevel:       'MEDIUM',
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Circle transfer failed: ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  const tx = data.data?.transaction;
  return { id: tx.id, state: tx.state, txHash: tx.txHash };
}
