/**
 * @file lib/contracts/decodeError.ts
 * CLIENT-SIDE.
 *
 * Turns a thrown error from a contract write/simulate call into a
 * friendly, specific message instead of raw viem/RPC text like
 * "execution reverted for an unknown reason". This only works if the
 * custom error is actually present in the ABI passed in — see
 * lib/contracts/abis.ts, which used to be missing most of these (that
 * was the real root cause of the premium-upgrade "unknown reason" bug:
 * viem can only decode a revert selector against errors it's been told
 * about).
 *
 * FRIENDLY_MESSAGES below is intentionally short — only the errors a
 * user-facing flow can realistically hit and where a plain-English
 * explanation genuinely helps (contract state, balance, permissions).
 * Anything else falls back to a de-camel-cased version of the real
 * error name, which is still far better than "unknown reason".
 */

import { BaseError, ContractFunctionRevertedError, type Abi } from 'viem';

const FRIENDLY_MESSAGES: Record<string, string> = {
  AlreadyDeployed:         'You already have a premium payroll contract deployed.',
  RegistryAlreadyExists:   'You already have a registry deployed for this account.',
  TransferFromFailed:      'The transfer failed — check that you have enough USDC and have approved spending.',
  TransferFailed:          'The transfer failed — the contract may not have enough funds.',
  ApproveFailed:           'Approving USDC spending failed. Please try again.',
  DeploymentFailed:        'Deployment failed on-chain. Please try again in a moment.',
  FailedDeployment:        'Deployment failed on-chain. Please try again in a moment.',
  NoFundsToWithdraw:       'There are no funds available to withdraw.',
  ZeroAddress:             'A required address was missing or invalid.',
  ZeroAmount:              'The amount must be greater than zero.',
  ArrayLengthMismatch:     'The recipients and amounts lists don\u2019t match up.',
  EmptyArray:              'At least one recipient is required.',
  BatchTooLarge:           'That batch has too many payments — please split it into smaller batches.',
  ETHNotAccepted:          'This contract doesn\u2019t accept direct native-token transfers.',
  NotAuthorised:           'You\u2019re not authorised to perform this action.',
  AlreadyAgent:            'That address is already an agent on this contract.',
  NotCurrentlyAgent:       'That address isn\u2019t currently an agent on this contract.',
  TokenAlreadySupported:   'That token is already supported.',
  TokenNotSupported:       'That token isn\u2019t supported by this contract.',
  FeeTooHigh:              'The requested fee is above the allowed maximum.',
};

function humanize(errorName: string): string {
  const spaced = errorName.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1) + '.';
}

/**
 * Best-effort decode of a contract revert. Accepts anything a viem call
 * (simulateContract/writeContract/estimateGas) or our own Circle API
 * fetch might throw — non-viem errors just pass their message through
 * unchanged.
 */
export function decodeContractError(err: unknown, abi?: Abi): string {
  if (err instanceof BaseError) {
    const revertError = err.walk(e => e instanceof ContractFunctionRevertedError);
    if (revertError instanceof ContractFunctionRevertedError) {
      const name = revertError.data?.errorName;
      if (name) {
        return FRIENDLY_MESSAGES[name] ?? humanize(name);
      }
    }
    // No decodable custom error — fall back to viem's own short message
    // rather than its full multi-line output (which includes the raw
    // "Version: viem@x.y.z" footer users have no use for).
    return err.shortMessage ?? err.message;
  }

  if (err instanceof Error) return err.message;
  return 'Something went wrong with this transaction. Please try again.';
}
