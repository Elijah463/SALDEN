import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import '@/styles/globals.css';
import { Web3Provider } from '@/components/shared/Web3Provider';
import { AppProvider }  from '@/context/AppContext';
import { SignatureExplainerProvider } from '@/context/SignatureExplainerContext';
import { Toasts }       from '@/components/shared/Toasts';
import { AppSplash }    from '@/components/shared/AppSplash';

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
        {/*
          Runs before any other script, including Web3Provider's module-
          level wagmi/RainbowKit config construction. Some restrictive
          in-app browsers and automated preview crawlers (confirmed: X's
          in-app browser: link opened from a Linktree/X post; Vercel's own
          deployment-preview screenshot bot) either omit `indexedDB`
          entirely or throw a SecurityError on first localStorage/
          sessionStorage touch, instead of just not having it. WalletConnect's
          storage layer (deep inside RainbowKit's default connector) calls
          these APIs unguarded, and previously crashed the ENTIRE app in
          these environments (it happens inside a root-layout provider, so
          it bypasses every route-level error boundary and lands in
          global-error.tsx, which is deliberately provider-free and can't
          help the user recover into the app).

          BUG FIX: the indexedDB branch below used to just set
          `window.indexedDB = undefined` when it was already undefined —
          a no-op that didn't stop later `indexedDB.open(...)` calls from
          still throwing. It now installs an actual minimal functional
          stub (async open/error lifecycle, matching the real API's
          contract) so calling code degrades gracefully instead of
          crashing. Combined with the error boundary now wrapping
          Web3Provider's own tree (see components/shared/Web3Provider.tsx),
          this closes the crash off at both the storage-API layer and the
          React-render layer.

          This has zero effect for the overwhelming majority of real users
          with a normal browser — indexedDB/localStorage/sessionStorage
          all already exist there, so every check below is a no-op.
        */}
        <Script id="storage-api-guard" strategy="beforeInteractive">
          {`
            (function() {
              // BUG FIX: this used to just do "window.indexedDB = undefined"
              // when indexedDB was missing — but it's already undefined at
              // that point (that's the condition that triggered the branch),
              // so that line changed nothing. Any later WalletConnect/
              // RainbowKit code calling indexedDB.open(...) still threw
              // "Cannot read properties of undefined", crashing the whole
              // app in exactly the restricted browsers (X's in-app browser,
              // Vercel's OG-image screenshot bot) this was meant to guard
              // against. Fix: install a minimal but real functional stub —
              // one that behaves like a real (empty, non-persistent)
              // IndexedDB so calling code gets the async open/error
              // lifecycle it expects instead of a hard crash.
              try {
                var needsIdbStub = (typeof window !== 'undefined') &&
                  (typeof window.indexedDB === 'undefined' || window.indexedDB === null);
                if (!needsIdbStub && typeof window !== 'undefined') {
                  // Exists by name, but some restricted contexts still throw
                  // the moment you actually call a method on it (rather than
                  // just referencing it) — verify it's really usable.
                  try { window.indexedDB.open('__salden_idb_test__'); }
                  catch (e) { needsIdbStub = true; }
                }
                if (needsIdbStub && typeof window !== 'undefined') {
                  function fakeRequest() {
                    var req = {
                      result: null, error: null,
                      onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null,
                      _listeners: {},
                      addEventListener: function(type, fn) {
                        this._listeners[type] = this._listeners[type] || [];
                        this._listeners[type].push(fn);
                      },
                      removeEventListener: function(type, fn) {
                        if (!this._listeners[type]) return;
                        this._listeners[type] = this._listeners[type].filter(function(f) { return f !== fn; });
                      },
                      _fire: function(type, evt) {
                        var handler = this['on' + type];
                        if (typeof handler === 'function') handler.call(this, evt);
                        (this._listeners[type] || []).forEach(function(fn) { fn.call(req, evt); });
                      },
                    };
                    return req;
                  }
                  window.indexedDB = {
                    open: function() {
                      var req = fakeRequest();
                      // Fire asynchronously, same contract as the real API —
                      // callers typically attach onsuccess/onerror right
                      // after calling open(), expecting them to fire later.
                      setTimeout(function() {
                        req.error = new Error('IndexedDB unavailable in this browser context');
                        req._fire('error', { target: req });
                      }, 0);
                      return req;
                    },
                    deleteDatabase: function() {
                      var req = fakeRequest();
                      setTimeout(function() { req._fire('success', { target: req }); }, 0);
                      return req;
                    },
                    databases: function() {
                      return Promise.resolve([]);
                    },
                  };
                }
              } catch (e) {}

              function shimStorage(name) {
                try {
                  var s = window[name];
                  var testKey = '__salden_storage_test__';
                  s.setItem(testKey, '1');
                  s.removeItem(testKey);
                } catch (e) {
                  try {
                    var memory = {};
                    Object.defineProperty(window, name, {
                      value: {
                        getItem: function(k) { return Object.prototype.hasOwnProperty.call(memory, k) ? memory[k] : null; },
                        setItem: function(k, v) { memory[k] = String(v); },
                        removeItem: function(k) { delete memory[k]; },
                        clear: function() { memory = {}; },
                        key: function(i) { return Object.keys(memory)[i] || null; },
                        get length() { return Object.keys(memory).length; }
                      },
                      configurable: true,
                      writable: true
                    });
                  } catch (e2) {}
                }
              }
              if (typeof window !== 'undefined') {
                shimStorage('localStorage');
                shimStorage('sessionStorage');
              }
            })();
          `}
        </Script>
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
            <SignatureExplainerProvider>
              <AppSplash>
                {children}
              </AppSplash>
              <Toasts />
            </SignatureExplainerProvider>
          </AppProvider>
        </Web3Provider>
      </body>
    </html>
  );
}
