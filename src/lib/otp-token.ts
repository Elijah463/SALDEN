/**
 * @file lib/otp-token.ts
 *
 * Stateless HMAC-based OTP verification.
 * Works on Vercel, Netlify, AWS Lambda, Cloudflare Workers — ANY serverless
 * platform. No shared state (Redis, DB) required.
 *
 * Flow:
 *   1. send-otp  → generateSecureOTP() + createOTPToken() → send email + return token to client
 *   2. client    → stores token (sessionStorage) + submits token + typed OTP to verify-otp
 *   3. verify-otp → verifyOTPToken() validates HMAC signature + expiry + OTP hash (timing-safe)
 *
 * Security properties:
 *   - HMAC-SHA256 prevents token forgery (requires OTP_SECRET)
 *   - OTP stored as SHA-256 hash inside token (not plaintext)
 *   - Both HMAC and OTP comparisons use crypto.timingSafeEqual (fixes timing attack)
 *   - 10-minute expiry baked into signed payload
 *   - No shared state — any Lambda instance can verify
 */

import crypto from 'crypto';

function getSecret(): string {
  const secret = process.env.OTP_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('OTP_SECRET env var is required and must be at least 32 characters');
  }
  return secret;
}

/** Cryptographically secure 6-digit OTP using rejection sampling — no modulo bias */
export function generateSecureOTP(): string {
  // Rejection sampling: discard values in the biased tail of the UInt32 range.
  // Accepted range: 0 to (floor(2^32 / 900000) * 900000 - 1) = 0..4294500000-1
  const MAX_SAFE = Math.floor(2 ** 32 / 900000) * 900000; // 4_294_500_000

  while (true) {
    const buf = crypto.randomBytes(4);
    const val = buf.readUInt32BE(0);
    if (val < MAX_SAFE) {
      return (100000 + (val % 900000)).toString();
    }
    // val ≥ MAX_SAFE (probability ~0.0001%) — retry for uniform distribution
  }
}

/** Create a signed token containing a hash of the OTP + expiry + email */
export function createOTPToken(email: string, otp: string): string {
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
  const otpHash   = crypto.createHash('sha256').update(otp).digest('hex');

  const payload = Buffer.from(
    JSON.stringify({ e: email.toLowerCase().trim(), h: otpHash, x: expiresAt })
  ).toString('base64url');

  const sig = crypto
    .createHmac('sha256', getSecret())
    .update(payload)
    .digest('base64url');

  return `${payload}.${sig}`;
}

export interface VerifyResult {
  valid:   boolean;
  error?:  string;
}

/** Verify a token + submitted OTP using timing-safe comparison throughout */
export function verifyOTPToken(
  token:        string,
  email:        string,
  submittedOTP: string
): VerifyResult {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return { valid: false, error: 'Invalid token format.' };

    const [payload, sig] = parts;

    // 1. Verify HMAC signature — timing-safe
    const expectedSig    = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
    const sigBuf         = Buffer.from(sig,         'base64url');
    const expectedSigBuf = Buffer.from(expectedSig, 'base64url');

    if (
      sigBuf.length !== expectedSigBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expectedSigBuf)
    ) {
      return { valid: false, error: 'Invalid or tampered token.' };
    }

    // 2. Decode payload
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      e: string; h: string; x: number;
    };

    // 3. Check email matches
    if (data.e !== email.toLowerCase().trim()) {
      return { valid: false, error: 'Token does not match this email address.' };
    }

    // 4. Check expiry
    if (Date.now() > data.x) {
      return { valid: false, error: 'Code has expired. Request a new one.' };
    }

    // 5. Compare OTP hash — timing-safe
    const submittedHash = crypto
      .createHash('sha256')
      .update(submittedOTP.trim())
      .digest('hex');

    const submittedBuf = Buffer.from(submittedHash, 'hex');
    const storedBuf    = Buffer.from(data.h,        'hex');

    if (
      submittedBuf.length !== storedBuf.length ||
      !crypto.timingSafeEqual(submittedBuf, storedBuf)
    ) {
      return { valid: false, error: 'Incorrect code. Please try again.' };
    }

    return { valid: true };
  } catch (err) {
    // Log internal details for diagnostics while returning a safe user-facing message
    console.error('[otp-token] verifyOTPToken error:', err instanceof Error ? err.message : err);
    return { valid: false, error: 'Token verification failed.' };
  }
}
