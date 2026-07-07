/**
 * @file lib/contracts/agentAbis.ts
 *
 * ABI fragments for agent permission management, derived directly from the
 * actual deployed Salden contract source files (v3.0.0 for Registry,
 * v2.0.0 for MultiTokenPayroll).
 *
 * ── SaldenRegistry permission model ──────────────────────────────────────────
 * There is NO OpenZeppelin AccessControl, NO `grantRole`, NO `OPERATOR_ROLE`.
 * The contract uses a custom two-role model:
 *   hrAdmin  — absolute owner; set once at clone initialisation
 *   isAgent  — mapping(address => bool); managed by hrAdmin only
 *
 * To grant the AI Agent permission to call `updateCID`:
 *   SaldenRegistry.addAgent(agentWallet)   ← called by hrAdmin (the employer)
 *
 * To revoke:
 *   SaldenRegistry.removeAgent(agentWallet) ← called by hrAdmin
 *
 * ── SaldenMultiTokenPayroll permission model ──────────────────────────────────
 * Uses OwnableUpgradeable (owner = employer) + custom isAgent mapping.
 * There is NO OpenZeppelin AccessControl, NO `grantRole`, NO `OPERATOR_ROLE`.
 *
 * To grant the AI Agent permission to call `batchPay`, `withdraw`, `addSupportedToken`:
 *   SaldenMultiTokenPayroll.addAgent(agentWallet)   ← called by owner (employer)
 *
 * To revoke:
 *   SaldenMultiTokenPayroll.removeAgent(agentWallet) ← called by owner
 *
 * ── What the WRONG approach looked like ───────────────────────────────────────
 * A previous version called grantRole(keccak256("OPERATOR_ROLE"), agentAddr).
 * This is an OpenZeppelin AccessControl pattern — neither contract implements
 * AccessControl, so the call would revert with "function not found" at runtime.
 * Both fragments below have been verified against the actual Solidity source.
 */

// ── SaldenRegistry — agent management ────────────────────────────────────────

export const REGISTRY_ADD_AGENT_ABI = [
  {
    name: 'addAgent',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs:  [{ name: 'account', type: 'address' }],
    outputs: [],
  },
] as const;

export const REGISTRY_REMOVE_AGENT_ABI = [
  {
    name: 'removeAgent',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs:  [{ name: 'account', type: 'address' }],
    outputs: [],
  },
] as const;

export const REGISTRY_IS_AGENT_ABI = [
  {
    name: 'isAgent',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs:  [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export const REGISTRY_UPDATE_CID_ABI = [
  {
    name: 'updateCID',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs:  [{ name: 'newCID', type: 'string' }],
    outputs: [],
  },
] as const;

export const REGISTRY_GET_CID_ABI = [
  {
    name: 'getCID',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs:  [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

export const REGISTRY_HR_ADMIN_ABI = [
  {
    name: 'hrAdmin',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs:  [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

// ── SaldenMultiTokenPayroll — agent management ────────────────────────────────

export const PAYROLL_ADD_AGENT_ABI = [
  {
    name: 'addAgent',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs:  [{ name: 'account', type: 'address' }],
    outputs: [],
  },
] as const;

export const PAYROLL_REMOVE_AGENT_ABI = [
  {
    name: 'removeAgent',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs:  [{ name: 'account', type: 'address' }],
    outputs: [],
  },
] as const;

export const PAYROLL_IS_AGENT_ABI = [
  {
    name: 'isAgent',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs:  [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/**
 * batchPay always takes three arguments in SaldenMultiTokenPayroll v2.0.0.
 * Passing address(0) for `token` defaults to USDC (per contract source).
 * There is no two-argument variant — an earlier enterprise contract had one,
 * but all current clones use this three-argument signature.
 */
export const PAYROLL_BATCH_PAY_ABI = [
  {
    name: 'batchPay',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [
      { name: 'employees', type: 'address[]' },
      { name: 'amounts',   type: 'uint256[]' },
      { name: 'token',     type: 'address'   },
    ],
    outputs: [],
  },
] as const;

export const PAYROLL_OWNER_ABI = [
  {
    name: 'owner',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs:  [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;
