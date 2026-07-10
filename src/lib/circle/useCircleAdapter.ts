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
import { useConnectorClient }  from 'wagmi';

/**
 * Minimal EIP-1193 provider shape required by
 * @circle-fin/adapter-viem-v2's createAdapterFromProvider.
 * Matches exactly what the TS build error required: on, removeListener, request.
 */
interface EIP1193ProviderLike {
  request:        (...args: any[]) => Promise<unknown>;
  on:             (...args: any[]) => void;
  removeListener: (...args: any[]) => void;
}

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

export function useCircleAdapter(): UseCircleAdapterResult {
  const { data: client, isLoading: clientLoading } = useConnectorClient();
  const [adapter, setAdapter] = useState<CircleAdapter | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    // Extract EIP-1193 provider from wagmi connector transport
    const provider = (client as { transport?: { value?: { provider?: EIP1193ProviderLike } } })
      ?.transport?.value?.provider;

    if (!provider) {
      setAdapter(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    import('@circle-fin/adapter-viem-v2')
      .then(({ createAdapterFromProvider }) =>
        createAdapterFromProvider({ provider })
      )
      .then(ad => {
        if (!cancelled) { setAdapter(ad); setLoading(false); }
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
  }, [client]);

  return {
    adapter,
    loading:        loading || clientLoading,
    error,
    isAdapterReady: adapter !== null,
  };
}
