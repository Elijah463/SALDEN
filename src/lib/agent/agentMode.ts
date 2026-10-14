/**
 * @file lib/agent/agentMode.ts
 * SERVER-SIDE ONLY.
 *
 * Lets each employer choose how the AI agent is allowed to act:
 *
 *   - 'confirm'    (default), every fund-moving or data-changing action
 *     (add/edit/remove an employee, run payroll, pay someone) is always
 *     proposed as a confirmation card; a human clicks Confirm and signs
 *     with their own wallet. This is the proven path, see
 *     lib/agent/autonomousExecution.ts and app/api/agent/tx-status/route.ts
 *     for the pending-transaction fix that made it reliable.
 *   - 'autonomous', the agent may also call the execute_* tools, which
 *     act immediately from the agent's own Circle-managed wallet with no
 *     per-action human signature. Kept fully in place (not removed) for
 *     employers who want it, but no longer what a new employer gets
 *     without explicitly turning it on.
 *
 * getToolDeclarations() in tools.ts uses this to physically remove the
 * execute_* tool declarations from what's sent to the model in 'confirm'
 * mode, this is enforced by not giving the model the option at all, not
 * by a system-prompt instruction the model could ignore or get confused
 * by mid-conversation.
 *
 * Stored in KV only, never per-instance memory: instances must never disagree
 * about whether the agent may act without confirmation. An unreadable store
 * means 'confirm'. A failed write is reported to the caller, not shown as success.
 */

import { kvGetStrict, kvSet, kvAvailable } from '@/lib/kv';

export type AgentMode = 'confirm' | 'autonomous';

function kvKey(walletAddress: string): string {
  return `agentMode:${walletAddress.toLowerCase()}`;
}

/** The employer's chosen mode. Defaults to 'confirm' when unset or when the
 *  store cannot be read: an outage must never grant more autonomy. */
export async function getAgentMode(walletAddress: string): Promise<AgentMode> {
  try {
    const stored = await kvGetStrict<AgentMode>(kvKey(walletAddress));
    return stored === 'autonomous' ? 'autonomous' : 'confirm';
  } catch {
    return 'confirm';
  }
}

/** Returns true only if the mode was saved. */
export async function setAgentMode(walletAddress: string, mode: AgentMode): Promise<boolean> {
  if (!kvAvailable()) return false;
  return kvSet(kvKey(walletAddress), mode);
}
