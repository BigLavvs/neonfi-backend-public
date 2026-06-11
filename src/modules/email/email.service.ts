// Neonfi backend — Email module: transactional email via Resend (Build Guide
// Stage 15 / stage-1a.md §5).
//
// Stage 1A provides two emails only: welcome and email-verification.
// Stage 15 extends this module with subscription-confirmation, payment-receipt,
// refund, and cancellation emails plus retry logic.
//
// Contract: every exported function is FIRE-AND-FORGET — it NEVER throws.
// Callers run it in a background void block after the DB transaction commits so
// an email failure cannot break the HTTP response (§2.9 async/non-blocking).
//
// If Resend returns 403 ("domain not verified"), a clear console.error is
// emitted so the developer knows to either verify neonfi.live on Resend or
// switch EMAIL_FROM_ADDRESS to onboarding@resend.dev.  Do NOT change .env
// programmatically.

import { config } from '../../lib/config.js';

interface SendResult {
  outcome: 'success' | 'failed';
  error?: string;
}

async function send(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  template: string;
}): Promise<SendResult> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.EMAIL_FROM_ADDRESS,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      if (res.status === 403) {
        console.error(
          `[email] Resend returned 403 — domain may not be verified. ` +
          `Verify neonfi.live on Resend, or set EMAIL_FROM_ADDRESS=onboarding@resend.dev for dev. ` +
          `Body: ${body}`,
        );
      }
      const error = `HTTP ${res.status}: ${body}`;
      console.error(
        '[email]',
        JSON.stringify({ event: 'email_sent', template: opts.template, to: opts.to, outcome: 'failed', error }),
      );
      return { outcome: 'failed', error };
    }

    console.log(
      '[email]',
      JSON.stringify({ event: 'email_sent', template: opts.template, to: opts.to, outcome: 'success' }),
    );
    return { outcome: 'success' };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(
      '[email]',
      JSON.stringify({ event: 'email_sent', template: opts.template, to: opts.to, outcome: 'failed', error }),
    );
    return { outcome: 'failed', error };
  }
}

export async function sendWelcomeEmail(opts: {
  to: string;
  fullName: string;
}): Promise<void> {
  await send({
    to: opts.to,
    template: 'welcome',
    subject: 'Welcome to Neonfi',
    html: `
      <p>Hi ${opts.fullName},</p>
      <p>Welcome to Neonfi! We're excited to have you on board.</p>
      <p>Please check your inbox for a separate email to verify your email address.</p>
    `,
    text:
      `Hi ${opts.fullName},\n\nWelcome to Neonfi!\n\n` +
      `Please check your inbox for a separate email to verify your email address.`,
  });
}

export async function sendVerificationEmail(opts: {
  to: string;
  fullName: string;
  verificationUrl: string;
}): Promise<void> {
  await send({
    to: opts.to,
    template: 'email_verification',
    subject: 'Verify your Neonfi email address',
    html: `
      <p>Hi ${opts.fullName},</p>
      <p>Please verify your email address by clicking the link below:</p>
      <p><a href="${opts.verificationUrl}">${opts.verificationUrl}</a></p>
      <p>This link expires in 24 hours.</p>
    `,
    text:
      `Hi ${opts.fullName},\n\nPlease verify your email address by visiting:\n${opts.verificationUrl}\n\nThis link expires in 24 hours.`,
  });
}
