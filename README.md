# SALDEN A Smart Onchain Payroll

> Smart payroll infrastructure built on Arc Network. Batch payments, AI automation, encrypted employee records,Schedule Payments, Recurring Payments and built-in compliance all in one platform.

[![Deployed on Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-black?logo=vercel)](https://app.salden.xyz)
[![Network](https://img.shields.io/badge/Network-Arc%20Network-4F46E5)](https://explorer.arc.io)
[![License](https://img.shields.io/badge/License-AGPL%20v3-blue)](./LICENSE)

---

## What is Salden?

Salden is a decentralised payroll platform that replaces traditional payroll infrastructure with programmable stablecoin infrastructure, enabling businesses and individuals to automate borderless payroll through smart contracts and USDC. Employers can pay any number of employees in USDC or any other stablecoins like EURC in a single onchain transaction. Employee records are encrypted end-to-end and stored on IPFS. An AI Payroll Agent smartly handles recurring payroll, compliance screening, and scheduling autonomously, without ever requiring manual intervention.

Salden leverages Circle’s programmable stablecoin technology to allow seemless borderless payments for organisations that demand transparency and auditability at every step.

---

## Features

| Feature | Free | Salden Pro |
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
| Cost | Free | $1.99 USDC per year |

---

## Security

- Employee records are encrypted client-side with AES-GCM (256 bit) before leaving the browser  the server never sees plaintext data
- All wallet addresses are validated with EIP-55 checksum enforcement
- OFAC compliance screening runs on every employee address before payroll is processed
- The AI Agent can only send funds to pre-authorised addresses in the employer's employee database
- OTP authentication is stateless and serverless-safe

---

## AI Agent

The AI Payroll Agent is a Salden Pro feature that brings full autonomy to your payroll workflow. It handles recurring and scheduled payroll runs, screens compliance before every execution, logs every action with structured audit trails, and never acts on ambiguous instructions it asks first.

---

## Network

Salden is deployed on Arc Network.

| Property | Value |
|---|---|
| Network Name | Arc Network |
| RPC URL | https://rpc.mainnet.arc.io |
| Chain ID | 5042 |
| Currency Symbol | USDC |
| Block Explorer | https://explorer.arc.io |

---

## Smart Contracts

| Contract | Address |
|---|---|
| SaldenEnterprisePayroll | `0xEab86c6BF41f1f316Edd7A91f2Bd22dCB8095790` |
| SaldenMultiTokenPayrollFactory (ERC1967Proxy) | `0xee56A15f23E93dae71de5101dc915d0039EF1DFA` |
| SaldenRegistryFactory | `0x42b9123322A21a13c89fb8d7d9B9432D0e46733e` |
| USDC (Arc Network) | `0x3600000000000000000000000000000000000000` |

Verify on [ArcScan](https://explorer.arc.io).

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
- [ArcScan Explorer](https://explorer.arc.io)
- [Twitter / X](https://x.com/Salden_xyz)
