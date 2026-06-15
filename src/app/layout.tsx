import type { Metadata, Viewport } from 'next';
import '@/styles/globals.css';
import { Web3Provider } from '@/components/shared/Web3Provider';
import { AppProvider } from '@/context/AppContext';
import { Toasts } from '@/components/shared/Toasts';
import { Analytics } from '@vercel/analytics/next';

// ── Base URL ───────────────────────────────────────────────────────────────────
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.salden.xyz';

// ── Viewport (theme colour lives here in Next.js 14) ──────────────────────────
export const viewport: Viewport = {
  themeColor:        '#4F46E5',
  colorScheme:       'light',
  width:             'device-width',
  initialScale:      1,
  maximumScale:      1,
};

// ── Full metadata with OG + Twitter card ──────────────────────────────────────
export const metadata: Metadata = {
  // ── Core ──────────────────────────────────────────────────────────────────
  metadataBase:  new URL(APP_URL),
  title: {
    default:  'Salden — Smart Payroll For Teams of Any Size',
    template: '%s — Salden',
  },
  description:
    'On-chain payroll for teams of any size. Batch USDC payments, AI-powered scheduling, compliance screening, and encrypted employee records — all on Arc Testnet.',
  keywords: [
    'Onchain payroll', 'crypto payroll', 'USDC payroll', 'web3 payroll',
    'blockchain payroll', 'Arc Testnet', 'smart contract payroll',
    'AI payroll agent', 'Salden',
  ],
  authors:  [{ name: 'Salden', url: 'https://salden.xyz' }],
  creator:  'Salden',
  publisher: 'Salden',
  robots: {
    index:          true,
    follow:         true,
    googleBot: {
      index:             true,
      follow:            true,
      'max-image-preview': 'large',
    },
  },

  // ── Icons ──────────────────────────────────────────────────────────────────
  icons: {
    icon: [
      { url: '/favicon.ico',  sizes: '16x16 32x32 48x48', type: 'image/x-icon' },
      { url: '/logo.svg',     sizes: 'any',                type: 'image/svg+xml' },
    ],
    apple:    [{ url: '/logo.svg', sizes: 'any', type: 'image/svg+xml' }],
    shortcut: [{ url: '/favicon.ico' }],
    other: [
      { rel: 'mask-icon', url: '/logo.svg', color: '#4F46E5' },
    ],
  },

  // ── Manifest ───────────────────────────────────────────────────────────────
  manifest: '/manifest.json',

  // ── Open Graph (social link previews) ─────────────────────────────────────
  openGraph: {
    type:        'website',
    url:          APP_URL,
    siteName:    'Salden',
    title:       'Salden — Smart Payroll For Teams of Any Size',
    description:
      'On-chain payroll for teams of any size. Batch USDC payments, AI-powered scheduling, and compliance — all on Arc Testnet.',
    images: [
      {
        url:    '/images/og-image.jpg',
        width:   1512,
        height:  756,
        alt:    'Salden — Smart Payroll For Teams of Any Size',
        type:   'image/jpeg',
      },
    ],
    locale: 'en_US',
  },

  // ── Twitter / X card ──────────────────────────────────────────────────────
  twitter: {
    card:        'summary_large_image',
    site:        '@salden_xyz',
    creator:     '@salden_xyz',
    title:       'Salden — Smart Payroll For Teams of Any Size',
    description:
      'On-chain payroll for teams of any size. Batch USDC payments, AI-powered scheduling, and compliance — all on Arc Testnet.',
    images:      ['/images/og-image.jpg'],
  },

  // ── Misc ───────────────────────────────────────────────────────────────────
  applicationName: 'Salden',
  referrer:        'origin-when-cross-origin',
  category:        'finance',
  other: {
    'msapplication-TileColor':  '#4F46E5',
    'msapplication-config':     '/browserconfig.xml',
    'msapplication-TileImage':  '/logo.svg',
  },
};

// ── Root layout ────────────────────────────────────────────────────────────────
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Google Fonts */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        {/* Explicit Safari pinned-tab SVG */}
        <link rel="mask-icon" href="/favicon.svg" color="#4F46E5" />
      </head>
      <body>
        <Web3Provider>
          <AppProvider>
            {children}
            <Toasts />
          </AppProvider>
        </Web3Provider>
        <Analytics />
      </body>
    </html>
  );
}
