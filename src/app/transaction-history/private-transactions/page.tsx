'use client';
/**
 * @file app/transaction-history/private-transactions/page.tsx
 * Placeholder — private transactions are not implemented yet.
 */

import { ArrowLeft, Lock } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';

export default function PrivateTransactionsPage() {
  return (
    <AppLayout title="Private Transactions">
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <a href="/transaction-history" style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, color: '#64748B',
          fontSize: 13, fontWeight: 500, textDecoration: 'none', marginBottom: 16,
        }}>
          <ArrowLeft size={15} /> Back to Transaction History
        </a>

        <div style={{
          background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16,
          padding: '56px 24px', textAlign: 'center',
        }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14, background: '#F1F5F9',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
          }}>
            <Lock size={26} color="#64748B" />
          </div>
          <p style={{ fontSize: 16, fontWeight: 700, color: '#0F172A' }}>
            Private Transactions are currently not supported
          </p>
        </div>
      </div>
    </AppLayout>
  );
}
