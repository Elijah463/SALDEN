'use client';
/**
 * @file lib/circle/useUniversalWrite.ts
 * CLIENT-SIDE.
 *
 * The single abstraction every on-chain WRITE call site should use
 * instead of calling wagmi's walletClient.writeContract() directly.
 * Branches on the user's real login method:
 *
 *   - 'external' → wagmi's walletClient.writeContract(), unchanged from
 *     before. Nothing about the external-wallet path changes.
 *   - 'circle'   → Circle's user-controlled wallets do NOT support
 *     /user/transactions/contractExecution for Arc's chain category
 *     ("Other EVM blockchains" — confirmed against Circle's own docs,
 *     which explicitly say contract execution isn't supported there,
 *     only signing). So this constructs the raw transaction itself
 *     (nonce/gas/fees via publicClient — the same inputs wagmi would
 *     need anyway), gets it SIGNED via a Circle challenge
 *     (POST /api/circle/sign-transaction-challenge →
 *     executeCircleSignTransactionChallenge, prompts the user's PIN),
 *     and broadcasts the signed result itself via
 *     publicClient.sendRawTransaction().
 *
 * Deliberately NOT wired into Swap — see app/wallet/swap/page.tsx's own
 * external-wallet notice; Circle's Swap adapter needs a standard EIP-1193
 * provider, which a Circle social-login session doesn't expose (see that
 * file's comments for the fuller reasoning). Every other on-chain write
 * in the app — registry/payroll deployment, batchPay, send, agent
 * confirmations — should route through this hook.
 *
 * Debugging a failure: each layer below is independently checkable.
 *   1. Is `canWrite` false? → loginMethod/email/walletClient problem,
 *      check useEffectiveAddress().
 *   2. Does nonce/fee/gas estimation throw? → a publicClient RPC problem,
 *      unrelated to Circle — same as any wagmi read would hit.
 *   3. Does POST /api/circle/sign-transaction-challenge fail? → problem
 *      in lib/circle/user-wallet.ts (session/challenge creation) or
 *      lib/circle/entitySecret.ts (encryption) — test that route alone.
 *   4. Does the SDK challenge itself error? → problem in the challengeId/
 *      userToken/encryptionKey handoff, or the user declining/failing
 *      their PIN — check executeCircleSignTransactionChallenge's own
 *      error.
 *   5. Does sendRawTransaction reject the signed tx? → check
 *      executeCircleSignTransactionChallenge's 0x-prefix normalisation
 *      note; Circle's exact EVM encoding for `signedTransaction` wasn't
 *      independently confirmed against a live EVM-chain response.
 */

import { useCallback } from 'react';
import { useWalletClient, usePublicClient } from 'wagmi';
import { encodeFunctionData, type Abi } from 'viem';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { arcTestnet } from '@/lib/contracts/config';
import {
  executeCircleMessageSigningChallenge,
  executeCircleSignTransactionChallenge,
} from '@/lib/circle/executeChallenge';

export interface UniversalWriteParams {
  address:       `0x${string}`;
  abi:           Abi;
  functionName:  string;
  args?:         readonly unknown[];
  /** Native-token value to send with the call, in wei. Rare in this app
   *  (no current write flow sends native value) — included for
   *  completeness, converted to a decimal string for Circle since their
   *  API expects a human-decimal amount, not wei. */
  value?:        bigint;
}

export interface UniversalSendTransactionParams {
  to:    `0x${string}`;
  data:  `0x${string}`;
  /** wei, as a string (LI.FI's transactionRequest.value is already a hex
   *  or decimal string) or bigint. */
  value?: bigint | string;
}

export interface UniversalWriteResult {
  /** Performs the write. Throws on failure — same contract as wagmi's
   *  writeContract, so existing try/catch call sites don't need to
   *  change their error handling. */
  writeContract: (params: UniversalWriteParams, onStatusChange?: (msg: string) => void) => Promise<`0x${string}`>;
  /** Sends a pre-built raw transaction (to/data/value already encoded by
   *  the caller — e.g. LI.FI's quote.transactionRequest) instead of an
   *  ABI+functionName+args writeContract needs to encode itself. Same
   *  wallet branching as writeContract underneath. */
  sendTransaction: (params: UniversalSendTransactionParams, onStatusChange?: (msg: string) => void) => Promise<`0x${string}`>;
  /** Signs a plain message. Same branch logic as writeContract — wagmi
   *  for external wallets, a Circle SIGN_MESSAGE challenge for social
   *  login. Needed by flows that derive a signature-based key rather
   *  than sending a transaction (e.g. lib/usePayrollSync.ts). */
  signMessage: (message: string, onStatusChange?: (msg: string) => void) => Promise<string>;
  /** Whether a write is even possible right now — use this instead of
   *  the old `!walletClient` check, which was always true (and
   *  therefore always blocked) for social-login users. */
  canWrite: boolean;
  loginMethod: 'external' | 'circle' | null;
}

export function useUniversalWrite(): UniversalWriteResult {
  const { loginMethod, email, address } = useEffectiveAddress();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  const canWrite =
    loginMethod === 'external' ? !!walletClient :
    loginMethod === 'circle'   ? !!email :
    false;

  // Shared by writeContract and sendTransaction's Circle branches — see
  // this file's top-level docstring for the full reasoning. Circle's
  // user-controlled wallets don't support contractExecution for Arc's
  // chain category, only signing, so this constructs the transaction
  // itself (same inputs wagmi/viem would need anyway), gets it SIGNED via
  // a Circle challenge, and broadcasts the signed result itself.
  const signAndBroadcastCircleTx = useCallback(async (
    to: `0x${string}`, data: `0x${string}`, value: bigint | undefined,
    onStatusChange?: (msg: string) => void,
  ): Promise<`0x${string}`> => {
    if (!email) throw new Error('Not logged in.');
    if (!address) throw new Error('No wallet address available.');
    if (!publicClient) throw new Error('No RPC connection available.');

    onStatusChange?.('Preparing transaction…');

    const [nonce, feesPerGas, gas] = await Promise.all([
      publicClient.getTransactionCount({ address: address as `0x${string}`, blockTag: 'pending' }),
      publicClient.estimateFeesPerGas(),
      publicClient.estimateGas({ account: address as `0x${string}`, to, data, value }),
    ]);

    const maxFeePerGas = feesPerGas.maxFeePerGas ?? feesPerGas.gasPrice;
    const maxPriorityFeePerGas = feesPerGas.maxPriorityFeePerGas ?? feesPerGas.gasPrice;
    if (!maxFeePerGas || !maxPriorityFeePerGas) {
      throw new Error('Could not estimate network fees for this transaction.');
    }

    const res = await fetch('/api/circle/sign-transaction-challenge', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        transaction: {
          to, data,
          value:                value ? value.toString() : undefined,
          gas:                  gas.toString(),
          maxFeePerGas:         maxFeePerGas.toString(),
          maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
          nonce,
          chainId: arcTestnet.id,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? 'Could not prepare transaction for signing.');
    }

    const { challengeId, userToken, encryptionKey } = await res.json();
    const signedTx = await executeCircleSignTransactionChallenge({ challengeId, userToken, encryptionKey, onStatusChange });

    onStatusChange?.('Broadcasting transaction…');
    return publicClient.sendRawTransaction({ serializedTransaction: signedTx });
  }, [email, address, publicClient]);

  const writeContract = useCallback(async (
    params: UniversalWriteParams,
    onStatusChange?: (msg: string) => void,
  ): Promise<`0x${string}`> => {
    if (loginMethod === 'external') {
      if (!walletClient) throw new Error('Wallet not connected.');
      onStatusChange?.('Waiting for signature…');
      return walletClient.writeContract({
        address: params.address, abi: params.abi,
        functionName: params.functionName, args: params.args, value: params.value,
      });
    }

    if (loginMethod === 'circle') {
      const callData = encodeFunctionData({
        abi: params.abi, functionName: params.functionName, args: params.args,
      });
      return signAndBroadcastCircleTx(params.address, callData, params.value, onStatusChange);
    }

    throw new Error('Not logged in.');
  }, [loginMethod, walletClient, signAndBroadcastCircleTx]);

  const sendTransaction = useCallback(async (
    params: UniversalSendTransactionParams,
    onStatusChange?: (msg: string) => void,
  ): Promise<`0x${string}`> => {
    const value = params.value === undefined ? undefined
      : typeof params.value === 'bigint' ? params.value
      : BigInt(params.value);

    if (loginMethod === 'external') {
      if (!walletClient) throw new Error('Wallet not connected.');
      if (!address) throw new Error('No wallet address available.');
      onStatusChange?.('Waiting for signature…');
      return walletClient.sendTransaction({
        account: address as `0x${string}`, to: params.to, data: params.data, value,
      });
    }

    if (loginMethod === 'circle') {
      return signAndBroadcastCircleTx(params.to, params.data, value, onStatusChange);
    }

    throw new Error('Not logged in.');
  }, [loginMethod, walletClient, address, signAndBroadcastCircleTx]);

  const signMessage = useCallback(async (
    message: string,
    onStatusChange?: (msg: string) => void,
  ): Promise<string> => {
    if (loginMethod === 'external') {
      if (!walletClient) throw new Error('Wallet not connected.');
      onStatusChange?.('Waiting for signature…');
      return walletClient.signMessage({ message });
    }

    if (loginMethod === 'circle') {
      if (!email) throw new Error('Not logged in.');

      onStatusChange?.('Preparing signature request…');
      const res = await fetch('/api/circle/sign-message-challenge', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, message }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? 'Could not prepare message for signing.');
      }

      const { challengeId, userToken, encryptionKey } = await res.json();
      return executeCircleMessageSigningChallenge({ challengeId, userToken, encryptionKey, onStatusChange });
    }

    throw new Error('Not logged in.');
  }, [loginMethod, walletClient, email]);

  return { writeContract, sendTransaction, signMessage, canWrite, loginMethod };
}
