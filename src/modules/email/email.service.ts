// Neonfi backend — Email module: transactional email via Resend (Build Guide
// Stage 15 / stage-1a.md §5).
//
// Contract: every exported function is FIRE-AND-FORGET — it NEVER throws.
// Callers run it in a background void block after the DB transaction commits so
// an email failure cannot break the HTTP response.

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

export async function sendPasswordResetEmail(opts: {
  to: string;
  fullName: string;
  resetUrl: string;
}): Promise<void> {
  await send({
    to: opts.to,
    template: 'password_reset',
    subject: 'Reset your Neonfi password',
    html: `
      <p>Hi ${opts.fullName},</p>
      <p>We received a request to reset your password. Click the link below to choose a new one:</p>
      <p><a href="${opts.resetUrl}">${opts.resetUrl}</a></p>
      <p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
    `,
    text:
      `Hi ${opts.fullName},\n\nWe received a request to reset your password. Visit the link below to choose a new one:\n${opts.resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can safely ignore this email.`,
  });
}

export async function sendSubscriptionConfirmationEmail(opts: {
  to: string;
  fullName: string;
  plan: string;
}): Promise<void> {
  const planLabel = opts.plan === 'pro' ? 'Pro' : 'Free';
  await send({
    to: opts.to,
    template: 'subscription_confirmation',
    subject: `Your Neonfi ${planLabel} plan is now active`,
    html: `
      <p>Hi ${opts.fullName},</p>
      <p>Your Neonfi <strong>${planLabel}</strong> subscription is confirmed and active.</p>
      <p>Head to your dashboard to get started.</p>
    `,
    text:
      `Hi ${opts.fullName},\n\nYour Neonfi ${planLabel} subscription is confirmed and active.\n\nHead to your dashboard to get started.`,
  });
}

export async function sendUpgradeEmail(opts: {
  to: string;
  fullName: string;
  newPlan: string;
  newBillingCycle: string;
}): Promise<void> {
  const cycleLabel = opts.newBillingCycle === 'yearly' ? 'Yearly' : 'Monthly';
  await send({
    to: opts.to,
    template: 'upgrade_confirmation',
    subject: `Your Neonfi plan was upgraded to Pro ${cycleLabel}`,
    html: `
      <p>Hi ${opts.fullName},</p>
      <p>Your Neonfi subscription has been upgraded to <strong>Pro ${cycleLabel}</strong>.</p>
      <p>The change takes effect immediately.</p>
    `,
    text:
      `Hi ${opts.fullName},\n\nYour Neonfi subscription has been upgraded to Pro ${cycleLabel}.\n\nThe change takes effect immediately.`,
  });
}

export async function sendDowngradeScheduledEmail(opts: {
  to: string;
  fullName: string;
  scheduledPlan: string | null;
  scheduledBillingCycle: string | null;
  effectiveDate: Date;
}): Promise<void> {
  const target = opts.scheduledPlan === 'free'
    ? 'Free plan'
    : `Pro ${opts.scheduledBillingCycle === 'yearly' ? 'Yearly' : 'Monthly'}`;
  const dateStr = opts.effectiveDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  await send({
    to: opts.to,
    template: 'downgrade_scheduled',
    subject: `Your Neonfi subscription change is scheduled`,
    html: `
      <p>Hi ${opts.fullName},</p>
      <p>Your subscription will change to <strong>${target}</strong> on ${dateStr}.</p>
      <p>You'll continue to enjoy your current plan until that date.</p>
    `,
    text:
      `Hi ${opts.fullName},\n\nYour subscription will change to ${target} on ${dateStr}.\n\nYou'll continue to enjoy your current plan until that date.`,
  });
}

export async function sendCancellationScheduledEmail(opts: {
  to: string;
  fullName: string;
  effectiveDate: Date;
}): Promise<void> {
  const dateStr = opts.effectiveDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  await send({
    to: opts.to,
    template: 'cancellation_scheduled',
    subject: 'Your Neonfi subscription has been cancelled',
    html: `
      <p>Hi ${opts.fullName},</p>
      <p>Your subscription has been cancelled and will expire on ${dateStr}.</p>
      <p>You'll continue to have access until then.</p>
    `,
    text:
      `Hi ${opts.fullName},\n\nYour subscription has been cancelled and will expire on ${dateStr}.\n\nYou'll continue to have access until then.`,
  });
}

export async function sendPaymentReceiptEmail(opts: {
  to: string;
  fullName: string;
  amount: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<void> {
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const amountFormatted = (opts.amount / 100).toFixed(2);
  await send({
    to: opts.to,
    template: 'payment_receipt',
    subject: 'Your Neonfi payment receipt',
    html: `
      <p>Hi ${opts.fullName},</p>
      <p>Payment of ${opts.currency.toUpperCase()} ${amountFormatted} received.</p>
      <p>Billing period: ${fmt(opts.periodStart)} – ${fmt(opts.periodEnd)}.</p>
    `,
    text:
      `Hi ${opts.fullName},\n\nPayment of ${opts.currency.toUpperCase()} ${amountFormatted} received.\n\nBilling period: ${fmt(opts.periodStart)} – ${fmt(opts.periodEnd)}.`,
  });
}

export async function sendPaymentFailedEmail(opts: {
  to: string;
  fullName: string;
  retryAt: Date | null;
}): Promise<void> {
  const retryStr = opts.retryAt
    ? `Stripe will retry on ${opts.retryAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.`
    : 'Stripe will retry automatically.';
  await send({
    to: opts.to,
    template: 'payment_failed',
    subject: 'Your Neonfi payment failed',
    html: `
      <p>Hi ${opts.fullName},</p>
      <p>We were unable to process your payment. ${retryStr}</p>
      <p>Please update your payment method if needed.</p>
    `,
    text:
      `Hi ${opts.fullName},\n\nWe were unable to process your payment. ${retryStr}\n\nPlease update your payment method if needed.`,
  });
}

export async function sendRefundConfirmationEmail(opts: {
  to: string;
  fullName: string;
  amount: number;
  currency: string;
}): Promise<void> {
  const amountFormatted = (opts.amount / 100).toFixed(2);
  await send({
    to: opts.to,
    template: 'refund_confirmation',
    subject: 'Your Neonfi refund has been processed',
    html: `
      <p>Hi ${opts.fullName},</p>
      <p>Your refund of ${opts.currency.toUpperCase()} ${amountFormatted} has been processed.</p>
      <p>It may take 5–10 business days to appear on your statement.</p>
    `,
    text:
      `Hi ${opts.fullName},\n\nYour refund of ${opts.currency.toUpperCase()} ${amountFormatted} has been processed.\n\nIt may take 5–10 business days to appear on your statement.`,
  });
}

export async function sendSubscriptionExpiredEmail(opts: {
  to: string;
  fullName: string;
}): Promise<void> {
  await send({
    to: opts.to,
    template: 'subscription_expired',
    subject: 'Your Neonfi subscription has expired',
    html: `
      <p>Hi ${opts.fullName},</p>
      <p>Your Neonfi Pro subscription has expired.</p>
      <p>You can reactivate at any time from your account settings.</p>
    `,
    text:
      `Hi ${opts.fullName},\n\nYour Neonfi Pro subscription has expired.\n\nYou can reactivate at any time from your account settings.`,
  });
}

export async function sendPlanDowngradeAppliedEmail(opts: {
  to: string;
  fullName: string;
  newPlan: string;
}): Promise<void> {
  const planLabel = opts.newPlan === 'free' ? 'Free' : 'Pro';
  await send({
    to: opts.to,
    template: 'plan_downgrade_applied',
    subject: `Your Neonfi plan has changed to ${planLabel}`,
    html: `
      <p>Hi ${opts.fullName},</p>
      <p>Your scheduled plan change has been applied — you are now on the <strong>${planLabel}</strong> plan.</p>
    `,
    text:
      `Hi ${opts.fullName},\n\nYour scheduled plan change has been applied — you are now on the ${planLabel} plan.`,
  });
}
