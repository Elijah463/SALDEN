/**
 * @file app/api/agent/quota/route.ts
 *
 * Read-only free-tier quota check. Lets the client find out it's locked
 * out of the chat BEFORE it ever shows the composer, instead of only
 * discovering it after the person types a message and sends it. Without
 * this, a refresh or a brand-new chat always rendered an unlocked composer
 * for a split second (or indefinitely, if the lock state only lived in
 * local component state), which looked like "the timeout isn't enforced"
 * even though /api/agent/chat was still correctly refusing to process any
 * further free message.
 *
 * Reads the SAME server-side counter consumeFreeMessage() reads (see
 * lib/agent/tier.ts, getFreeStatus), so this can never be more lenient
 * than the actual enforcement on /api/agent/chat, it's a peek at the real
 * count, not a separate client-controlled flag. A wallet cannot clear
 * this by refreshing, opening a new tab, or starting a new chat: the
 * count is keyed by wallet address and time window on the server, not by
 * anything the client holds.
 */
import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '@/lib/agent/auth';
import { isProWallet, getFreeStatus, FREE_MESSAGE_LIMIT } from '@/lib/agent/tier';

export async function GET(req: NextRequest) {
  try {
    const walletAddress = req.nextUrl.searchParams.get('walletAddress');
    if (!walletAddress) {
      return NextResponse.json({ error: 'walletAddress is required.' }, { status: 400 });
    }

    const authHeader = req.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const session = verifySessionToken(token, walletAddress);
    if (!session.ok) {
      return NextResponse.json({ error: 'Your session has expired. Please sign in again.' }, { status: 401 });
    }

    const pro = await isProWallet(walletAddress);
    if (pro) {
      return NextResponse.json({ pro: true, freeLimitReached: false });
    }

    const quota = await getFreeStatus(walletAddress);
    return NextResponse.json({
      pro: false,
      freeLimitReached: quota.limitReached,
      remaining: quota.remaining,
      limit: FREE_MESSAGE_LIMIT,
      retryAfterSeconds: quota.limitReached ? quota.retryAfterSeconds : undefined,
    });
  } catch {
    // Fails open on the QUOTA check only (a transient error here just means
    // the composer briefly renders as if unlocked); the real gate on
    // /api/agent/chat still fails closed and will refuse the message.
    return NextResponse.json({ pro: false, freeLimitReached: false });
  }
}
