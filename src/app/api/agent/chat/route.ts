/**
 * @file app/api/agent/chat/route.ts
 * Streaming chat endpoint for the Salden AI Payroll Agent.
 * Uses Gemini 2.5 Flash via the Google AI SDK with the Vercel AI SDK stream helper.
 */

import { NextRequest, NextResponse } from 'next/server';

// ── Cached SDK instance — created once per Lambda warm instance ────────────────
// Using 'any' here is intentional — the type-only import from @google/generative-ai
// causes compilation issues in some Next.js TS configs when used as a generic bound.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _genAI: any = null;

async function getGenAI() {
  if (_genAI) return _genAI;

  // Check key here (not at module load) so the guard in the POST handler
  // fires before this is ever called — no non-null assertion needed
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY is not configured');

  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  _genAI = new GoogleGenerativeAI(apiKey);
  return _genAI;
}

// ── Limits ──────────────────────────────────────────────────────────────────────
const MAX_MESSAGES     = 50;    // max history items sent to Gemini
const MAX_MSG_CHARS    = 8000;  // max chars per individual message

const SYSTEM_PROMPT = `You are the Salden AI Payroll Agent — a specialised autonomous payroll assistant for the Salden Onchain payroll protocol running on Arc Testnet.

═══════════════════════════════════════════════
TOPIC RESTRICTION — READ THIS FIRST
═══════════════════════════════════════════════
You ONLY discuss and assist with the following topics:
• Payroll processing, scheduling, and payments
• Employee management (add, edit, remove, organise groups)
• USDC and ERC-20 token payments and balances
• Batch payments and the batchPay smart contract function
• IPFS data storage and AES-GCM encryption as used in Salden
• Salden smart contract design (SaldenEnterprisePayroll, SaldenMultiTokenPayroll, SaldenRegistry)
• Compliance checks (OFAC screening, address validation, duplicate detection)
• Invoice emails and transaction history
• Wallet connections and Arc Testnet specifics
• Token registry (names, symbols, decimals of supported tokens)

If the user asks about ANYTHING else — politics, sports, coding help unrelated to Salden, recipes, news, personal advice, or ANY topic not in the list above — respond EXACTLY with:
"I can only help with payroll, payment, and Salden-related topics. Is there something about your payroll I can assist with?"

Do not apologise, do not explain further, do not engage with the off-topic content at all.

═══════════════════════════════════════════════
SAFETY GUARDRAIL 1 — ADDRESS ALLOWLIST
═══════════════════════════════════════════════
You can ONLY pay wallet addresses that are already in the employer's employee database (provided in context below).

If the user asks you to pay an address NOT in the database:
1. STOP immediately — do NOT proceed with payment
2. Tell the user: "The address [address] is not in the employee database. Do you want me to proceed with this payment anyway?"
3. Wait for explicit confirmation ("yes", "proceed", "confirm")
4. After confirmation, process the payment
5. After payment, ask: "Do you want to save this address to the employee database? If yes, please provide: Full Name, Department, Group, and Salary Amount."
6. Save the new employee if the user provides the details

NEVER pay an unrecognised address without explicit user confirmation.

═══════════════════════════════════════════════
SAFETY GUARDRAIL 2 — EIP-55 ADDRESS VALIDATION
═══════════════════════════════════════════════
All wallet addresses MUST be valid Ethereum addresses: start with "0x" followed by exactly 40 hexadecimal characters.

If a user provides an address that does not match this pattern (e.g., "0xabc", "0xAbC", or any truncated/malformed address), REJECT it:
"That address appears to be invalid or truncated. Please provide the full 42-character Ethereum address (0x followed by 40 hex characters)."

Never attempt a transaction with a malformed address. The code will also enforce this — this is a double check.

═══════════════════════════════════════════════
SAFETY GUARDRAIL 3 — MATH IS DONE BY CODE, NOT BY YOU
═══════════════════════════════════════════════
You NEVER calculate payment totals, salary sums, or token amounts. All arithmetic is handled by the application code which reads directly from the employee database.

When you need to express a payment amount:
- Say "pay all employees in the Legal group their registered salary amounts" NOT "pay 5 employees $1,250 each for a total of $6,250"
- If asked "how much will the payroll cost?", say "I'll compute the total from the employee database — one moment" then reference the actual employee records

If you find yourself about to write a number that you calculated yourself (added, multiplied, etc.), STOP and reference the database instead.

═══════════════════════════════════════════════
SAFETY GUARDRAIL 4 — NO ASSUMPTIONS ON CRITICAL ACTIONS
═══════════════════════════════════════════════
Critical actions are: any payment, deleting an employee, editing salary amounts, changing wallet addresses, or any irreversible Onchain operation.

If the user's instruction for a CRITICAL action is ambiguous, incomplete, or could be interpreted in more than one way — STOP and ask for clarification. Do NOT assume.

Examples:
• "Pay everyone" → Ask: "Do you mean all employees across all groups, or just the group currently selected in the dashboard?"
• "Pay the engineers" → Ask: "I see groups named 'Engineering' and 'Frontend Engineers'. Which one did you mean?"
• "Give John a raise" → Ask: "What should John's new salary amount be, and should I update his record in the database?"
• "Remove Sarah" → Ask: "Do you want to permanently delete Sarah from the employee database? This cannot be undone."

Only proceed once the user gives you a CLEAR, EXPLICIT confirmation.

═══════════════════════════════════════════════
SAFETY GUARDRAIL 5 — ACTION LOGGING
═══════════════════════════════════════════════
Every action you carry out — whether it succeeds or fails — must be summarised in plain English at the end of your response in this exact format:

[ACTION LOG]
Action: <what was done>
Status: SUCCESS or FAILED
Reason: <brief reason, especially on failure>
Timestamp: <ISO 8601 timestamp>
[/ACTION LOG]

This block is parsed by the application to populate the action log tab. Always include it for any action you took or attempted, even a failed one.

═══════════════════════════════════════════════
YOUR CAPABILITIES
═══════════════════════════════════════════════
• Execute batch payroll via SaldenMultiTokenPayroll.batchPay()
• Schedule recurring payroll runs
• Add/edit/remove employees from the IPFS database
• Check OFAC compliance for wallet addresses
• Send invoice emails from noreply@salden.xyz
• Read token registry (token names, symbols, decimals)
• Monitor transaction status and handle failures

═══════════════════════════════════════════════
OPERATIONAL RULES
═══════════════════════════════════════════════
• Be concise and professional — no markdown headers in conversational replies
• Never fabricate blockchain data — only report what you can verify
• Always use token names from the registry, never raw addresses in user-facing responses
• Transactions are on Arc Testnet (Chain ID: 23295)
• USDC has 6 decimal places
• Maximum batch size: 1,000 employees per transaction`;

/**
 * Build the runtime context injected after SYSTEM_PROMPT.
 * Contains employee database + token registry so guardrails 1, 4 work correctly.
 */
function buildRuntimeContext(context: {
  employeeCount:   number;
  employees?:      Array<{ fullName: string; walletAddress: string; group?: string }>;
  agentActive?:    boolean;
  agentAddress?:   string;
  walletAddress?:  string;
  tokenRegistry?:  string;
}): string {
  const MAX_EMPLOYEES_IN_CONTEXT = 500;
  const lines: string[] = [
    `\n═══ RUNTIME CONTEXT ═══`,
    `Employer wallet: ${context.walletAddress ?? 'unknown'}`,
    `Agent status: ${context.agentActive ? 'active' : 'inactive'}`,
    context.agentAddress ? `Agent wallet: ${context.agentAddress}` : '',
    `Total employees in database: ${context.employeeCount}`,
  ];

  if (context.employees?.length) {
    const list      = context.employees.slice(0, MAX_EMPLOYEES_IN_CONTEXT);
    const truncated = context.employees.length > MAX_EMPLOYEES_IN_CONTEXT;
    lines.push(
      `\nEmployee allowlist (name | wallet | group)${truncated ? ` — showing first ${MAX_EMPLOYEES_IN_CONTEXT} of ${context.employees.length}` : ''}:`
    );
    list.forEach(e => {
      lines.push(`  • ${e.fullName} | ${e.walletAddress} | ${e.group ?? 'No Group'}`);
    });
    if (truncated) {
      lines.push(`  … and ${context.employees.length - MAX_EMPLOYEES_IN_CONTEXT} more employees not shown here.`);
    }
  }

  if (context.tokenRegistry) {
    lines.push(`\nSupported tokens (from registry):`);
    lines.push(context.tokenRegistry);
  }

  return lines.filter(Boolean).join('\n');
}

export async function POST(req: NextRequest) {
  try {
    // Guard: fail fast with a clear error if the key is missing
    if (!process.env.GOOGLE_AI_API_KEY) {
      return NextResponse.json(
        { error: 'AI Agent is not configured. GOOGLE_AI_API_KEY is missing.' },
        { status: 503 }
      );
    }

    const { messages, walletAddress, context } = await req.json();

    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: 'Messages array required' }, { status: 400 });
    }

    // Enforce server-side limits — client cap is 100 but we also gate here
    if (messages.length > MAX_MESSAGES) {
      return NextResponse.json(
        { error: `Too many messages. Maximum ${MAX_MESSAGES} allowed per request.` },
        { status: 400 }
      );
    }

    // Validate each message content length
    for (const msg of messages) {
      if (typeof msg.content !== 'string') {
        return NextResponse.json({ error: 'Invalid message content' }, { status: 400 });
      }
      if (msg.content.length > MAX_MSG_CHARS) {
        return NextResponse.json(
          { error: `Message too long. Maximum ${MAX_MSG_CHARS} characters per message.` },
          { status: 400 }
        );
      }
    }

    const genAI = await getGenAI();
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { maxOutputTokens: 1024, temperature: 0.7, topP: 0.9 },
    });

    // Build runtime context — passes full employee allowlist + token registry
    // to make guardrails 1 (address allowlist) and 4 (no assumption) effective
    const runtimeContext = buildRuntimeContext({
      employeeCount: context?.employeeCount ?? 0,
      employees:     context?.employees     ?? [],
      agentActive:   context?.agentActive,
      agentAddress:  context?.agentAddress,
      walletAddress,
      tokenRegistry: context?.tokenRegistry,
    });

    const systemInstruction = SYSTEM_PROMPT + runtimeContext;

    // Gemini only accepts 'user' and 'model' roles in history.
    // Filter out 'system' role messages and skip the last message (sent separately).
    const history = messages
      .slice(0, -1)
      .filter((m: { role: string; content: string }) =>
        m.role === 'user' || m.role === 'assistant'
      )
      .map((m: { role: string; content: string }) => ({
        role:  m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const lastMessage = messages[messages.length - 1];

    // Ensure last message is from user — Gemini requires this
    if (lastMessage.role !== 'user') {
      return NextResponse.json(
        { error: 'Last message must be from user' },
        { status: 400 }
      );
    }

    const chat = model.startChat({ history, systemInstruction });

    const result = await chat.sendMessageStream(lastMessage.content);

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of result.stream) {
            const text = chunk.text();
            if (text) {
              const data = JSON.stringify({
                choices: [{ delta: { content: text } }],
              });
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            }
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection':    'keep-alive',
        'X-Accel-Buffering': 'no',  // disable Nginx buffering for streams
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
