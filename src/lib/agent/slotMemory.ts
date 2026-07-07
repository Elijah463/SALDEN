/**
 * @file lib/agent/slotMemory.ts
 * SERVER-SIDE ONLY.
 *
 * The 20-message sliding window keeps token usage down, but it means a
 * detail mentioned in message 1 (an address) is gone by message 25 when
 * the user finally confirms an amount — the model has no way to recall
 * it. This does a lightweight scan of the FULL message history (not just
 * the window) for a small set of payroll-relevant facts and surfaces them
 * as a compact summary, regardless of how long the conversation has run.
 *
 * This is intentionally simple regex extraction, not a second LLM call —
 * keeps it free and fast. It only ever ADDS context, never replaces the
 * sliding window itself.
 */

export interface ExtractedSlots {
  addresses: string[];
  amounts:   string[];
  names:     string[];
}

const ADDRESS_RE = /0x[0-9a-fA-F]{40}/g;
const AMOUNT_RE  = /\b\d{1,3}(?:,\d{3})*(?:\.\d{1,6})?\s*(?:USDC|EURC|USD|usdc|eurc)\b/g;

export function extractSlotsFromHistory(
  messages: Array<{ role: string; content: string }>,
): ExtractedSlots {
  const addresses = new Set<string>();
  const amounts   = new Set<string>();

  for (const m of messages) {
    const addrMatches = m.content.match(ADDRESS_RE) ?? [];
    addrMatches.forEach(a => { addresses.delete(a); addresses.add(a); });

    const amtMatches = m.content.match(AMOUNT_RE) ?? [];
    amtMatches.forEach(a => { const t = a.trim(); amounts.delete(t); amounts.add(t); });
  }

  return {
    addresses: [...addresses].slice(-5),   // most recent 5 — avoid unbounded growth
    amounts:   [...amounts].slice(-5),
    names:     [],
  };
}

export function formatSlotsForPrompt(slots: ExtractedSlots): string {
  if (slots.addresses.length === 0 && slots.amounts.length === 0) return '';

  const lines = ['\n═══ FACTS MENTIONED EARLIER IN THIS CONVERSATION (may be outside the recent window) ═══'];
  if (slots.addresses.length) lines.push(`Addresses mentioned: ${slots.addresses.join(', ')}`);
  if (slots.amounts.length)   lines.push(`Amounts mentioned: ${slots.amounts.join(', ')}`);
  lines.push('Use these only if the user is clearly still referring to them — always re-confirm before any critical action, per Guardrail 4.');
  lines.push('═══ END FACTS ═══');
  return lines.join('\n');
}
