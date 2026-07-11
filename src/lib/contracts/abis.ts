/**
 * @file lib/contracts/abis.ts
 * Smart contract ABIs extracted from deployed contracts on Arc Testnet.
 */

// ─── SaldenEnterprisePayroll ABI (shared contract, free plan) ─────────────────
export const ENTERPRISE_PAYROLL_ABI = [
  {
    "inputs": [
      { "internalType": "address[]", "name": "employees", "type": "address[]" },
      { "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }
    ],
    "name": "batchPay",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "usdc",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_BATCH_SIZE",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "paused",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "caller", "type": "address" },
      { "indexed": false, "internalType": "uint256", "name": "count", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "totalAmount", "type": "uint256" }
    ],
    "name": "BatchPaid",
    "type": "event"
  }
] as const;

// ─── SaldenMultiTokenPayroll ABI (premium clone) ──────────────────────────────
export const MULTI_TOKEN_PAYROLL_ABI = [
  {
    "inputs": [{ "internalType": "address", "name": "initialOwner", "type": "address" }],
    "name": "initialize",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address[]", "name": "employees", "type": "address[]" },
      { "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" },
      { "internalType": "address", "name": "token", "type": "address" }
    ],
    "name": "batchPay",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "account", "type": "address" }],
    "name": "addAgent",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "account", "type": "address" }],
    "name": "removeAgent",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "token", "type": "address" }],
    "name": "addSupportedToken",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getSupportedTokens",
    "outputs": [{ "internalType": "address[]", "name": "", "type": "address[]" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "uint256", "name": "offset", "type": "uint256" },
      { "internalType": "uint256", "name": "limit", "type": "uint256" }
    ],
    "name": "getSupportedTokensPaginated",
    "outputs": [{ "internalType": "address[]", "name": "result", "type": "address[]" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "token", "type": "address" }],
    "name": "withdraw",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "token", "type": "address" }],
    "name": "emergencyWithdraw",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "pause",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "unpause",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "name": "isAgent",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "name": "isSupportedToken",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "paused",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "owner",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "usdc",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_BATCH_SIZE",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "newOwner", "type": "address" }
    ],
    "name": "transferOwnership",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "caller", "type": "address" },
      { "indexed": true, "internalType": "address", "name": "token", "type": "address" },
      { "indexed": false, "internalType": "uint256", "name": "count", "type": "uint256" },
      { "indexed": false, "internalType": "uint256", "name": "totalAmount", "type": "uint256" }
    ],
    "name": "BatchPaid",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [{ "indexed": true, "internalType": "address", "name": "agent", "type": "address" }],
    "name": "AgentAdded",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [{ "indexed": true, "internalType": "address", "name": "agent", "type": "address" }],
    "name": "AgentRemoved",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "token", "type": "address" },
      { "indexed": true, "internalType": "address", "name": "addedBy", "type": "address" }
    ],
    "name": "TokenAdded",
    "type": "event"
  }
] as const;

// ─── SaldenMultiTokenPayrollFactory ABI ───────────────────────────────────────
export const MULTI_TOKEN_FACTORY_ABI = [
  {
    "inputs": [],
    "name": "deployPayroll",
    "outputs": [{ "internalType": "address", "name": "clone", "type": "address" }],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "name": "payrollOf",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "deployFee",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "usdc",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "uint256", "name": "newFee", "type": "uint256" }],
    "name": "setDeployFee",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "withdrawFees",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "employer", "type": "address" },
      { "indexed": true, "internalType": "address", "name": "clone", "type": "address" },
      { "indexed": false, "internalType": "uint256", "name": "fee", "type": "uint256" }
    ],
    "name": "NewPayrollCreated",
    "type": "event"
  }
] as const;

// ─── SaldenRegistryFactory ABI ────────────────────────────────────────────────
export const REGISTRY_FACTORY_ABI = [
  {
    "inputs": [],
    "name": "createRegistry",
    "outputs": [{ "internalType": "address", "name": "clone", "type": "address" }],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "employer", "type": "address" }],
    "name": "getRegistry",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "hrAdmin", "type": "address" },
      { "indexed": true, "internalType": "address", "name": "clone", "type": "address" }
    ],
    "name": "RegistryCreated",
    "type": "event"
  }
] as const;

// ─── SaldenRegistry (clone) ABI ───────────────────────────────────────────────
export const REGISTRY_ABI = [
  {
    "inputs": [{ "internalType": "address", "name": "initialHrAdmin", "type": "address" }],
    "name": "initialize",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "string", "name": "newCID", "type": "string" }],
    "name": "updateCID",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getCID",
    "outputs": [{ "internalType": "string", "name": "", "type": "string" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "agent", "type": "address" }],
    "name": "addAgent",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "agent", "type": "address" }],
    "name": "removeAgent",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "hrAdmin",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "name": "isAgent",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "newAdmin", "type": "address" }],
    "name": "proposeAdminTransfer",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "acceptAdminTransfer",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;

// ─── ERC-20 ABI (for USDC allowance approval) ────────────────────────────────
export const ERC20_ABI = [
  {
    "inputs": [
      { "internalType": "address", "name": "spender", "type": "address" },
      { "internalType": "uint256", "name": "amount", "type": "uint256" }
    ],
    "name": "approve",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "to", "type": "address" },
      { "internalType": "uint256", "name": "amount", "type": "uint256" }
    ],
    "name": "transfer",
    "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "address", "name": "owner", "type": "address" },
      { "internalType": "address", "name": "spender", "type": "address" }
    ],
    "name": "allowance",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "account", "type": "address" }],
    "name": "balanceOf",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "decimals",
    "outputs": [{ "internalType": "uint8", "name": "", "type": "uint8" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "symbol",
    "outputs": [{ "internalType": "string", "name": "", "type": "string" }],
    "stateMutability": "view",
    "type": "function"
  }
] as const;

// ─── Arc Memo Contract ABI ─────────────────────────────────────────────────────
// Predeployed on Arc Testnet: 0x5294E9927c3306DcBaDb03fe70b92e01cCede505
// Used to attach structured JSON memos to any contract call.
// Arc's predeployed Memo contract (0x5294...) — verified against the real
// contract ABI on the Arc Testnet block explorer. The function is `memo`,
// NOT `callWithMemo` — an earlier version of this file had the wrong
// function name and parameter shape entirely (a nonexistent function
// selector), which reverted on every single call. See the `memo`
// signature below: `memoId` is a caller-chosen bytes32 (this codebase
// derives it as keccak256 of the memo bytes — see callers), and the
// actual memo payload goes in `memoData`, not a trailing `value` param —
// this function is nonpayable.
export const MEMO_ABI = [
  {
    "inputs": [
      { "internalType": "address", "name": "target",   "type": "address" },
      { "internalType": "bytes",   "name": "data",     "type": "bytes"   },
      { "internalType": "bytes32", "name": "memoId",   "type": "bytes32" },
      { "internalType": "bytes",   "name": "memoData", "type": "bytes"   }
    ],
    "name": "memo",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "bytes", "name": "returnData", "type": "bytes" }],
    "name": "MemoFailed",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true,  "internalType": "address", "name": "sender",       "type": "address" },
      { "indexed": true,  "internalType": "address", "name": "target",       "type": "address" },
      { "indexed": false, "internalType": "bytes32",  "name": "callDataHash", "type": "bytes32" },
      { "indexed": true,  "internalType": "bytes32",  "name": "memoId",      "type": "bytes32" },
      { "indexed": false, "internalType": "bytes",    "name": "memo",        "type": "bytes"   },
      { "indexed": false, "internalType": "uint256",  "name": "memoIndex",   "type": "uint256" }
    ],
    "name": "Memo",
    "type": "event"
  }
] as const;

export const MEMO_CONTRACT_ADDRESS = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505' as const;
