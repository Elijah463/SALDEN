/**
 * @file lib/agent/tools.ts
 * SERVER-SIDE ONLY.
 *
 * Real Gemini function-calling tool declarations. This replaces the old
 * design where the model wrote bracket markers like
 * [PAY_UNLISTED_REQUEST:0x...:100:USDC] into free text that the server
 * then regex-parsed. That approach had a real failure mode: if the
 * response got cut off at the 512-token cap mid-marker, parsing silently
 * broke. Function calling returns structured JSON for tool calls as a
 * distinct response part — it isn't subject to text-truncation corruption
 * the same way, and Gemini won't emit a call missing a required argument.
 *
 * Two kinds of tools:
 *   - "Read" tools (get_balance, check_ofac_compliance,
 *     get_transaction_status) — actually execute server-side and return a
 *     real result to the model in the same turn.
 *   - "Propose" tools (request_faucet, propose_unlisted_payment,
 *     propose_add_employee, propose_payroll_run) — validated server-side,
 *     then surfaced to the client as a structured event requiring a real
 *     user action (button click + wallet signature for anything
 *     fund-moving). The model is told the proposal was queued, not that
 *     it executed.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchemaTypeEnum = any;

// Cached once per process — symmetric with getGenAI() in chat/route.ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _toolDeclarations: any[] | null = null;

export async function getToolDeclarations() {
  if (_toolDeclarations) return _toolDeclarations;
  const { SchemaType } = await import('@google/generative-ai');
  const T = SchemaType as SchemaTypeEnum;

  // Assign to variable FIRST, then cache, then return.
  // The previous version returned the array inline which made the cache
  // assignment unreachable dead code — every request did the dynamic import.
  const declarations = [
    {
      functionDeclarations: [
        {
          name: 'get_balance',
          description: 'Reads a REAL on-chain token balance for the employer wallet or the agent wallet. Always use this instead of guessing a balance.',
          parameters: {
            type: T.OBJECT,
            properties: {
              walletType: { type: T.STRING, description: "Either 'employer' or 'agent'." },
              token:      { type: T.STRING, description: "Token symbol (e.g. 'USDC') or 'native' for the chain's gas token." },
            },
            required: ['walletType', 'token'],
          },
        },
        {
          name: 'check_ofac_compliance',
          description: 'Screens a wallet address against a sanctions list. Always use this instead of assuming an address is clean.',
          parameters: {
            type: T.OBJECT,
            properties: { address: { type: T.STRING, description: 'Full checksummed 0x address to screen.' } },
            required: ['address'],
          },
        },
        {
          name: 'get_transaction_status',
          description: 'Looks up the REAL on-chain status of a transaction hash (success, reverted, pending, or not found).',
          parameters: {
            type: T.OBJECT,
            properties: { txHash: { type: T.STRING, description: 'Full 66-character transaction hash starting with 0x.' } },
            required: ['txHash'],
          },
        },
        {
          name: 'request_faucet',
          description: "Requests testnet USDC from Circle's faucet for the employer wallet or the agent wallet (Arc Testnet only, 20 USDC per address per 2 hours).",
          parameters: {
            type: T.OBJECT,
            properties: { address: { type: T.STRING, description: 'The exact employer or agent wallet address from the runtime context — never fabricate an address.' } },
            required: ['address'],
          },
        },
        {
          name: 'propose_unlisted_payment',
          description:
            'Proposes a payment to an address NOT currently in the employee database. This does NOT execute anything — it only queues a confirmation card requiring the human to click Confirm and sign with their wallet. Only call this once you have the full address, amount, and token explicitly from the user.',
          parameters: {
            type: T.OBJECT,
            properties: {
              address: { type: T.STRING, description: 'Full checksummed 0x address.' },
              amount:  { type: T.STRING, description: 'Numeric amount as a plain string, e.g. "150" or "150.5". Never calculate this yourself — use exactly what the user said.' },
              token:   { type: T.STRING, description: "Token symbol, e.g. 'USDC'." },
            },
            required: ['address', 'amount', 'token'],
          },
        },
        {
          name: 'propose_add_employee',
          description:
            'Proposes saving a new employee to the IPFS database and updating the on-chain CID pointer via SaldenRegistry.updateCID(). This does NOT execute anything — it queues a confirmation card requiring the human to click Confirm. The agent must have been granted the Agent role via addAgent() on the Registry clone before updateCID() will succeed. Only call this after the user has explicitly agreed to save and you have all five fields.',
          parameters: {
            type: T.OBJECT,
            properties: {
              address:    { type: T.STRING, description: 'Full checksummed 0x address.' },
              fullName:   { type: T.STRING, description: "Employee's full name." },
              department: { type: T.STRING, description: 'Org function, e.g. Legal, Marketing, CSO. Distinct from group.' },
              group:      { type: T.STRING, description: 'Payroll/work classification, e.g. Remote Workers, Contractors. Distinct from department.' },
              salary:     { type: T.STRING, description: 'Numeric salary amount as a plain string.' },
            },
            required: ['address', 'fullName', 'department', 'group', 'salary'],
          },
        },
        {
          name: 'propose_payroll_run',
          description:
            'Proposes running payroll for a specific employee group. This does NOT execute anything — it gives the user a link to the dashboard with that group pre-selected, where they review and sign the transaction themselves. Only call this once the group is unambiguous (see Guardrail 4) — if the user said "everyone" or a group name that does not exactly match one in the database, ask first instead of calling this. Use this (never execute_payroll_run) whenever the instruction leaves ANY room for interpretation.',
          parameters: {
            type: T.OBJECT,
            properties: { group: { type: T.STRING, description: 'The exact group name as it appears in the employee database, or "All Employees".' } },
            required: ['group'],
          },
        },
        {
          name: 'execute_payment',
          description:
            'Autonomously sends a payment RIGHT NOW from the AI Agent\'s own wallet — no human confirmation card, no human signature. This actually moves real funds. Only call this when the user\'s instruction is 100% explicit and unambiguous about the recipient, amount, and token, AND clearly means "do this now" rather than asking a question or thinking out loud. If there is ANY doubt about intent, recipient, amount, or token, use propose_unlisted_payment instead — do not guess. This can fail if the agent wallet itself lacks funds; if it does, tell the user plainly and suggest they fund the agent wallet from the Agent Wallet page.',
          parameters: {
            type: T.OBJECT,
            properties: {
              address: { type: T.STRING, description: 'Full checksummed 0x address of the recipient.' },
              amount:  { type: T.STRING, description: 'Numeric amount as a plain string, e.g. "150" or "150.5". Never calculate this yourself — use exactly what the user said.' },
              token:   { type: T.STRING, description: "Token symbol, e.g. 'USDC'." },
            },
            required: ['address', 'amount', 'token'],
          },
        },
        {
          name: 'execute_payroll_run',
          description:
            'Autonomously runs payroll RIGHT NOW for a specific employee group, paid from the AI Agent\'s own wallet — no human confirmation card, no human signature. This actually moves real funds to every employee in the group. Only call this when the group is unambiguous AND the user\'s instruction clearly means "run this now" — if the user said "everyone" without it matching a real group, or seems to be asking rather than instructing, use propose_payroll_run instead. This can fail if the agent wallet itself lacks funds; if it does, tell the user plainly and suggest they fund the agent wallet from the Agent Wallet page.',
          parameters: {
            type: T.OBJECT,
            properties: { group: { type: T.STRING, description: 'The exact group name as it appears in the employee database, or "All Employees".' } },
            required: ['group'],
          },
        },
        {
          name: 'execute_edit_employee',
          description:
            'Updates an existing employee\'s salary, department, group, or wallet address IMMEDIATELY — no confirmation card. Only call this when the user\'s instruction is fully explicit: the exact employee is identified (by name or address) AND the exact field(s) and new value(s) are stated clearly. If which employee, which field, or the new value is ambiguous in any way, use propose_edit_employee instead — never guess. Only include the fields that are actually changing.',
          parameters: {
            type: T.OBJECT,
            properties: {
              currentAddress: { type: T.STRING, description: 'The existing employee\'s current wallet address, exactly as it appears in the database — used to find the record.' },
              fullName:       { type: T.STRING, description: 'New full name, only if changing.' },
              department:     { type: T.STRING, description: 'New department, only if changing.' },
              group:          { type: T.STRING, description: 'New group, only if changing.' },
              salary:         { type: T.STRING, description: 'New numeric salary, only if changing.' },
              newAddress:     { type: T.STRING, description: 'New wallet address, only if changing.' },
            },
            required: ['currentAddress'],
          },
        },
        {
          name: 'propose_edit_employee',
          description:
            'Proposes updating an existing employee\'s salary, department, group, or wallet address — queues a confirmation card the human must approve, exactly like propose_add_employee. Use this whenever which employee, which field, or the new value is ambiguous, or the user seems to be asking rather than instructing. Only include the fields that are actually changing.',
          parameters: {
            type: T.OBJECT,
            properties: {
              currentAddress: { type: T.STRING, description: 'The existing employee\'s current wallet address, exactly as it appears in the database — used to find the record.' },
              fullName:       { type: T.STRING, description: 'New full name, only if changing.' },
              department:     { type: T.STRING, description: 'New department, only if changing.' },
              group:          { type: T.STRING, description: 'New group, only if changing.' },
              salary:         { type: T.STRING, description: 'New numeric salary, only if changing.' },
              newAddress:     { type: T.STRING, description: 'New wallet address, only if changing.' },
            },
            required: ['currentAddress'],
          },
        },
        {
          name: 'propose_remove_employee',
          description:
            'Proposes removing an employee from the database. This ALWAYS requires human confirmation via a confirmation card — never treat any instruction to remove/delete/fire an employee as something to skip confirmation for, no matter how explicit the wording. This does NOT execute anything itself.',
          parameters: {
            type: T.OBJECT,
            properties: {
              address:  { type: T.STRING, description: 'The employee\'s wallet address, exactly as it appears in the database.' },
              fullName: { type: T.STRING, description: 'The employee\'s full name, for display on the confirmation card.' },
            },
            required: ['address', 'fullName'],
          },
        },
        {
          name: 'propose_bulk_add_employees',
          description:
            'Proposes adding MULTIPLE employees at once — use this after extracting employee data from an uploaded document/image (a roster, spreadsheet screenshot, offer letters, etc). Shows the user a single card listing everything extracted so they can review before anything is written to the database. Only include employees where you have a full name, a valid-looking wallet address, and a salary — never invent or guess a missing field; leave that employee out and tell the user what was missing instead.',
          parameters: {
            type: T.OBJECT,
            properties: {
              employees: {
                type: T.ARRAY,
                items: {
                  type: T.OBJECT,
                  properties: {
                    fullName:   { type: T.STRING },
                    walletAddress: { type: T.STRING },
                    department: { type: T.STRING },
                    group:      { type: T.STRING },
                    salary:     { type: T.STRING },
                  },
                  required: ['fullName', 'walletAddress', 'salary'],
                },
              },
            },
            required: ['employees'],
          },
        },
        {
          name: 'execute_bulk_add_employees',
          description:
            'Adds MULTIPLE employees IMMEDIATELY, no confirmation card — only call this when the user gave an explicit, unambiguous instruction to add them right away (e.g. "add all of these now", "yes add them" after you already listed the extracted data and they clearly said to proceed). If the user hasn\'t yet seen and approved the extracted list, use propose_bulk_add_employees instead so they can review it first.',
          parameters: {
            type: T.OBJECT,
            properties: {
              employees: {
                type: T.ARRAY,
                items: {
                  type: T.OBJECT,
                  properties: {
                    fullName:   { type: T.STRING },
                    walletAddress: { type: T.STRING },
                    department: { type: T.STRING },
                    group:      { type: T.STRING },
                    salary:     { type: T.STRING },
                  },
                  required: ['fullName', 'walletAddress', 'salary'],
                },
              },
            },
            required: ['employees'],
          },
        },
      ],
    },
  ];
  _toolDeclarations = declarations;
  return _toolDeclarations;
}
