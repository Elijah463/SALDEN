# Salden — Smart Onchain Payroll

> Premium payroll infrastructure built on Arc Testnet. Batch payments, AI automation, encrypted employee records, and built-in compliance — in one platform.

[![Deployed on Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-black?logo=vercel)](https://app.salden.xyz)
[![Network](https://img.shields.io/badge/Network-Arc%20Testnet-4F46E5)](https://testnet.arcscan.app)
[![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=nextdotjs)](https://nextjs.org)
[![License](https://img.shields.io/badge/License-MIT-green)](./LICENSE)

---

## Overview

Salden replaces traditional payroll infrastructure with smart contracts. Employers pay any number of employees in USDC or any ERC-20 token in a single Onchain transaction. Employee records are AES-GCM encrypted and stored on IPFS. An AI Agent powered by Gemini 2.5 Flash handles recurring payroll, compliance screening, and scheduling autonomously.

---

## Features

| Feature | Free | Premium |
|---|---|---|
| Onchain batch payroll (USDC) | Up to 100 employees | Up to 1,000 employees |
| Encrypted IPFS employee registry | ✓ | ✓ |
| Group management | ✓ | ✓ |
| Compliance dashboard | ✓ | ✓ |
| Transaction history + invoice emails | ✓ | ✓ |
| Private payroll contract | | ✓ |
| Multi-token support (any ERC-20) | | ✓ |
| AI Agent with scheduling | | ✓ |
| Emergency withdrawal | | ✓ |
| Cost | Free | $10 USDC one-time |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 App Router, React 18, TypeScript |
| Wallet | wagmi v2, RainbowKit, viem |
| Smart Contracts | Solidity on Arc Testnet (EVM-compatible, Chain ID 23295) |
| AI Agent | Google Gemini 2.5 Flash via Vercel AI SDK (SSE streaming) |
| Agent Wallet | Circle Developer-Controlled Wallets |
| User Wallets | Circle User-Controlled Wallets (embedded, social login) |
| Storage | IPFS via Pinata, IndexedDB (client-side cache) |
| Email | Resend from noreply@salden.xyz |
| Authentication | Stateless HMAC-SHA256 OTP, Google Identity Services |
| Deployment | Vercel (serverless) |

---

## Smart Contracts

All contracts are deployed on Arc Testnet (Chain ID: 23295).

| Contract | Address |
|---|---|
| SaldenEnterprisePayroll | `0x32B2b3F9EAA03F942B4d170d6343fdb27a795D87` |
| SaldenMultiTokenPayrollFactory | `0x3dB2362b5a4029ed116955c05A42B910aA80851d` |
| SaldenRegistryFactory | `0x5e9dDD4bc4aC8ae17263061275Bd319b4a09bDB5` |
| USDC (Arc Testnet) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |

Verify on [ArcScan](https://testnet.arcscan.app).

---

## Project Structure

```
salden-dapp/
├── public/
│   ├── logo.svg                    # Brand logo
│   ├── favicon.ico / favicon.svg   # Favicons
│   └── images/
│       ├── ai-agent.png            # AI Agent illustration
│       └── ai-avatar.png           # Agent chat avatar
│
├── src/
│   ├── app/
│   │   ├── page.tsx                # Landing page
│   │   ├── dashboard/              # Main payroll dashboard
│   │   ├── ai-agent/               # AI Agent chat + Manage Agent
│   │   ├── compliance/             # Compliance dashboard
│   │   ├── transaction-history/    # Transaction history + charts
│   │   ├── pricing/                # Plan comparison + upgrade
│   │   ├── settings/               # Company settings + contract functions
│   │   ├── docs/                   # Developer documentation
│   │   ├── auth/otp/               # OTP verification page
│   │   ├── terms/ privacy/         # Legal pages
│   │   └── api/
│   │       ├── auth/               # OTP send/verify, Google auth, wallet address
│   │       ├── agent/              # Chat, activate, status
│   │       ├── data/sync/          # IPFS encrypted data sync
│   │       └── invoice/send/       # Invoice email dispatch
│   │
│   ├── components/
│   │   ├── auth/LoginModal.tsx     # Login (Email OTP, Google, WalletConnect)
│   │   ├── layout/                 # AppLayout, Sidebar, Footer
│   │   ├── shared/                 # Button, Modal, Logo, Illustrations
│   │   └── dashboard/              # PaymentModal
│   │
│   ├── context/AppContext.tsx      # Global state (employees, groups, plan status)
│   ├── lib/
│   │   ├── analytics.ts            # Onchain metrics tracking (fire-and-forget)
│   │   ├── contracts/config.ts     # Chain config, contract addresses, ABI helpers
│   │   ├── circle/user-wallet.ts   # Circle UCW API helpers
│   │   ├── db/indexeddb.ts         # Client-side persistence (agent logs, tx history)
│   │   ├── token-registry.ts       # ERC-20 token name/symbol mapping
│   │   └── validation.ts           # Employee data validation, address checks
│   └── styles/globals.css          # Design system, scroll-reveal, responsive grid
```

---

## Getting Started

### Prerequisites

- Node.js 18 or higher
- npm 9 or higher
- Accounts on: Vercel, Pinata, Resend, Circle, Google AI Studio, WalletConnect

### Local Development

```bash
# 1. Clone the repository
git clone https://github.com/YOUR_USERNAME/salden-dapp.git
cd salden-dapp

# 2. Install dependencies
npm install

# 3. Create your environment file
cp .env.example .env.local
# Fill in all values — see Environment Variables below

# 4. Run the development server
npm run dev

# 5. Open http://localhost:3000
```

---

## Environment Variables

Copy `.env.local` and populate every value. The app will not function with missing keys.

```env
# App
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Circle — User-Controlled Wallets (social login + embedded wallet)
NEXT_PUBLIC_CIRCLE_APP_ID=
NEXT_PUBLIC_CIRCLE_CLIENT_KEY=
CIRCLE_API_KEY=
CIRCLE_ENTITY_SECRET=

# Google OAuth (social login via Circle)
NEXT_PUBLIC_GOOGLE_CLIENT_ID=

# Auth
OTP_SECRET=                         # openssl rand -hex 32

# Email
RESEND_API_KEY=

# AI Agent
GEMINI_API_KEY=

# Blockchain
WALLETCONNECT_PROJECT_ID=
NEXT_PUBLIC_RPC_URL=https://rpc.testnet.arc.network

# Contracts (Arc Testnet — already set, do not change unless redeployed)
NEXT_PUBLIC_ENTERPRISE_PAYROLL_ADDRESS=0x32B2b3F9EAA03F942B4d170d6343fdb27a795D87
NEXT_PUBLIC_MULTI_TOKEN_FACTORY_ADDRESS=0x3dB2362b5a4029ed116955c05A42B910aA80851d
NEXT_PUBLIC_REGISTRY_FACTORY_ADDRESS=0x5e9dDD4bc4aC8ae17263061275Bd319b4a09bDB5

# Social links
NEXT_PUBLIC_TWITTER_COMPANY_URL=https://x.com/SaldenPayroll
NEXT_PUBLIC_TWITTER_DEV_URL=https://x.com/Elijah463_
NEXT_PUBLIC_GITHUB_URL=https://github.com/YOUR_USERNAME/salden-dapp

# Analytics (set when analytics site is live)
# NEXT_PUBLIC_ANALYTICS_ENDPOINT=https://analytics.salden.xyz/api/track
```

---

## Deployment

### Vercel (Recommended)

```bash
# Install Vercel CLI
npm install -g vercel

# Deploy to production
vercel deploy --prod
```

**Build settings in Vercel Dashboard:**

| Setting | Value |
|---|---|
| Framework Preset | Next.js |
| Build Command | `npm run build` |
| Output Directory | `.next` |
| Install Command | `npm install` |
| Node.js Version | 18.x |

Add all environment variables in **Project → Settings → Environment Variables** before the first production deploy.

### Domain Setup

Point `app.salden.xyz` to Vercel via CNAME or A record as instructed in **Project → Settings → Domains**. TLS is provisioned automatically.

---

## Security

- Employee records are encrypted client-side with AES-GCM (256-bit) before leaving the browser
- The server never processes or stores plaintext employee data
- OTP authentication is stateless and serverless-safe — no Redis required
- All wallet addresses are validated with EIP-55 checksum enforcement
- OFAC screening runs on every employee address before payroll is processed
- AI Agent actions are logged with structured blocks stored in IndexedDB
- The AI Agent can only pay addresses that exist in the employer's employee database

---

## AI Agent

The AI Payroll Agent is a Premium feature. It uses Google Gemini 2.5 Flash as the natural language layer and a Circle Developer-Controlled Wallet for autonomous Onchain execution. The agent:

- Runs recurring and scheduled payroll
- Screens compliance before every execution
- Logs every action with success and failure status
- Can only send to pre-authorised employee wallet addresses
- Never assumes on ambiguous instructions — it asks

Activate via **AI Agent → Activate AI Agent**, then authorise the generated agent wallet address on your payroll contract.

---

## Contributing

This repository is currently private and maintained by the Salden team. If you have found a security issue, please contact the developer directly rather than opening a public issue.

---

## License

MIT — see [LICENSE](./LICENSE) for details.

---

## Links

- [Live App](https://app.salden.xyz)
- [Documentation](https://app.salden.xyz/docs)
- [ArcScan](https://testnet.arcscan.app)
- [Arc Testnet Faucet](https://faucet.circle.com)
- [Twitter](https://x.com/SaldenPayroll)
