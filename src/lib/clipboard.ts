/**
 * @file lib/clipboard.ts
 * CLIENT-SIDE.
 *
 * Every "copy" button in this app was calling `navigator.clipboard?.writeText(x)`
 * directly and then unconditionally showing "Copied!" — the optional
 * chaining means that if `navigator.clipboard` doesn't exist (denied by a
 * Permissions-Policy, or simply unavailable — both common in embedded
 * in-app browser webviews, which is exactly the context screenshots of
 * this app show it running in) the call silently does nothing, but the
 * UI still claims success. This wraps the copy with the classic
 * `document.execCommand('copy')` fallback (broader webview compatibility
 * than the async Clipboard API) and returns whether it actually worked,
 * so the UI can tell the truth.
 */

export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy fallback below — some webviews expose
      // navigator.clipboard but still reject the actual write (permission
      // denied at call-time rather than at feature-detection time).
    }
  }

  // Legacy fallback: works in far more embedded/webview contexts.
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    // Keep it out of the visible viewport/flow without display:none
    // (some browsers won't let you select() a display:none element).
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
