/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@circle-fin/w3s-pw-web-sdk'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'ipfs.io'             },
      { protocol: 'https', hostname: 'gateway.pinata.cloud' },
    ],
  },
  webpack: (config, { isServer, webpack }) => {
    // Required for wagmi/viem and WalletConnect
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    // Suppress critical dependency warnings from WalletConnect
    config.resolve.fallback = { fs: false, net: false, tls: false };
    // Suppress MetaMask SDK React Native peer dep warning
    config.resolve.alias = {
      ...config.resolve.alias,
      '@react-native-async-storage/async-storage': false,
    };

    // WalletConnect's storage layer (pulled in transitively by the
    // WalletConnect connector RainbowKit's getDefaultConfig() sets up —
    // see components/shared/Web3Provider.tsx, wrapped around every page
    // via the root layout) references the browser-only `indexedDB`
    // global directly, with no `typeof` guard. That's fine in the actual
    // browser bundle, but Next also evaluates this same module server-
    // side during static generation (Node has no `indexedDB` at all),
    // which threw "ReferenceError: indexedDB is not defined" for pages
    // prerendered that way. DefinePlugin substitutes the bare identifier
    // with the literal `undefined` at build time — only in the SERVER
    // bundle — so the reference resolves instead of throwing there. The
    // client bundle is untouched and still has the real browser
    // indexedDB. (Our own src/lib/db/indexeddb.ts is unaffected either
    // way — it only ever accesses `window.indexedDB`, a property lookup
    // on `window`, never this bare identifier.)
    if (isServer) {
      config.plugins.push(
        new webpack.DefinePlugin({ indexedDB: 'undefined' }),
      );
    }

    return config;
  },
};

module.exports = nextConfig;
