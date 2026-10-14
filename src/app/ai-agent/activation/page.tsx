'use client';
/**
 * @file app/ai-agent/activation/page.tsx
 * Agent Activation: Salden Pro upgrade gate, one-time agent setup, and the
 * on-chain role grants. Everything that changes what the agent is allowed to do.
 */
import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { AgentScreen } from '@/components/agent/AgentScreen';

export default function AgentActivationPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Loader2 size={24} color="#4F46E5" /></div>}>
      <AgentScreen mode="activation" />
    </Suspense>
  );
}
