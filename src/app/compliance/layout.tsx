import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Compliance',
  description: 'Real-time payroll compliance screening — OFAC checks, address validation, contract health, and registry sync status.',
  openGraph: {
    title:       'Salden — Compliance Dashboard',
    description: 'Real-time OFAC screening, address validation, and contract health monitoring for Onchain payroll.',
    images:      [{ url: '/images/og-image.jpg', width: 1512, height: 756 }],
  },
  twitter: {
    card:   'summary_large_image',
    title:  'Salden — Compliance',
    images: ['/images/og-image.jpg'],
  },
};

export default function ComplianceLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
