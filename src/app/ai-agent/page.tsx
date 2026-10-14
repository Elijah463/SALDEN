'use client';
/**
 * @file app/ai-agent/page.tsx
 * IRIS: the agent chat. Open to every signed-in wallet. Free wallets can
 * chat about Arc Network payments with a message allowance; Salden Pro
 * wallets can also run agent actions. Activation lives at /ai-agent/activation.
 */
import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { AgentScreen } from '@/components/agent/AgentScreen';

export default function IrisPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Loader2 size={24} color="#4F46E5" /></div>}>
      <AgentScreen mode="chat" />
    </Suspense>
  );
}
