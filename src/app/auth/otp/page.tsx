/**
 * @file app/auth/otp/page.tsx
 * OTP verification page.
 * useSearchParams() requires a Suspense boundary in Next.js App Router.
 * The inner component reads params; the outer export wraps it in Suspense.
 */

import { Suspense } from 'react';
import { OTPForm } from './OTPForm';
import { SaldenLogo } from '@/components/shared/Logo';
import { Loader2 } from 'lucide-react';

function LoadingFallback() {
  return (
    <div style={{
      minHeight: '100vh', background: '#F8F9FA',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 16,
    }}>
      <SaldenLogo size={34} />
      <Loader2 size={24} color="#4F46E5" style={{ animation: 'spin 0.7s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export default function OTPPage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <OTPForm />
    </Suspense>
  );
}
