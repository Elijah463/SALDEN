'use client';
/**
 * @file lib/circle/useUniversalWrite.ts
 * CLIENT-SIDE.
 *
 * The single abstraction every on-chain WRITE call site should use
 * instead of calling wagmi's walletClient.writeContract() directly.
 * Branches on the user's real login method:
 *
 *   - 'external' → wagmi's walletClient.writeContract(), plus a
 *     publicClient.simulateContract() preflight (see decodeContractError
 *     import below) so a revert shows its real, decoded reason instead
 *     of raw viem/RPC text, and so the wallet never even pops up a
 *     signature request for a call that's guaranteed to fail.
 *   - 'circle'   → Circle's user-controlled wallets now support
 *     /user/transactions/contractExecution directly, now that Arc
 *     Testnet wallets are created under Circle's real `ARC-TESTNET`
 *     chain code (see lib/circle/user-wallet.ts's initializeUserWallet
 *     doc comment for the full history — this used to be blocked by a
 *     wrong chain classification, not an actual Circle limitation).
 *     Circle handles simulation, gas estimation, signing and
 *     broadcasting server-side — this hook just creates the challenge
 *     (POST /api/circle/contract-execution-challenge) and hands it to
 *     the Circle Web SDK for the user's PIN
 *     (executeCircleTransactionChallenge), then polls for the on-chain
 *     result the same way the external-wallet path waits for a receipt.
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
 *   2. Does the simulateContract preflight throw (external) / does
 *      Circle's own contractExecution call reject synchronously
 *      (circle)? → the call would genuinely revert — check
 *      decodeContractError()'s output / the API error message, both are
 *      now decoded against the real contract ABI (see
 *      lib/contracts/abis.ts and lib/contracts/decodeError.ts).
 *   3. Does POST /api/circle/contract-execution-challenge fail? →
 *      problem in lib/circle/user-wallet.ts (session/challenge creation)
 *      or lib/circle/entitySecret.ts (encryption) — test that route
 *      alone.
 *   4. Does the SDK challenge itself error? → problem in the
 *      challengeId/userToken/encryptionKey handoff, or the user
 *      declining/failing their PIN.
 *   5. Does the transaction stay QUEUED/SENT and never resolve? →
 *      check executeCircleTransactionChallenge's polling loop in
 *      executeChallenge.ts and /api/circle/tx-status.
 */

import { useCallback } from 'react';
import { useWalletClient, usePublicClient } from 'wagmi';
import { encodeFunctionData, type Abi } from 'viem';
import { useEffectiveAddress } from '@/lib/useEffectiveAddress';
import { arcTestnet } from '@/lib/contracts/config';
import { decodeContractError } from '@/lib/contracts/decodeError';
import {
  executeCircleMessageSigningChallenge,
  executeCircleTransactionChallenge,
} from '@/lib/circle/executeChallenge';

export interface UniversalWriteParams {
  address:       `0x${string}`;
  abi:           Abi;
  functionName:  string;
  args?:         readonly unknown[];
  /** Native-token value to send with the call, in wei. Rare in this app
   *  (no current write flow sends native value) — included for
   *  completeness. */
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
   *  change their error handling. Errors are decoded against the real
   *  contract ABI where possible (see lib/contracts/decodeError.ts) —
   *  callers get `AlreadyDeployed`-style messages, not raw revert data. */
  writeContract: (params: UniversalWriteParams, onStatusChange?: (msg: string) => void) => Promise<`0x${string}`>;
  /** Sends a pre-built raw transaction (to/data/value already encoded by
   *  the caller — e.g. LI.FI's quote.transactionRequest) instead of an
   *  ABI+functionName+args writeContract needs to encode itself. Same
   *  wallet branching as writeContract underneath — no ABI decoding here
   *  since there's no ABI to decode against. */
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
  const { data: walletClient } = useWalletClient({ chainId: arcTestnet.id });
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  const canWrite =
    loginMethod === 'external' ? !!walletClient :
    loginMethod === 'circle'   ? !!email :
    false;

  // Circle contractExecution path — shared by writeContract and
  // sendTransaction's 'circle' branches. Takes already-ABI-encoded
  // calldata (callData) rather than re-deriving Circle's
  // abiFunctionSignature format — see the API route's doc comment for
  // why. Circle handles simulation/gas/signing/broadcast; this just
  // creates the challenge, runs it through the user's PIN, and polls for
  // the resulting on-chain status.
  const executeContractCallViaCircle = useCallback(async (
    to: `0x${string}`, data: `0x${string}`, value: bigint | undefined,
    onStatusChange?: (msg: string) => void,
  ): Promise<`0x${string}`> => {
    if (!email) throw new Error('Not logged in.');

    onStatusChange?.('Preparing transaction…');

    const res = await fetch('/api/circle/contract-execution-challenge', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        contractAddress: to,
        callData:        data,
        value:           value ? value.toString() : undefined,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? 'Could not prepare transaction.');
    }

    const { challengeId, userToken, encryptionKey, walletId } = await res.json();
    return executeCircleTransactionChallenge({
      challengeId, userToken, encryptionKey, walletId, onStatusChange,
    });
  }, [email]);

  const writeContract = useCallback(async (
    params: UniversalWriteParams,
    onStatusChange?: (msg: string) => void,
  ): Promise<`0x${string}`> => {
    if (loginMethod === 'external') {
      if (!walletClient) throw new Error('Wallet not connected.');
      if (!address) throw new Error('No wallet address available.');

      // Preflight simulate so a revert shows its real decoded reason
      // (AlreadyDeployed, TransferFromFailed, etc. — see
      // lib/contracts/decodeError.ts) instead of raw viem/RPC text, and
      // so the wallet never prompts for a signature on a call that's
      // guaranteed to fail.
      if (publicClient) {
        try {
          await publicClient.simulateContract({
            address: params.address, abi: params.abi,
            functionName: params.functionName, args: params.args,
            account: address as `0x${string}`, value: params.value,
          });
        } catch (simErr) {
          throw new Error(decodeContractError(simErr, params.abi));
        }
      }

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
      try {
        return await executeContractCallViaCircle(params.address, callData, params.value, onStatusChange);
      } catch (err) {
        throw new Error(decodeContractError(err, params.abi));
      }
    }

    throw new Error('Not logged in.');
  }, [loginMethod, walletClient, address, publicClient, executeContractCallViaCircle]);

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
      return executeContractCallViaCircle(params.to, params.data, value, onStatusChange);
    }

    throw new Error('Not logged in.');
  }, [loginMethod, walletClient, address, executeContractCallViaCircle]);

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
