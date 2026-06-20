'use client';
/**
 * @file components/shared/Web3Provider.tsx
 * RainbowKit + Wagmi provider configuration for Arc Testnet.
 * Circle Programmable Wallets handles social login + custodial wallets.
 */

import { ReactNode, useState } from 'react';
import { WagmiProvider, http } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, getDefaultConfig, lightTheme } from '@rainbow-me/rainbowkit';
import { arcTestnet } from '@/lib/contracts/config';

import '@rainbow-me/rainbowkit/styles.css';

export const wagmiConfig = getDefaultConfig({
  appName: 'Salden Payroll',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '',
  chains: [arcTestnet],
  transports: {
    [arcTestnet.id]: http(arcTestnet.rpcUrls.default.http[0]),
  },
  ssr: true,
});

const rainbowTheme = lightTheme({
  accentColor: '#14B8A6',
  accentColorForeground: 'white',
  borderRadius: 'medium',
  fontStack: 'system',
});

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
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={rainbowTheme} modalSize="compact">
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
