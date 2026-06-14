/**
 * @file app/api/invoice/send/route.ts
 * Sends a payroll invoice email via Resend from noreply@salden.xyz.
 * Called from the Transaction History page.
 */

import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';
import { isValidEthAddress } from '@/lib/validation';

function getResend(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not configured');
  return new Resend(key);
}

export async function POST(req: NextRequest) {
  try {
    const { txHash, walletAddress, recipientEmail, recipientCount, amount, token } = await req.json();

    // Basic auth: require valid wallet address and tx hash
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return NextResponse.json({ error: 'Valid transaction hash required' }, { status: 400 });
    }
    if (!walletAddress || !isValidEthAddress(walletAddress)) {
      return NextResponse.json({ error: 'Valid wallet address required' }, { status: 400 });
    }

    const toEmail = recipientEmail ?? process.env.NEXT_PUBLIC_FROM_EMAIL ?? 'noreply@salden.xyz';
    const date    = new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'long', year: 'numeric' });

    await getResend().emails.send({
      from:    'Salden Payroll <noreply@salden.xyz>',
      to:      [toEmail],
      subject: `Payroll Invoice — ${date}`,
      html: `
        <div style="font-family: 'Plus Jakarta Sans', system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 24px; background: #F8F9FA;">
          <div style="background: #fff; border-radius: 20px; padding: 36px; border: 1px solid #E2E8F0;">

            <!-- Header -->
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 32px;">
              <div style="width: 36px; height: 36px; background: #4F46E5; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                <span style="color: white; font-weight: 800; font-size: 18px;">S</span>
              </div>
              <span style="font-size: 18px; font-weight: 800; letter-spacing: 0.08em; color: #4F46E5;">SALDEN</span>
              <span style="margin-left: auto; font-size: 12px; color: #94A3B8;">PAYROLL INVOICE</span>
            </div>

            <!-- Amount -->
            <div style="background: #EEF2FF; border-radius: 14px; padding: 24px; margin-bottom: 28px; text-align: center;">
              <div style="font-size: 13px; color: #64748B; margin-bottom: 6px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;">
                Total Disbursed
              </div>
              <div style="font-size: 36px; font-weight: 800; color: #4F46E5; font-family: monospace;">
                ${amount ?? '—'} ${token ?? 'USDC'}
              </div>
              <div style="font-size: 13px; color: #64748B; margin-top: 6px;">
                ${recipientCount ?? '—'} recipient${(recipientCount ?? 0) !== 1 ? 's' : ''}
              </div>
            </div>

            <!-- Details -->
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 28px;">
              ${[
                ['Date',           date                                    ],
                ['From Wallet',    `${walletAddress.slice(0,8)}…${walletAddress.slice(-6)}`],
                ['Transaction',    `${txHash.slice(0,12)}…${txHash.slice(-6)}`             ],
                ['Network',        'Arc Testnet (Chain ID 23295)'          ],
                ['Token',          token ?? 'USDC'                         ],
              ].map(([label, value]) => `
                <tr>
                  <td style="padding: 10px 0; border-bottom: 1px solid #F1F5F9; font-size: 13px; color: #64748B; font-weight: 600; width: 40%;">${label}</td>
                  <td style="padding: 10px 0; border-bottom: 1px solid #F1F5F9; font-size: 13px; color: #0F172A; font-family: monospace;">${value}</td>
                </tr>
              `).join('')}
            </table>

            <!-- Verify link -->
            <a href="https://testnet.arcscan.app/tx/${txHash}"
              style="display: block; text-align: center; padding: 12px; border-radius: 10px;
                     background: #4F46E5; color: #fff; text-decoration: none;
                     font-size: 14px; font-weight: 600; margin-bottom: 24px;">
              Verify on ArcScan
            </a>

            <!-- Footer -->
            <p style="font-size: 12px; color: #94A3B8; text-align: center; margin: 0; line-height: 1.7;">
              This invoice was generated automatically by Salden Payroll.<br/>
              <a href="https://salden.xyz" style="color: #94A3B8;">salden.xyz</a> ·
              <a href="${process.env.NEXT_PUBLIC_APP_URL}/privacy" style="color: #94A3B8;">Privacy</a> ·
              <a href="${process.env.NEXT_PUBLIC_APP_URL}/terms" style="color: #94A3B8;">Terms</a>
            </p>
          </div>
        </div>
      `,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to send invoice';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
