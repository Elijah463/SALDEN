import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Simple transparent pricing. Start free with the shared payroll contract. Upgrade once for $10 USDC, lifetime Salden Pro access.',
  openGraph: {
    title:       'Salden Pricing, Free & Salden Pro Plans',
    description: 'Start free. Upgrade once for $10 USDC and get your own private payroll contract, AI Agent, and unlimited tokens, forever.',
    images:      [{ url: '/images/og-image.jpg', width: 1512, height: 756 }],
  },
  twitter: {
    card:        'summary_large_image',
    title:       'Salden Pricing, Free & Salden Pro',
    description: 'One-time $10 USDC for lifetime Salden Pro access to your private on-chain payroll contract.',
    images:      ['/images/og-image.jpg'],
  },
};

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
