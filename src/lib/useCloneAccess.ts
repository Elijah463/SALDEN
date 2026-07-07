'use client';
/**
 * @file   frontend/useCloneAccess.ts
 * @notice React hook that checks whether the connected wallet has deployed
 *         a clone from SaldenPayrollFactory.
 *
 *         This is the gatekeeper for agent access. A wallet without a clone
 *         gets the standard dapp experience. A wallet with a clone gets the
 *         "Activate AI Agent" button (or the full agent dashboard if already
 *         activated).
 *
 *         ─── What it checks ─────────────────────────────────────────────────
 *         SaldenPayrollFactory.payrollOf(walletAddress)
 *           → address(0)   = no clone deployed → cloneAddress: null
 *           → 0xSomeAddr.. = clone exists      → cloneAddress: "0x..."
 *
 *         ─── Usage ───────────────────────────────────────────────────────────
 *         import { useCloneAccess } from '../hooks/useCloneAccess';
 *
 *         function App() {
 *           const { cloneAddress, hasClone, loading, error } = useCloneAccess();
 *
 *           if (loading)   return <Spinner />;
 *           if (!hasClone) return <StandardDapp />;
 *           return <AgentDashboard cloneAddress={cloneAddress!} />;
 *         }
 *
 *         ─── Dependencies ────────────────────────────────────────────────────
 *         Assumes you have wagmi + viem set up in your React project.
 *         If you use ethers.js instead, swap readContract for provider.call().
 */

import { useState, useEffect } from "react";
import { useAccount, usePublicClient } from "wagmi";

// ── Contract config ─────────────────────────────────────────────────────────
// Update these addresses after deploying your factory contracts.
const PAYROLL_FACTORY_ADDRESS = process.env.NEXT_PUBLIC_PAYROLL_FACTORY_ADDRESS ?? '0x0000000000000000000000000000000000000000';

const PAYROLL_FACTORY_ABI = [
  {
    name:            "payrollOf",
    type:            "function",
    stateMutability: "view",
    inputs:          [{ name: "employer", type: "address" }],
    outputs:         [{ name: "",         type: "address" }],
  },
] as const;

// The actual EVM zero address — payrollOf() returns this when a wallet has
// NOT deployed a clone. This must never be tied to PAYROLL_FACTORY_ADDRESS
// (a previous version of this constant accidentally read the same env var
// as the factory address above, which meant this comparison was never true
// for wallets without a clone — every new user was incorrectly treated as
// already having one, with cloneAddress literally set to the zero address).
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ── Hook return type ─────────────────────────────────────────────────────────

export interface CloneAccessResult {
  /**
   * The wallet's deployed payroll clone address.
   * null if no clone exists or wallet is not connected.
   */
  cloneAddress: string | null;
  /**
   * true if the connected wallet has a deployed clone.
   * false if not, or while loading.
   */
  hasClone:     boolean;
  /** true while the contract read is in flight. */
  loading:      boolean;
  /** Error message if the read failed. */
  error:        string | null;
  /** Re-run the clone check manually (useful after a clone is deployed). */
  refresh:      () => void;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useCloneAccess(): CloneAccessResult {
  const { address, isConnected } = useAccount();
  const publicClient              = usePublicClient();

  const [cloneAddress, setCloneAddress] = useState<string | null>(null);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [tick,         setTick]         = useState(0);

  const refresh = () => setTick(t => t + 1);

  useEffect(() => {
    if (!isConnected || !address || !publicClient) {
      setCloneAddress(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    publicClient
      .readContract({
        address:      CONTRACTS.MULTI_TOKEN_FACTORY as `0x${string}`,
        abi:          PAYROLL_FACTORY_ABI,
        functionName: "payrollOf",
        args:         [address],
      })
      .then((result) => {
        if (cancelled) return;
        const clone = result as string;
        setCloneAddress(
          clone && clone.toLowerCase() !== ZERO_ADDRESS ? clone : null
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : "Failed to check clone access."
        );
        setCloneAddress(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [address, isConnected, publicClient, tick]);

  return {
    cloneAddress,
    hasClone: cloneAddress !== null,
    loading,
    error,
    refresh,
  };
}
