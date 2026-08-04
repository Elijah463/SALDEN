/**
 * @file lib/errorMessage.ts
 *
 * Turns a thrown error into a short, human-readable message instead of
 * whatever raw text the error happened to carry. The concrete problem this
 * fixes: viem's BaseError (thrown by every writeContract/simulateContract
 * call — which is most of this app's on-chain actions) has a `.message`
 * that is a multi-paragraph dump — the short summary, then "Raw Call
 * Arguments", the full contract call details, a docs link, and a version
 * string — while its `.shortMessage` is exactly the one-line human summary
 * meant to be shown to a person. Several places in this app were showing
 * `.message` directly, which is exactly the "long error" instead of a
 * simple message that gets reported. Also normalizes genuine browser-level
 * network failures ("Failed to fetch", "Load failed", etc.) to one
 * consistent short wording, since those vary by browser but all mean the
 * same thing to a user.
 *
 * Usage: `friendlyErrorMessage(err, 'Some action failed. Please try again.')`
 * — the fallback is only used when nothing usable could be extracted from
 * `err` at all (e.g. someone threw a non-Error value).
 */

const MAX_DISPLAY_LEN = 160;

const NETWORK_ERROR_PATTERN =
  /failed to fetch|network\s?error|load failed|err_internet_disconnected|err_connection|err_name_not_resolved/i;

export function friendlyErrorMessage(err: unknown, fallback: string): string {
  // viem's BaseError (and everything that extends it —
  // ContractFunctionExecutionError, TransactionExecutionError,
  // ContractFunctionRevertedError, etc.) — duck-typed rather than
  // `instanceof BaseError` so this works without importing viem here, and
  // matches regardless of exactly which viem error subclass was thrown.
  if (err && typeof err === 'object') {
    const shortMessage = (err as { shortMessage?: unknown }).shortMessage;
    if (typeof shortMessage === 'string' && shortMessage.trim()) {
      return shortMessage.trim();
    }
  }

  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!raw) return fallback;

  if (NETWORK_ERROR_PATTERN.test(raw)) {
    return 'Network error — please check your connection and try again.';
  }

  // Take just the first line — a multi-line raw error is virtually always
  // some library's own verbose dump (viem without a shortMessage, a raw
  // RPC error, etc.), and the first line is consistently the actual
  // one-sentence summary across the ones this app encounters.
  const firstLine = raw.split('\n')[0].trim();
  if (!firstLine) return fallback;

  return firstLine.length > MAX_DISPLAY_LEN
    ? `${firstLine.slice(0, MAX_DISPLAY_LEN).trim()}…`
    : firstLine;
}
