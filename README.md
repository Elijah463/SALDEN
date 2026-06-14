# salden-dapp — Product App

> app.salden.xyz · Onchain payroll dashboard, AI Agent, compliance, settings, and more.

The full Salden product. Connects to Arc Testnet smart contracts, Circle wallets, and the AI Payroll Agent. The marketing site lives separately at `salden-www`.

## Routes

| Route | Description |
|---|---|
| `/dashboard` | Payroll dashboard — employees, batch payment |
| `/ai-agent` | AI Payroll Agent chat and management |
| `/compliance` | Compliance monitoring |
| `/transaction-history` | Payment history and charts |
| `/pricing` | Plan comparison and premium upgrade |
| `/settings` | Company settings, contract functions |
| `/auth/otp` | OTP verification |

## Stack

Next.js 14 · React 18 · TypeScript · wagmi v2 · viem · RainbowKit · Circle UCW · Gemini AI

## Local development

```bash
npm install
npm run dev
# http://localhost:3000 → redirects to /dashboard
```

## Environment variables

See `.env.local`. All Circle, Gemini, Resend, and WalletConnect keys are required for full functionality.

## Deployment

Deployed to Vercel. Domain: `app.salden.xyz`.

The marketing site lives in a separate repository — `salden-www`.
