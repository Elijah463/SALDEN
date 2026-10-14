'use client';
/**
 * Thinking state for IRIS. Shows a refined orbit mark, a soft shimmer and a
 * quiet status line. The line steps through stages that match the kind of
 * request the user sent, so it reads like progress, e.g.
 * "Checking balances" then "Proposing transaction to your wallet".
 *
 * These are stage estimates, not live server events. The chat endpoint returns
 * one response when the work is done, so the stages advance on a timer. The
 * indicator unmounts when the reply arrives, which removes it entirely.
 */
import { useEffect, useMemo, useState } from 'react';

type Stage = string[];

const STAGES = {
  payment: [
    'Reading your request',
    'Checking balances',
    'Validating recipients',
    'Preparing the transaction',
    'Proposing transaction to your wallet',
  ],
  schedule: [
    'Reading your request',
    'Checking the payroll schedule',
    'Preparing the schedule',
    'Proposing schedule for your approval',
  ],
  employees: [
    'Reading your request',
    'Checking employee records',
    'Preparing the changes',
    'Proposing changes for your approval',
  ],
  compliance: [
    'Reading your request',
    'Running compliance checks',
    'Summarising the results',
  ],
  general: [
    'Reading your request',
    'Thinking it through',
    'Writing a response',
  ],
} satisfies Record<string, Stage>;

/** Picks the stage list from the user's message. Order matters: the first
 *  matching group wins, so compliance and schedule are checked before payment. */
export function pickStages(userText: string): Stage {
  const t = userText.toLowerCase();
  if (/ofac|sanction|compliance|screen/.test(t))                  return STAGES.compliance;
  if (/schedul|recurring|every month|monthly|each month|weekly/.test(t)) return STAGES.schedule;
  if (/employee|add .* to|remove|group|department|salary of|edit/.test(t)) return STAGES.employees;
  if (/pay|send|transfer|swap|bridge|usdc|eurc|run payroll|payroll run|deposit/.test(t)) return STAGES.payment;
  return STAGES.general;
}

const STEP_MS = 1500;

export default function AgentThinking({ userText = '', status }: { userText?: string; status?: string }) {
  const stages = useMemo(() => pickStages(userText), [userText]);
  const [index, setIndex] = useState(0);
  const live = Boolean(status);

  useEffect(() => {
    if (live || index >= stages.length - 1) return;
    const t = setTimeout(() => setIndex(i => Math.min(i + 1, stages.length - 1)), STEP_MS);
    return () => clearTimeout(t);
  }, [index, stages, live]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 28 }}>
      <div aria-hidden className="iris-orbit" style={{ position: 'relative', width: 22, height: 22, flexShrink: 0 }}>
        <span className="iris-orbit-ring" />
        <span className="iris-orbit-core" />
      </div>
      <span
        key={live ? `live-${status}` : index}
        className="iris-thought"
        role="status"
        aria-live="polite"
      >
        {live ? status : stages[index]}
      </span>
      <style>{`
        .iris-orbit-ring {
          position: absolute; inset: 0; border-radius: 50%;
          background: conic-gradient(from 0deg, rgba(79,70,229,0), #4F46E5, #14B8A6, rgba(20,184,166,0), rgba(79,70,229,0));
          -webkit-mask: radial-gradient(circle, transparent 58%, #000 60%);
          mask: radial-gradient(circle, transparent 58%, #000 60%);
          animation: irisSpin 1.6s linear infinite;
        }
        .iris-orbit-core {
          position: absolute; inset: 7px; border-radius: 50%;
          background: #4F46E5;
          box-shadow: 0 0 12px rgba(79,70,229,0.45);
          animation: irisBreathe 2.2s ease-in-out infinite;
        }
        .iris-thought {
          font-size: 13px; font-weight: 400; letter-spacing: 0.1px; color: transparent;
          background: linear-gradient(90deg, #94A3B8 0%, #475569 45%, #94A3B8 90%);
          background-size: 220% 100%;
          -webkit-background-clip: text; background-clip: text;
          animation: irisFadeIn 380ms ease-out both, irisShimmer2 2.6s linear infinite;
        }
        @keyframes irisSpin { to { transform: rotate(360deg); } }
        @keyframes irisBreathe {
          0%, 100% { transform: scale(0.92); opacity: 0.85; }
          50%      { transform: scale(1.05); opacity: 1; }
        }
        @keyframes irisShimmer2 {
          0%   { background-position: 120% 0; }
          100% { background-position: -120% 0; }
        }
        @keyframes irisFadeIn {
          from { opacity: 0; transform: translateY(3px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .iris-orbit-ring, .iris-orbit-core, .iris-thought { animation: none; }
        }
      `}</style>
    </div>
  );
}
