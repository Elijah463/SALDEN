'use client';
/**
 * @file components/shared/Web3Provider.tsx
 * RainbowKit + Wagmi provider configuration for Arc Testnet.
 * Circle Programmable Wallets handles social login + custodial wallets.
 *
 * BUG FIX — "Something went wrong" crash for link previews (X's in-app
 * browser, Vercel's OG-image screenshot bot):
 *
 * WalletConnect's SDK (used internally by RainbowKit's getDefaultConfig)
 * is well documented to throw hard during initialization in sandboxed or
 * privacy-restricted browser contexts — most commonly when `indexedDB` is
 * blocked or unavailable, which is exactly how many in-app browsers
 * (including X/Twitter's) and headless screenshot/crawler tools behave.
 * A normal desktop/mobile browser with standard storage permissions never
 * hits this; that's why it "works in normal browsers" but not for a link
 * preview. Two changes close this off:
 *
 *   1. getDefaultConfig() now runs inside a try/catch with a minimal
 *      fallback config (no WalletConnect connector) instead of letting a
 *      throw here take down the entire module — this ran at import time,
 *      so an uncaught throw here previously crashed EVERY page, not just
 *      wallet-related ones.
 *   2. A local error boundary now wraps the wagmi/RainbowKit tree, so if
 *      something inside it still throws during render (rather than at
 *      config-creation time), the rest of the app doesn't get replaced by
 *      the global crash screen — just a small, honest inline notice.
 */

import { ReactNode, useState, Component, type ErrorInfo } from 'react';
import { WagmiProvider, http, createConfig } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, getDefaultConfig, lightTheme } from '@rainbow-me/rainbowkit';
import { arcTestnet } from '@/lib/contracts/config';

import '@rainbow-me/rainbowkit/styles.css';

function buildWagmiConfig() {
  try {
    return getDefaultConfig({
      appName: 'Salden Payroll',
      projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '',
      chains: [arcTestnet],
      transports: {
        [arcTestnet.id]: http(arcTestnet.rpcUrls.default.http[0]),
      },
      ssr: true,
    });
  } catch (err) {
    // Fallback: a bare wagmi config with no WalletConnect connector at
    // all. External-wallet connect via the normal UI won't work in
    // whatever restricted environment triggered this, but the rest of
    // the app (and, critically, social-login/Circle flows, which don't
    // depend on this config at all) still renders instead of crashing.
    console.error('[Web3Provider] getDefaultConfig failed, using minimal fallback config:', err);
    return createConfig({
      chains: [arcTestnet],
      transports: { [arcTestnet.id]: http(arcTestnet.rpcUrls.default.http[0]) },
      ssr: true,
    });
  }
}

export const wagmiConfig = buildWagmiConfig();

const rainbowTheme = lightTheme({
  accentColor: '#14B8A6',
  accentColorForeground: 'white',
  borderRadius: 'medium',
  fontStack: 'system',
});

class Web3ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Web3ErrorBoundary]', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', padding: 24,
          textAlign: 'center', fontFamily: 'system-ui, sans-serif',
        }}>
          <p style={{ fontSize: 14, color: '#64748B', maxWidth: 380 }}>
            Wallet connectivity couldn&apos;t load in this browser. Try opening
            this link in Chrome, Safari, or another standard browser.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

export function Web3Provider({ children }: { children: ReactNode }) {
  // useState ensures one QueryClient per component instance,
  // preventing cache from being shared across server renders
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime:  60 * 1000,   // 1 minute
        retry:      1,
        refetchOnWindowFocus: false,
      },
    },
  }));
  return (
    <Web3ErrorBoundary>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider theme={rainbowTheme} modalSize="compact">
            {children}
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </Web3ErrorBoundary>
  );
}
