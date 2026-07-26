'use client';
/**
 * @file lib/circle/useCircleAdapter.ts
 *
 * Converts the wagmi connector client (EIP-1193 provider) into a Circle
 * AppKit viem adapter — the bridge between wagmi's wallet and AppKit's SDK.
 *
 * Pattern from official Circle + RainbowKit docs:
 *   useConnectorClient() → transport.value.provider → createAdapterFromProvider()
 *
 * Returns null when:
 *   - No external wallet is connected (wagmi isConnected = false)
 *   - Still mounting / SSR
 *   - Circle social login user (they use Circle UCW, not EIP-1193)
 *
 * For Circle social login users, swap and bridge fall back to a message
 *   telling them to use an external wallet for those operations, since
 *   UCW doesn't expose an EIP-1193 provider.
 */

import { useState, useEffect } from 'react';
import { useConnectorClient, useAccount } from 'wagmi';

export type CircleAdapter = Awaited<
  ReturnType<typeof import('@circle-fin/adapter-viem-v2').createAdapterFromProvider>
>;

export interface UseCircleAdapterResult {
  adapter:        CircleAdapter | null;
  loading:        boolean;
  error:          string | null;
  /** True when an external wallet is connected AND the adapter is ready */
  isAdapterReady: boolean;
}

/**
 * Extracts a raw EIP-1193 provider from whatever wagmi gives us.
 *
 * BUG FIX (previously the only strategy tried here): reaching into
 * `client.transport.value.provider` assumes viem's `custom()` transport
 * shape. That shape isn't guaranteed across wagmi/viem versions or across
 * different connector types (injected vs. WalletConnect vs. Coinbase), and
 * when it doesn't match, `provider` silently ends up `undefined` — with NO
 * error surfaced (the old code explicitly did `setError(null)` in that
 * branch). The result: `isAdapterReady` stays false forever and the Bridge
 * button never activates, with no visible explanation. That silent failure
 * is what was reported as "the bridge button just doesn't become active."
 *
 * Fix: prefer the public, documented wagmi API — `connector.getProvider()`
 * — which every wagmi connector implements regardless of internal client
 * shape. Fall back to the old transport-probing path only if that isn't
 * available, and otherwise report a real error instead of failing silently.
 */
async function extractProvider(
  client: unknown,
  connector: { getProvider?: () => Promise<unknown> } | undefined,
): Promise<any> {
  if (connector?.getProvider) {
    const p = await connector.getProvider();
    if (p) return p;
  }
  // Legacy fallback: some transport shapes (viem's `custom()` transport)
  // expose the provider at transport.value.provider.
  const fallback = (client as { transport?: { value?: { provider?: unknown } } })
    ?.transport?.value?.provider;
  return fallback ?? null;
}

export function useCircleAdapter(): UseCircleAdapterResult {
  const { data: client, isLoading: clientLoading } = useConnectorClient();
  const { connector, isConnected } = useAccount();
  const [adapter, setAdapter] = useState<CircleAdapter | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!isConnected) {
      setAdapter(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    extractProvider(client, connector)
      .then(provider => {
        if (cancelled) return null;
        if (!provider) {
          throw new Error('Could not access your wallet\u2019s connection. Try reconnecting your wallet.');
        }
        return import('@circle-fin/adapter-viem-v2').then(({ createAdapterFromProvider }) =>
          createAdapterFromProvider({ provider })
        );
      })
      .then(ad => {
        if (!cancelled && ad) { setAdapter(ad); setLoading(false); }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setAdapter(null);
          setError(
            err instanceof Error ? err.message : 'Failed to create wallet adapter'
          );
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [client, connector, isConnected]);

  return {
    adapter,
    loading:        loading || clientLoading,
    error,
    isAdapterReady: adapter !== null,
  };
}
