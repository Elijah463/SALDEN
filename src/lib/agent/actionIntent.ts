/**
 * @file lib/agent/actionIntent.ts
 * SERVER-SIDE ONLY.
 *
 * Deterministic "does this message ask the agent to DO something?" check, used to
 * refuse tool-requiring requests from free-plan wallets before any model call.
 *
 * Free wallets are already given no tools, and the system prompt tells the model to
 * decline actions, but that second part depends on the model obeying. This check does
 * not: a free wallet that asks for an action gets the fixed upgrade message instantly.
 *
 * It deliberately lets plain questions through ("how do I pay my employees?",
 * "what is Salden Pro?"), since free wallets may chat about payments. A request is an
 * action when it is phrased as a command or a request to act, or when it names a
 * concrete target for money movement or a data lookup (an address, an amount, the
 * wallet's own balance).
 */

export const UPGRADE_REQUIRED_MESSAGE =
  'Your Request cannot be completed please Upgrade to Salden Pro to access this feature';

// Verbs that map onto agent tools: payments, payroll, employees, schedules, swaps, lookups.
const ACTION_VERBS =
  'pay|send|transfer|withdraw|deposit|fund|top\\s*up|run|execute|process|trigger|start|' +
  'schedule|reschedule|cancel|pause|resume|stop|' +
  'add|remove|delete|edit|update|change|rename|modify|raise|increase|decrease|' +
  'hire|fire|import|upload|' +
  'create|set|setup|set\\s+up|activate|approve|swap|bridge|convert|' +
  'check|verify|screen|show|get|fetch|list|view|see|look\\s*up|find|' +
  'request|claim|mint';

// Lead-ins that turn a verb into a request to act ("can you pay ...", "I want to add ...").
const LEAD_IN =
  "(?:please|kindly|hey|hi|ok|okay|now|then|and|also|" +
  "(?:can|could|would|will)\\s+you(?:\\s+please)?|" +
  "(?:i|we)\\s+(?:want|need|would\\s+like|'d\\s+like|wanna|have)\\s+to|" +
  "(?:i|we)\\s+(?:want|need)\\s+you\\s+to|" +
  "(?:i|we)'d\\s+like\\s+(?:you\\s+)?to|" +
  "help\\s+me(?:\\s+to)?|let'?s|go\\s+ahead\\s+and|you\\s+should|you\\s+need\\s+to)";

const COMMAND_START = new RegExp(`^\\s*(?:${LEAD_IN}\\s+)*(?:${ACTION_VERBS})\\b`, 'i');

// Questions and explanations. These are fine for free wallets unless they also carry a
// concrete target (see CONCRETE_TARGET).
const INFORMATIONAL_START =
  /^\s*(?:how|what|why|when|where|which|who|whom|whose|explain|describe|define|tell\s+me\s+(?:about|more|what|how|why)|difference|compare|is|are|was|were|does|do|did|should|could\s+i|can\s+i|may\s+i|am\s+i)\b/i;

const ADDRESS = /\b0x[a-fA-F0-9]{40}\b/;
const AMOUNT = /\b\d[\d,]*(?:\.\d+)?\s*(?:usdc|eurc|cirbtc|usd|eur|dollars?|euros?)\b/i;
// Reading the wallet's own data is a tool call (get_balance, get_transaction_status, schedules).
const OWN_DATA_LOOKUP =
  /\b(?:my|our|the\s+agent'?s?|agent|wallet|payroll|contract)\s+(?:\w+\s+){0,2}(?:balance|balances|schedules?|transactions?|tx\s+status)\b|\btransaction\s+status\b|\bbalance\s+of\s+0x/i;
const COMPLIANCE_LOOKUP = /\b(?:ofac|sanctions?|compliance)\b.*\b(?:check|screen|verify|address|wallet|0x)/i;
const PAYROLL_OBJECT =
  /\b(?:payroll\s+run|payroll|salary|salaries|employees?|staff|recurring|schedule[sd]?|batch|payment|payments|invoice|group)\b/i;
const TOKEN_OR_CHAIN = /\b(?:usdc|eurc|cirbtc|arc)\b/i;

/**
 * True when the message asks the agent to perform an action or a lookup that needs
 * tools. Intentionally conservative toward letting questions through; the free plan
 * still has no tools and a system-prompt refusal as further layers.
 */
export function requiresToolAccess(rawText: string): boolean {
  const text = (rawText ?? '').trim();
  if (!text) return false;

  const hasAddress = ADDRESS.test(text);
  const hasAmount = AMOUNT.test(text);
  const informational = INFORMATIONAL_START.test(text);

  // Own-data lookups, compliance screening and address/amount-bearing requests.
  if (OWN_DATA_LOOKUP.test(text) && !/^\s*(?:how|why|explain|what\s+is\s+a)\b/i.test(text)) return true;
  if (COMPLIANCE_LOOKUP.test(text) && hasAddress) return true;
  if (hasAddress && new RegExp(`\\b(?:${ACTION_VERBS})\\b`, 'i').test(text)) return true;
  if (hasAmount && new RegExp(`\\b(?:${ACTION_VERBS})\\b`, 'i').test(text) && !informational) return true;

  if (informational) return false;

  // Commands and requests to act ("pay John", "can you run payroll", "add an employee").
  if (COMMAND_START.test(text)) {
    // "show/get/see/view/find/list/check ..." alone are only actions when pointed at the
    // user's own payroll or wallet, not at general knowledge ("show me an example").
    const startsWithLookupVerb = /^\s*(?:(?:please|kindly|can\s+you|could\s+you|help\s+me)\s+)*(?:check|verify|show|get|fetch|list|view|see|look\s*up|find)\b/i.test(text);
    if (startsWithLookupVerb) {
      if (/\b(?:example|examples|sample|template|tutorial|guide|overview|explanation|policy|policies)\b/i.test(text) && !OWN_DATA_LOOKUP.test(text) && !hasAddress) return false;
      return PAYROLL_OBJECT.test(text) || OWN_DATA_LOOKUP.test(text) || TOKEN_OR_CHAIN.test(text) || hasAddress;
    }
    return true;
  }

  // "I want to pay everyone on Friday", "need to add 3 employees" anywhere in the message.
  if (/\b(?:i|we)\s+(?:want|need|would\s+like|'d\s+like)\s+to\s+(?:pay|send|transfer|run|schedule|add|remove|delete|edit|update|swap|bridge)\b/i.test(text)) return true;

  return false;
}
