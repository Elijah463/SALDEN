'use client';
/**
 * @file lib/circle/executeChallenge.ts
 * CLIENT-SIDE only.
 *
 * Shared utility for executing a Circle Web SDK challenge.
 * Used by both LoginModal (Google OAuth) and OTPForm (email OTP).
 * Uses @circle-fin/w3s-pw-web-sdk — the same SDK as LoginModal.
 *
 * Flow:
 *  1. Load Circle SDK dynamically (client-side only)
 *  2. Set authentication context (userToken + encryptionKey)
 *  3. Execute challenge → user sees PIN setup popup
 *  4. Poll /api/auth/wallet-address until wallet is LIVE
 *  5. Return the EVM wallet address
 */

interface ChallengeParams {
  challengeId:   string;
  userToken:     string;
  encryptionKey: string;
  email:         string;
  onStatusChange?: (msg: string) => void;
}

export async function executeCircleChallenge({
  challengeId,
  userToken,
  encryptionKey,
  email,
  onStatusChange,
}: ChallengeParams): Promise<string> {
  const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID ?? '';

  onStatusChange?.('Setting up your secure wallet…');

  // Dynamic import — same as LoginModal — keeps it out of SSR bundle
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { W3SSdk } = await import('@circle-fin/w3s-pw-web-sdk') as any;

  const sdk = new W3SSdk({ appSettings: { appId } });
  sdk.setAuthentication({ userToken, encryptionKey });

  await new Promise<void>((resolve, reject) => {
    sdk.execute(challengeId, async (err: unknown) => {
      if (err) {
        reject(new Error((err as Error)?.message ?? 'Circle challenge failed'));
        return;
      }
      resolve();
    });
  });

  onStatusChange?.('Fetching your wallet address…');

  // Poll for the wallet address — Circle provisions it asynchronously
  const MAX_POLLS      = 20;
  const POLL_INTERVAL  = 1500;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    try {
      const res = await fetch(
        `/api/auth/wallet-address?userId=${encodeURIComponent(email)}`
      );
      if (res.ok) {
        const data = await res.json() as { walletAddress?: string };
        if (data.walletAddress) return data.walletAddress;
      }
    } catch { /* continue polling */ }
  }

  throw new Error('Wallet not ready — challenge may not have completed. Please try again.');
}

// ── Transaction (contract execution) challenge — used by useUniversalWrite ────
//
// Separate from executeCircleChallenge() above (which is wallet SETUP —
// polls for a wallet address). This is for actually SIGNING AND SENDING A
// TRANSACTION via a social-login wallet's PIN. See lib/circle/user-wallet.ts's
// getMostRecentTransaction() doc comment for why this tries a direct field
// first and falls back to a wallet lookup rather than assuming one
// specific field name.
interface TransactionChallengeParams {
  challengeId:    string;
  userToken:      string;
  encryptionKey:  string;
  walletId:       string;
  onStatusChange?: (msg: string) => void;
}

export async function executeCircleTransactionChallenge({
  challengeId,
  userToken,
  encryptionKey,
  walletId,
  onStatusChange,
}: TransactionChallengeParams): Promise<`0x${string}`> {
  const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID ?? '';

  onStatusChange?.('Waiting for you to approve with your PIN…');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { W3SSdk } = await import('@circle-fin/w3s-pw-web-sdk') as any;
  const sdk = new W3SSdk({ appSettings: { appId } });
  sdk.setAuthentication({ userToken, encryptionKey });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const challengeResult = await new Promise<any>((resolve, reject) => {
    sdk.execute(challengeId, (err: unknown, result: unknown) => {
      if (err) {
        reject(new Error((err as Error)?.message ?? 'Transaction approval failed'));
        return;
      }
      resolve(result);
    });
  });

  if (challengeResult?.status === 'FAILED') {
    throw new Error(challengeResult?.data?.errorMessage ?? 'Transaction was not approved.');
  }

  onStatusChange?.('Confirming on-chain…');

  // Primary path: the challenge result carries the transaction id directly.
  // Undocumented exact field name for CONTRACT_EXECUTION, so try the
  // plausible candidates before falling back.
  const directId: string | undefined =
    challengeResult?.data?.id ?? challengeResult?.data?.transactionId ?? undefined;

  const MAX_POLLS     = 30;
  const POLL_INTERVAL = 3000;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    try {
      const url = directId
        ? `/api/circle/tx-status?transactionId=${encodeURIComponent(directId)}`
        : `/api/circle/tx-status?walletId=${encodeURIComponent(walletId)}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const status = await res.json() as { state?: string; txHash?: string };

      if (status.state === 'CONFIRMED' && status.txHash) {
        return status.txHash as `0x${string}`;
      }
      if (status.state === 'FAILED') {
        throw new Error('Transaction reverted on-chain. No funds moved — check the block explorer for the exact reason.');
      }
    } catch (err) {
      // A single failed poll (network blip) shouldn't abort the whole
      // wait — only a genuine FAILED transaction state (thrown above)
      // or exhausting MAX_POLLS should.
      if ((err as Error).message?.includes('reverted on-chain')) throw err;
    }
  }

  throw new Error('Transaction submitted but did not confirm within the monitoring window — check the block explorer before assuming it failed.');
}

// ── Message-signing challenge — used by useUniversalWrite's signMessage ───────
//
// Simpler than executeCircleTransactionChallenge above: a signature isn't
// an on-chain event, so there's nothing to poll for — Circle's own SDK
// sample code confirms the signature comes back directly as
// `result.data.signature` in the challenge callback.
interface MessageChallengeParams {
  challengeId:    string;
  userToken:      string;
  encryptionKey:  string;
  onStatusChange?: (msg: string) => void;
}

export async function executeCircleMessageSigningChallenge({
  challengeId,
  userToken,
  encryptionKey,
  onStatusChange,
}: MessageChallengeParams): Promise<string> {
  const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID ?? '';

  onStatusChange?.('Waiting for you to approve with your PIN…');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { W3SSdk } = await import('@circle-fin/w3s-pw-web-sdk') as any;
  const sdk = new W3SSdk({ appSettings: { appId } });
  sdk.setAuthentication({ userToken, encryptionKey });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await new Promise<any>((resolve, reject) => {
    sdk.execute(challengeId, (err: unknown, res: unknown) => {
      if (err) {
        reject(new Error((err as Error)?.message ?? 'Signature request failed'));
        return;
      }
      resolve(res);
    });
  });

  if (result?.status === 'FAILED') {
    throw new Error(result?.data?.errorMessage ?? 'Signature was not approved.');
  }

  const signature: string | undefined = result?.data?.signature;
  if (!signature) throw new Error('Circle did not return a signature.');
  return signature;
}

// ── Transaction-SIGNING challenge (not execution) ──────────────────────────────
//
// Pairs with /api/circle/sign-transaction-challenge — see that route's
// header for why this replaced the contractExecution-based approach.
// Returns the SIGNED raw transaction; the caller (useUniversalWrite)
// broadcasts it themselves via publicClient.sendRawTransaction(), same as
// any other pre-signed transaction.
interface SignTransactionChallengeParams {
  challengeId:    string;
  userToken:      string;
  encryptionKey:  string;
  onStatusChange?: (msg: string) => void;
}

export async function executeCircleSignTransactionChallenge({
  challengeId,
  userToken,
  encryptionKey,
  onStatusChange,
}: SignTransactionChallengeParams): Promise<`0x${string}`> {
  const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID ?? '';

  onStatusChange?.('Waiting for you to approve with your PIN…');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { W3SSdk } = await import('@circle-fin/w3s-pw-web-sdk') as any;
  const sdk = new W3SSdk({ appSettings: { appId } });
  sdk.setAuthentication({ userToken, encryptionKey });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await new Promise<any>((resolve, reject) => {
    sdk.execute(challengeId, (err: unknown, res: unknown) => {
      if (err) {
        reject(new Error((err as Error)?.message ?? 'Transaction approval failed'));
        return;
      }
      resolve(res);
    });
  });

  if (result?.status === 'FAILED') {
    throw new Error(result?.data?.errorMessage ?? 'Transaction was not approved.');
  }

  const signedTransaction: string | undefined = result?.data?.signedTransaction;
  if (!signedTransaction) throw new Error('Circle did not return a signed transaction.');

  // Defensive: EVM raw transactions are 0x-prefixed hex. This endpoint is
  // shared across EVM/SOL/NEAR (see user-wallet.ts's doc comment), so the
  // exact encoding for EVM specifically wasn't independently confirmed —
  // this normalises the one plausible variant (missing 0x prefix) rather
  // than silently passing through something sendRawTransaction would
  // reject with a confusing low-level error.
  return (signedTransaction.startsWith('0x') ? signedTransaction : `0x${signedTransaction}`) as `0x${string}`;
}
