import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Settings',
  description: 'Manage your company profile, employee groups, smart contract configuration, and account preferences.',
  openGraph: {
    title:       'Salden — Settings',
    description: 'Configure your Salden payroll account, company profile, and contract settings.',
    images:      [{ url: '/images/og-image.jpg', width: 1512, height: 756 }],
  },
  robots: { index: false, follow: false }, // Settings shouldn't be indexed
};

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
