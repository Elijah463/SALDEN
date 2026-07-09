/**
 * @file lib/inngest/client.ts
 * SERVER-SIDE ONLY.
 *
 * Single shared Inngest client (TypeScript SDK v4 — confirmed against
 * npm/the v4 migration guide before writing this; v4 went GA March 16,
 * 2026 and is what `npm install inngest@latest` resolves to as of this
 * writing, currently 4.5.1). Mirrors the pattern already used for the
 * viem public client in lib/agent/chain.ts — one client, imported
 * everywhere that needs it, never re-constructed per-request.
 *
 * ── Why Inngest replaces Vercel Cron here ──────────────────────────────
 * Vercel's Hobby plan silently coerces every cron schedule expression to
 * "once a day" (see Vercel's own cron docs), regardless of what's in
 * vercel.json. This app's payment schedules need checking every 15
 * minutes, so Vercel Cron alone cannot do this on Hobby. Inngest's own
 * cron trigger runs on Inngest's infrastructure and hits this app's
 * /api/inngest endpoint on the real schedule, independent of Vercel's
 * plan-tier cron throttling — Vercel here is just the compute the
 * function body runs on, not what's doing the scheduling.
 *
 * ── Auth ─────────────────────────────────────────────────────────────
 * Per the v4 migration guide, signingKey/eventKey now live on the CLIENT
 * (they used to be passed to serve()/InngestCommHandler in v3). Neither
 * is passed explicitly below — both are read automatically from the
 * standard INNGEST_SIGNING_KEY / INNGEST_EVENT_KEY environment variables,
 * which are already set in this project's Vercel env per the request
 * that prompted this file. If those env vars are ever renamed/removed,
 * this client (and everything built on it) breaks with an explicit
 * "signing key is required" error at call time — not a silent failure.
 *
 * ── Checkpointing / Vercel timeout interaction ─────────────────────────
 * v4 enables checkpointing by default, which lets multiple steps execute
 * within a single HTTP request to /api/inngest instead of one round-trip
 * per step. On a serverless host this needs an explicit `maxRuntime`
 * slightly below that route's actual `maxDuration` so the SDK yields
 * control back to Inngest (which simply schedules a follow-up request)
 * before Vercel kills the function outright. See
 * app/api/inngest/route.ts for the matching `maxDuration = 60` — 45s
 * here leaves headroom under that on Vercel's Hobby/Pro default. If you
 * move this project to a plan with a longer function timeout, raise both
 * numbers together (keep maxRuntime at roughly 70-80% of maxDuration).
 */

import { Inngest } from 'inngest';

export const inngest = new Inngest({
  id: 'salden',
  checkpointing: {
    maxRuntime: '45s',
  },
});
