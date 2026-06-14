import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AI Agent',
  description: 'Your autonomous AI Payroll Agent. Schedule runs, check compliance, and execute Onchain payroll automatically.',
  openGraph: {
    title:       'Salden — AI Payroll Agent',
    description: 'Autonomous Onchain payroll scheduling and execution.',
    images:      [{ url: '/images/og-image.jpg', width: 1512, height: 756 }],
  },
  twitter: {
    card:   'summary_large_image',
    title:  'Salden — AI Payroll Agent',
    images: ['/images/og-image.jpg'],
  },
};

export default function AIAgentLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
