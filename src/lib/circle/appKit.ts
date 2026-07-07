/**
 * @file lib/circle/appKit.ts
 * Singleton Circle AppKit instance.
 *
 * INSTALL before deploying:
 *   npm install @circle-fin/app-kit @circle-fin/adapter-viem-v2
 *
 * This is a SERVER + CLIENT safe module — AppKit itself is stateless.
 * Import this wherever kit.swap() or kit.bridge() is needed.
 */

let _kit: import('@circle-fin/app-kit').AppKit | null = null;
// Caches the IN-FLIGHT construction, not just the resolved instance. Without
// this, two concurrent callers arriving before the first `await import(...)`
// resolves would both see `_kit === null` and each construct their own
// AppKit() — the second to finish silently overwrites the module-level
// singleton, and the two callers end up holding genuinely different
// instances instead of sharing one.
let _kitPromise: Promise<import('@circle-fin/app-kit').AppKit> | null = null;

export async function getAppKit(): Promise<import('@circle-fin/app-kit').AppKit> {
  if (_kit) return _kit;
  if (_kitPromise) return _kitPromise;

  _kitPromise = (async () => {
    const { AppKit } = await import('@circle-fin/app-kit');
    _kit = new AppKit();
    return _kit;
  })();

  try {
    return await _kitPromise;
  } finally {
    _kitPromise = null;
  }
}
