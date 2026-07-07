# SALDEN A Smart Onchain Payroll

> Smart Premium payroll infrastructure built on Arc Network. Batch payments, AI automation, encrypted employee records,Schedule Payments, Recurring Payments and built-in compliance all in one platform.

[![Deployed on Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-black?logo=vercel)](https://app.salden.xyz)
[![Network](https://img.shields.io/badge/Network-ARC%20Testnet-4F46E5)](https://testnet.arcscan.app)
[![License](https://img.shields.io/badge/License-AGPL%20v3-blue)](./LICENSE)

---

## What is Salden?

Salden is a decentralised payroll platform that replaces traditional payroll infrastructure with smart contracts. Employers can pay any number of employees in USDC or any ERC-20 token in a single onchain transaction. Employee records are encrypted end-to-end and stored on IPFS. An AI Payroll Agent handles recurring payroll, compliance screening, and scheduling autonomously, without ever requiring manual intervention.

Salden is built for the future of work remote teams, borderless payments, and organisations that demand transparency and auditability at every step.

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

## Security

- Employee records are encrypted client-side with AES-GCM (256 bit) before leaving the browser  the server never sees plaintext data
- All wallet addresses are validated with EIP-55 checksum enforcement
- OFAC compliance screening runs on every employee address before payroll is processed
- The AI Agent can only send funds to pre-authorised addresses in the employer's employee database
- OTP authentication is stateless and serverless-safe

---

## AI Agent

The AI Payroll Agent is a Premium feature that brings full autonomy to your payroll workflow. It handles recurring and scheduled payroll runs, screens compliance before every execution, logs every action with structured audit trails, and never acts on ambiguous instructions it asks first.

---

## Network

Salden is deployed on ARC Testnet.

| Property | Value |
|---|---|
| Network Name | ARC Testnet |
| RPC URL | https://rpc.testnet.arc.network |
| Chain ID | 5042002 |
| Currency Symbol | USDC |
| Block Explorer | https://testnet.arcscan.app |

---

## Smart Contracts

| Contract | Address |
|---|---|
| SaldenEnterprisePayroll | `0x32B2b3F9EAA03F942B4d170d6343fdb27a795D87` |
| SaldenMultiTokenPayrollFactory | `0x3dB2362b5a4029ed116955c05A42B910aA80851d` |
| SaldenRegistryFactory | `0x5e9dDD4bc4aC8ae17263061275Bd319b4a09bDB5` |
| USDC (ARC Testnet) | `0x3600000000000000000000000000000000000000` |

Verify on [ArcScan](https://testnet.arcscan.app).

---

## Contributing

This repository is currently maintained by the Salden team. If you have discovered a security issue, please contact the developer directly rather than opening a public issue.

---

## License

GNU Affero General Public License v3.0 see [LICENSE](./LICENSE) for details.  
Full license text available at [gnu.org/licenses/agpl-3.0](https://www.gnu.org/licenses/agpl-3.0.html).

---

## Links

- [Live App](https://app.salden.xyz)
- [Documentation](https://app.salden.xyz/docs)
- [ArcScan Explorer](https://testnet.arcscan.app)
- [ARC Testnet Faucet](https://faucet.circle.com)
- [Twitter / X](https://x.com/SaldenPayroll)
