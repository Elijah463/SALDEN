import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Dashboard',
  description: 'Manage your employees, run batch payroll, and track your payroll contract status.',
  openGraph: {
    title:       'Salden — HR Dashboard',
    description: 'Manage employees and run on-chain batch payroll.',
    images:      [{ url: '/images/og-image.jpg', width: 1512, height: 756 }],
  },
  twitter: {
    card:   'summary_large_image',
    title:  'Salden — HR Dashboard',
    images: ['/images/og-image.jpg'],
  },
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
