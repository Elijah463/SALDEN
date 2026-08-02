/**
 * @file lib/agent/agentMode.ts
 * SERVER-SIDE ONLY.
 *
 * Lets each employer choose how the AI agent is allowed to act:
 *
 *   - 'confirm'    (default) — every fund-moving or data-changing action
 *     (add/edit/remove an employee, run payroll, pay someone) is always
 *     proposed as a confirmation card; a human clicks Confirm and signs
 *     with their own wallet. This is the proven path — see
 *     lib/agent/autonomousExecution.ts and app/api/agent/tx-status/route.ts
 *     for the pending-transaction fix that made it reliable.
 *   - 'autonomous' — the agent may also call the execute_* tools, which
 *     act immediately from the agent's own Circle-managed wallet with no
 *     per-action human signature. Kept fully in place (not removed) for
 *     employers who want it, but no longer what a new employer gets
 *     without explicitly turning it on.
 *
 * getToolDeclarations() in tools.ts uses this to physically remove the
 * execute_* tool declarations from what's sent to the model in 'confirm'
 * mode — this is enforced by not giving the model the option at all, not
 * by a system-prompt instruction the model could ignore or get confused
 * by mid-conversation.
 *
 * Same storage pattern as employerLimits.ts (kvGet/kvSet with an
 * in-memory same-instance fallback) — this is deliberate employer
 * configuration, not an ephemeral counter, so it shouldn't quietly revert
 * to the default on a cold start.
 */

import { kvGet, kvSet, kvAvailable } from '@/lib/kv';

export type AgentMode = 'confirm' | 'autonomous';

const _memory = new Map<string, AgentMode>(); // fallback: wallet (lowercased) -> mode

function memKey(walletAddress: string): string {
  return walletAddress.toLowerCase();
}

function kvKey(walletAddress: string): string {
  return `agentMode:${memKey(walletAddress)}`;
}

/** Returns the employer's chosen mode, defaulting to 'confirm' if they've
 *  never explicitly chosen 'autonomous'. */
export async function getAgentMode(walletAddress: string): Promise<AgentMode> {
  const key = memKey(walletAddress);

  if (kvAvailable()) {
    const stored = await kvGet<AgentMode>(kvKey(walletAddress));
    if (stored === 'confirm' || stored === 'autonomous') {
      _memory.set(key, stored);
      return stored;
    }
  }

  return _memory.get(key) ?? 'confirm';
}

export async function setAgentMode(walletAddress: string, mode: AgentMode): Promise<void> {
  const key = memKey(walletAddress);
  _memory.set(key, mode);
  await kvSet(kvKey(walletAddress), mode);
}
