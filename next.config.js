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
  webpack: (config) => {
    // Required for wagmi/viem and WalletConnect
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    // Suppress critical dependency warnings from WalletConnect
    config.resolve.fallback = { fs: false, net: false, tls: false };
    // Suppress MetaMask SDK React Native peer dep warning
    config.resolve.alias = {
      ...config.resolve.alias,
      '@react-native-async-storage/async-storage': false,
    };
    return config;
  },
};

module.exports = nextConfig;
