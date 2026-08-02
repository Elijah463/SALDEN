/**
 * @file lib/circle/user-wallet.ts
 * SERVER-SIDE ONLY.
 *
 * Manages User-Controlled Wallets (UCW) for Salden login users.
 * Each user who authenticates (email OTP or Google) gets a Circle UCW
 * whose EVM address is their Onchain identity in the payroll system.
 *
 * Circle User-Controlled Wallets API reference:
 *   https://developers.circle.com/w3s/reference/
 *
 * Flow:
 *  1. createOrGetUser(userId)         — idempotent; won't error if user exists
 *  2. getUserSession(userId)          — returns { userToken, encryptionKey }
 *  3. initializeUserWallet(userToken) — returns challengeId for client SDK
 *  4. getUserWallets(userToken)        — returns array of wallets after setup
 */

import { getEntitySecretCiphertext, toUUIDv5 } from './entitySecret';

const CIRCLE_API = 'https://api.circle.com/v1/w3s';

function getApiKey(): string {
  const key = process.env.CIRCLE_API_KEY;
  if (!key) throw new Error('CIRCLE_API_KEY is not configured');
  return key;
}

function headers(userToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${getApiKey()}`,
  };
  if (userToken) h['X-User-Token'] = userToken;
  return h;
}

async function circlePost(path: string, body: unknown, userToken?: string) {
  const res = await fetch(`${CIRCLE_API}${path}`, {
    method:  'POST',
    headers: headers(userToken),
    body:    JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    // Circle returns { code, message } on error
    const msg = json?.message ?? json?.error ?? `Circle API error ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

async function circleGet(path: string, userToken?: string) {
  const res = await fetch(`${CIRCLE_API}${path}`, {
    headers: headers(userToken),
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.message ?? json?.error ?? `Circle API error ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

// ── 1. Create or silently retrieve an existing Circle user ────────────────────
//
// Circle returns 409 if the user already exists — we treat that as success.
export async function createOrGetUser(userId: string): Promise<void> {
  try {
    await circlePost('/users', { userId });
  } catch (err) {
    // "User already exists" is not a real error
    const msg = (err as Error).message ?? '';
    if (!msg.includes('already') && !msg.includes('409')) throw err;
  }
}

// ── 2. Get a short-lived session token for a user ─────────────────────────────
export interface CircleSession {
  userToken:     string;
  encryptionKey: string;
}

export async function getUserSession(userId: string): Promise<CircleSession> {
  const json = await circlePost('/users/token', { userId });
  const { userToken, encryptionKey } = json.data ?? {};
  if (!userToken || !encryptionKey) {
    throw new Error('Circle did not return a valid session token');
  }
  return { userToken, encryptionKey };
}

// ── 3. Initialize the user's wallets (first-time setup) ───────────────────────
//
// Returns the challengeId that the Circle Web SDK on the client must execute
// to prompt the user to set their PIN / recovery method.
//
// Arc Testnet IS one of Circle's individually-named Wallets API chains —
// chain code `ARC-TESTNET`, with full EOA + SCA + MSCA support and every
// Wallets API endpoint available (it is not listed under "Blockchain-
// specific limitations"). Verified directly against
// https://developers.circle.com/w3s/supported-blockchains-and-currencies.
// This used to say the opposite (that Arc fell under the generic "Other
// EVM blockchains" fallback) — that was wrong; that fallback is real and
// IS EOA-only with no contract execution support, but Arc was never
// actually in it.
//
// Two things that follow from using the correct chain code:
//  1. accountType stays 'EOA' for now — SCA is available for Arc, but
//     turning it on means configuring Circle's Gas Station (sponsorship
//     policy, funded sponsor wallet) in the Circle Console, which is a
//     dashboard-side change this codebase can't make or verify. Worth
//     doing later — it would remove the "brand-new wallet needs USDC
//     before its first tx" problem entirely — but out of scope here.
//  2. Because Arc is properly classified, /user/transactions/contractExecution
//     now works for these wallets — see createContractExecutionChallenge()
//     below and lib/circle/useUniversalWrite.ts, which uses it directly
//     instead of the old sign-then-broadcast-ourselves fallback.
export async function initializeUserWallet(userToken: string): Promise<string> {
  const json = await circlePost(
    '/user/initialize',
    {
      idempotencyKey: crypto.randomUUID(),
      blockchains:    ['ARC-TESTNET'],
      accountType:    'EOA',
    },
    userToken
  );
  const challengeId = json.data?.challengeId;
  if (!challengeId) throw new Error('Circle did not return a challenge ID');
  return challengeId;
}

// ── 4. Get wallets for a user (after challenge is executed) ───────────────────
export interface CircleWallet {
  id:         string;
  address:    string;
  blockchain: string;
  state:      string;
}

export async function getUserWallets(userToken: string): Promise<CircleWallet[]> {
  const json = await circleGet('/wallets', userToken);
  return (json.data?.wallets ?? []) as CircleWallet[];
}

// ── 5. Check if a user already has a wallet (no challenge needed) ─────────────
export async function getUserFirstWallet(
  userId: string
): Promise<{ session: CircleSession; wallet: CircleWallet | null; isNewUser: boolean }> {
  await createOrGetUser(userId);
  const session = await getUserSession(userId);
  const wallets = await getUserWallets(session.userToken);

  const liveWallet = wallets.find(w => w.state === 'LIVE') ?? null;
  return {
    session,
    wallet:    liveWallet,
    isNewUser: liveWallet === null,
  };
}

// ── 6. Create a contract-execution CHALLENGE for a user-controlled wallet ─────
//
// THE primary write path for social-login (Circle UCW) users — see
// lib/circle/useUniversalWrite.ts. Now that wallets are created under the
// correct `ARC-TESTNET` chain code (see initializeUserWallet() above),
// Circle's own /user/transactions/contractExecution handles simulation,
// gas estimation, signing and broadcasting — this codebase no longer
// builds/estimates/signs the raw transaction itself for these users.
//
// Unlike executeContractCall() in agent-wallet.ts (developer-controlled —
// Salden's own agent wallet, which Salden's server can authorise on its
// own), a USER-controlled wallet can only be authorised by that user's own
// PIN. This doesn't execute anything — it creates a pending challenge that
// the CLIENT must run through the Circle Web SDK (see
// lib/circle/executeChallenge.ts's executeCircleTransactionChallenge),
// which prompts the user's PIN and only then actually submits the
// transaction. Same idempotency-key and entity-secret-ciphertext
// requirements as every other "critical" Circle endpoint — see
// entitySecret.ts.
//
// `callData` is used here (not `abiFunctionSignature`/`abiParameters`)
// whenever the caller already has ABI-encoded calldata (which
// useUniversalWrite.ts always does, via viem's encodeFunctionData) —
// Circle's docs list these as mutually exclusive and equally valid, and
// reusing our own already-reliable calldata encoding avoids a second,
// redundant place that could get a function signature string wrong.
export interface ContractExecutionChallengeParams {
  userToken:              string;
  walletId:               string;
  contractAddress:        string;
  abiFunctionSignature?:  string;
  abiParameters?:         unknown[];
  callData?:              string;
  value?:                 string;   // native-token amount, only for payable calls
  idempotencyKey:         string;   // caller's own descriptive key — turned into a real UUID here, same pattern as agent-wallet.ts
}

export async function createContractExecutionChallenge(
  params: ContractExecutionChallengeParams
): Promise<string> {
  const entitySecretCiphertext = await getEntitySecretCiphertext();

  const body: Record<string, unknown> = {
    idempotencyKey:  toUUIDv5(params.idempotencyKey),
    walletId:        params.walletId,
    contractAddress: params.contractAddress,
    entitySecretCiphertext,
    feeLevel:        'MEDIUM',
  };
  if (params.callData) {
    body.callData = params.callData;
  } else {
    body.abiFunctionSignature = params.abiFunctionSignature;
    body.abiParameters        = params.abiParameters ?? [];
  }
  if (params.value) body.amount = params.value;

  const json = await circlePost('/user/transactions/contractExecution', body, params.userToken);
  const challengeId = json.data?.challengeId;
  if (!challengeId) throw new Error('Circle did not return a challenge ID for the contract execution');
  return challengeId;
}

// ── 7. Poll a transaction's status by id (shared shape with developer-controlled) ─
//
// Circle's GET /v1/w3s/transactions/{id} is the same endpoint regardless
// of whether the transaction came from a developer- or user-controlled
// wallet — this just needs the API key, not a user token. Mirrors
// getTxStatus() in agent-wallet.ts (kept as a separate copy rather than a
// shared import so this module has no dependency on agent-wallet.ts — see
// the file header's modularity note).
export interface CircleTxStatus {
  id:      string;
  state:   string;
  txHash?: string;
}

export async function getUserTxStatus(transactionId: string): Promise<CircleTxStatus> {
  const json = await circleGet(`/transactions/${transactionId}`);
  const tx = json.data?.transaction;
  return { id: tx.id, state: tx.state, txHash: tx.txHash };
}

// ── 8. Create a message-signing CHALLENGE for a user-controlled wallet ────────
//
// Same reasoning as createContractExecutionChallenge above — only the
// user's own PIN can authorise a signature from their wallet. Needed by
// any flow that signs a plain message rather than calling a contract
// (e.g. the IPFS employee-data sync's encryption-key derivation in
// lib/usePayrollSync.ts). Unlike contract execution, the SDK challenge
// callback for a signing challenge is documented to return the result
// directly as `result.data.signature` (confirmed via Circle's own SDK
// sample code) — no polling/fallback needed, see
// executeCircleMessageSigningChallenge() in executeChallenge.ts.
export interface MessageSigningChallengeParams {
  userToken:      string;
  walletId:       string;
  message:        string;
  idempotencyKey: string;
}

export async function createMessageSigningChallenge(
  params: MessageSigningChallengeParams
): Promise<string> {
  const entitySecretCiphertext = await getEntitySecretCiphertext();

  const json = await circlePost('/user/sign/message', {
    idempotencyKey: toUUIDv5(params.idempotencyKey),
    walletId:       params.walletId,
    message:        params.message,
    entitySecretCiphertext,
  }, params.userToken);

  const challengeId = json.data?.challengeId;
  if (!challengeId) throw new Error('Circle did not return a challenge ID for message signing');
  return challengeId;
}

// ── 9. SUPERSEDED — Create a transaction-SIGNING (not execution) challenge ────
//
// This was the write path while wallets were (incorrectly) created under
// the generic "Other EVM blockchains" classification, which really does
// disallow /user/transactions/contractExecution for user-controlled
// wallets — sign-only was the correct workaround for that classification.
// Now that initializeUserWallet() uses the real `ARC-TESTNET` chain code,
// contractExecution is fully supported and createContractExecutionChallenge()
// above is the live path (see useUniversalWrite.ts). Left in place, unused,
// as a reference/fallback rather than deleted — same convention as
// write-challenge/route.ts below it.
export interface TransactionSigningChallengeParams {
  userToken:      string;
  walletId:       string;
  transaction: {
    to:                     string;
    data?:                  string;
    value?:                 string;   // decimal string, wei — omit for 0
    gas:                    string;   // decimal string
    maxFeePerGas:           string;   // decimal string, wei
    maxPriorityFeePerGas:   string;   // decimal string, wei
    nonce:                  number;
    chainId:                number;
  };
  idempotencyKey: string;
}

export async function createTransactionSigningChallenge(
  params: TransactionSigningChallengeParams
): Promise<string> {
  const entitySecretCiphertext = await getEntitySecretCiphertext();

  const json = await circlePost('/user/sign/transaction', {
    idempotencyKey: toUUIDv5(params.idempotencyKey),
    walletId:       params.walletId,
    // Circle's API takes this as a JSON *string*, not a nested object —
    // confirmed against their own request example.
    transaction:    JSON.stringify(params.transaction),
    entitySecretCiphertext,
  }, params.userToken);

  const challengeId = json.data?.challengeId;
  if (!challengeId) throw new Error('Circle did not return a challenge ID for transaction signing');
  return challengeId;
}

/**
 * FALLBACK ONLY — see executeCircleTransactionChallenge() in
 * executeChallenge.ts for why this exists. Circle's Web SDK challenge
 * callback is documented to return `result.type` / `result.status`, but
 * the exact field carrying the resulting transaction's id for a
 * CONTRACT_EXECUTION challenge specifically isn't published anywhere
 * crawlable (unlike SIGN_MESSAGE, where `result.data.signature` is
 * explicit). Rather than guess a field name and silently return
 * `undefined` if wrong, the client tries the direct field first, and if
 * that comes back empty, falls back to asking here: "what's this
 * wallet's most recent transaction?" — reliable because a write challenge
 * only ever has one in-flight transaction per wallet at a time in this
 * app's flows (Salden doesn't fire concurrent writes from the same
 * social-login wallet).
 */
export async function getMostRecentTransaction(walletId: string): Promise<CircleTxStatus | null> {
  const json = await circleGet(`/transactions?walletId=${encodeURIComponent(walletId)}&pageSize=1`);
  const tx = json.data?.transactions?.[0];
  if (!tx) return null;
  return { id: tx.id, state: tx.state, txHash: tx.txHash };
}
