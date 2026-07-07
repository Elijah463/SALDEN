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
