/**
 * @file app/api/inngest/route.ts
 * Inngest's HTTP endpoint — this is what Inngest calls (both to discover
 * this app's functions on deploy/sync, and to actually invoke them on
 * cron ticks / events). Must live at exactly this path for Inngest's
 * automated discovery; see lib/inngest/client.ts for why this replaces
 * the old Vercel-Cron-triggered app/api/agent/cron/run-schedules/route.ts.
 *
 * maxDuration/checkpointing note: the client's `checkpointing.maxRuntime`
 * (lib/inngest/client.ts) is set to 45s, intentionally a bit below the
 * `maxDuration` below, so the SDK yields control back to Inngest (which
 * simply schedules a follow-up call) before Vercel would kill the
 * function outright. If this project's Vercel plan changes to allow
 * longer function durations, raise both together (keep maxRuntime at
 * ~70-80% of maxDuration) rather than just one.
 */

import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { inngestFunctions } from '@/lib/inngest/functions';

export const maxDuration = 60;

export const { GET, POST, PUT } = serve({
  client:    inngest,
  functions: inngestFunctions,
});
