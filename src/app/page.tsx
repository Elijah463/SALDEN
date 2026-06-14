import { redirect } from 'next/navigation';

/**
 * Root route — redirects to /dashboard.
 * The marketing site lives at www.salden.xyz.
 * The app entry point is app.salden.xyz/dashboard.
 */
export default function RootPage() {
  redirect('/dashboard');
}
