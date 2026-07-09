/**
 * @file lib/circle/agent-wallet.ts
 * SERVER-SIDE ONLY — never import in client components.
 *
 * Manages the AI Agent's developer-controlled Circle wallet using:
 * - CIRCLE_API_KEY (developer API key)
 * - CIRCLE_ENTITY_SECRET (entity secret for signing)
 * - NEXT_PUBLIC_CIRCLE_APP_ID (app ID)
 *
 * The agent wallet is a developer-controlled wallet owned by Salden.
 * It can be authorised (via addAgent on the payroll contract) to execute
 * batch payments on behalf of the employer.
 *
 * Circle SDK: @circle-fin/developer-controlled-wallets
 */

const CIRCLE_API_BASE = 'https://api.circle.com/v1/w3s';

/** Build headers per-call so env vars are resolved at runtime, not build time */
function getHeaders(): Record<string, string> {
  const apiKey       = process.env.CIRCLE_API_KEY ?? '';
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET ?? '';

  if (!apiKey)       throw new Error('CIRCLE_API_KEY is not set');
  if (!entitySecret) throw new Error('CIRCLE_ENTITY_SECRET is not set');

  return {
    'Content-Type':              'application/json',
    'Authorization':             `Bearer ${apiKey}`,
    'X-Entity-Secret-Ciphertext': entitySecret,
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
  const res = await fetch(`${CIRCLE_API_BASE}/developer/wallets`, {
    method:  'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      idempotencyKey,
      blockchains: ['ETH'],           // Arc Testnet uses ETH-compatible addresses
      accountType: 'EOA',
      metadata: [{ name: 'Salden AI Agent Wallet', refId: idempotencyKey }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Circle wallet creation failed: ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  const wallet = data.data?.wallet;
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
  const res = await fetch(`${CIRCLE_API_BASE}/developer/transactions/contractExecution`, {
    method:  'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      idempotencyKey:       params.idempotencyKey,
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
  const res = await fetch(`${CIRCLE_API_BASE}/developer/transactions/transfer`, {
    method:  'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      idempotencyKey: params.idempotencyKey,
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
