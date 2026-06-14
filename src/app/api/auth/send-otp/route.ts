/**
 * @file app/api/auth/send-otp/route.ts
 * Generates a secure OTP, signs it into a stateless HMAC token,
 * sends the OTP to the user's email, and returns the token to the client.
 * The token is required for verification — no server state involved.
 */

import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';
import { generateSecureOTP, createOTPToken } from '@/lib/otp-token';

// Email-based rate limiter — 3 OTPs per email per 5 minutes
const RATE_MAP   = new Map<string, { count: number; resetAt: number }>();
// IP-based rate limiter — 10 OTP requests per IP per 10 minutes
const IP_RATE_MAP = new Map<string, { count: number; resetAt: number }>();

const RATE_LIMIT      = 3;
const RATE_WINDOW     = 5 * 60 * 1000;
const IP_RATE_LIMIT   = 10;
const IP_RATE_WINDOW  = 10 * 60 * 1000;

function checkRateLimit(email: string): boolean {
  const now    = Date.now();
  const record = RATE_MAP.get(email);
  if (!record || now > record.resetAt) {
    RATE_MAP.set(email, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (record.count >= RATE_LIMIT) return false;
  record.count += 1;
  return true;
}

function checkIPRateLimit(ip: string): boolean {
  const now    = Date.now();
  const record = IP_RATE_MAP.get(ip);
  if (!record || now > record.resetAt) {
    IP_RATE_MAP.set(ip, { count: 1, resetAt: now + IP_RATE_WINDOW });
    return true;
  }
  if (record.count >= IP_RATE_LIMIT) return false;
  record.count += 1;
  return true;
}

function getResend(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not configured');
  return new Resend(key);
}

export async function POST(req: NextRequest) {
  try {
    // IP-based rate limit (before reading body — prevents request body parsing abuse)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!checkIPRateLimit(ip)) {
      return NextResponse.json(
        { error: 'Too many requests from this IP. Please wait before trying again.' },
        { status: 429 }
      );
    }

    const { email } = await req.json();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return NextResponse.json({ error: 'Valid email address required' }, { status: 400 });
    }

    // Rate limit check
    if (!checkRateLimit(email.toLowerCase())) {
      return NextResponse.json(
        { error: 'Too many code requests. Please wait 5 minutes before trying again.' },
        { status: 429 }
      );
    }

    const otp   = generateSecureOTP();
    const token = createOTPToken(email, otp);  // stateless — no server storage

    await getResend().emails.send({
      from:    'Salden <noreply@salden.xyz>',
      to:      [email],
      subject: 'Your Salden Login Code',
      html: `
        <div style="font-family:'Plus Jakarta Sans',system-ui,sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:32px;">
            <img src="${process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.salden.xyz'}/logo.svg" alt="Salden" width="36" height="36" style="object-fit:contain;display:block;" />
            <span style="font-size:18px;font-weight:800;letter-spacing:0.08em;color:#4F46E5;">SALDEN</span>
          </div>
          <h1 style="font-size:24px;font-weight:800;color:#0F172A;margin-bottom:8px;">Your login code</h1>
          <p style="color:#64748B;font-size:15px;margin-bottom:28px;line-height:1.6;">
            Enter this code to sign in to your Salden account. It expires in 10 minutes.
          </p>
          <div style="background:#EEF2FF;border-radius:14px;padding:24px;text-align:center;margin-bottom:28px;">
            <div style="font-size:42px;font-weight:800;letter-spacing:0.25em;color:#4F46E5;font-family:'Courier New',monospace;">
              ${otp}
            </div>
          </div>
          <p style="color:#94A3B8;font-size:13px;line-height:1.6;">
            If you did not request this code, you can safely ignore this email.
          </p>
          <hr style="border:none;border-top:1px solid #E2E8F0;margin:28px 0;" />
          <p style="color:#CBD5E1;font-size:12px;">
            Salden &middot; Onchain Payroll &middot; Arc Testnet &middot;
            <a href="https://salden.xyz" style="color:#94A3B8;">salden.xyz</a>
          </p>
        </div>
      `,
    });

    // Return token to client — client stores it and sends with OTP on verify
    return NextResponse.json({
      success: true,
      token,
      message: 'Code sent',
    });
  } catch (err) {
    console.error('[send-otp] Error:', err);
    const message = err instanceof Error ? err.message : 'Failed to send code';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
