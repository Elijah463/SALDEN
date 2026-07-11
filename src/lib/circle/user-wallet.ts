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
// Arc isn't (yet) one of Circle's individually-named Wallets API chains, so
// it's created through their generic "Other EVM blockchains" path — see
// https://developers.circle.com/w3s/supported-blockchains-and-currencies
// and https://developers.circle.com/wallets/sign-tx-evm. Two hard
// requirements from that doc, both of which this used to get wrong:
//
//  1. Chain code must be 'EVM-TESTNET', not 'EVM' — 'EVM' is the MAINNET
//     variant. Passing it while authenticated with a sandbox
//     (TEST_API_KEY:-prefixed) CIRCLE_API_KEY is exactly what produced
//     "TEST_API key cannot be used with blockchain mainnets": we were
//     telling Circle we wanted a mainnet wallet.
//  2. accountType must be 'EOA' — Circle's docs state plainly that
//     generic "Other EVM blockchains" support ONLY EOA, not SCA
//     (Smart-Contract Account). SCA requires their Gas Station, which
//     isn't available on this generic path regardless of network. This
//     is a real product-level change from the original SCA intent, not
//     just a naming fix: new social-login users get a plain EOA wallet,
//     which means it needs to hold native gas (USDC, since Arc uses USDC
//     as gas) before it can send its own transactions — there's no
//     built-in gas sponsorship on this path. Worth confirming the
//     faucet/funding flow covers brand-new wallets, separately from this
//     fix.
export async function initializeUserWallet(userToken: string): Promise<string> {
  const json = await circlePost(
    '/user/initialize',
    {
      idempotencyKey: crypto.randomUUID(),
      blockchains:    ['EVM-TESTNET'],
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
