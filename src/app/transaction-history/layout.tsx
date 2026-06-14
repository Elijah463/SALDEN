import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Transaction History',
  description: 'View all your Onchain payroll transactions, download PDF receipts, and resend invoice emails.',
  openGraph: {
    title:       'Salden — Transaction History',
    description: 'Full Onchain payroll transaction history with receipts and invoice emails.',
    images:      [{ url: '/images/og-image.jpg', width: 1512, height: 756 }],
  },
  twitter: {
    card:   'summary_large_image',
    title:  'Salden — Transaction History',
    images: ['/images/og-image.jpg'],
  },
};

export default function TransactionHistoryLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
