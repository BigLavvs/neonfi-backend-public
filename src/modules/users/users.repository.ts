// Neonfi backend — Users module: data-access layer for User and Session tables.
//
// toUserDTO: centralises Gate C (displayName, not name) and Gate D
// (emailVerified derived as onboardingStatus !== 'pending_verification').
// Stage 3B: toUserDTO is now async — it queries Subscription to populate
// plan/billingCycle. Uses the "effectively active" rule: active OR
// (cancelled AND currentPeriodEnd > now).

import { type Prisma, type Session } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '../../lib/prisma.js';

// ---------------------------------------------------------------------------
// User with relations
// ---------------------------------------------------------------------------

export type UserWithRelations = Prisma.UserGetPayload<{
  include: { authProvider: true; onboardingStatus: true };
}>;

const USER_INCLUDE = {
  include: { authProvider: true, onboardingStatus: true },
} as const satisfies Prisma.UserDefaultArgs;

export interface UserDTO {
  id: number;
  email: string;
  fullName: string;
  displayName: string | null;
  avatarUrl: string | null;
  authProvider: string;
  /** Gate D: derived — onboardingStatus.name !== 'pending_verification'. */
  emailVerified: boolean;
  onboardingStatus: string;
  plan: string | null;
  billingCycle: string | null;
  newsletterSubscribed: boolean;
  // retrofit-5: notification/display preferences (settings Preferences tab).
  priceAlertsEnabled: boolean;
  pushEnabled: boolean;
  baseCurrency: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function toUserDTO(user: UserWithRelations): Promise<UserDTO> {
  const subscription = await prisma.subscription.findUnique({
    where: { userId: user.id },
    include: { plan: true, billingCycle: true, status: true },
  });

  const now = new Date();
  const effectivelyActive =
    subscription !== null &&
    (subscription.status.name === 'active' ||
      (subscription.status.name === 'cancelled' &&
        subscription.currentPeriodEnd !== null &&
        subscription.currentPeriodEnd > now));

  const plan = effectivelyActive ? (subscription!.plan.name as 'free' | 'pro') : null;
  const billingCycle = effectivelyActive ? (subscription!.billingCycle?.name ?? null) : null;

  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    authProvider: user.authProvider.name,
    emailVerified: user.onboardingStatus.name !== 'pending_verification',
    onboardingStatus: user.onboardingStatus.name,
    plan,
    billingCycle,
    newsletterSubscribed: user.newsletterSubscribed,
    priceAlertsEnabled: user.priceAlertsEnabled,
    pushEnabled: user.pushEnabled,
    baseCurrency: user.baseCurrency,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// User queries
// ---------------------------------------------------------------------------

export async function findUserByEmail(
  email: string,
): Promise<UserWithRelations | null> {
  return prisma.user.findUnique({ where: { email }, ...USER_INCLUDE });
}

export async function findUserById(
  id: number,
): Promise<UserWithRelations | null> {
  return prisma.user.findUnique({ where: { id }, ...USER_INCLUDE });
}

export async function createUser(data: {
  email: string;
  passwordHash: string;
  fullName: string;
  displayName?: string | null;
  authProviderId: number;
  onboardingStatusId: number;
}): Promise<UserWithRelations> {
  return prisma.user.create({ data, ...USER_INCLUDE });
}

export async function updateUserOnboardingStatus(
  userId: number,
  statusName: string,
): Promise<UserWithRelations> {
  const status = await prisma.onboardingStatus.findUniqueOrThrow({
    where: { name: statusName },
  });
  return prisma.user.update({
    where: { id: userId },
    data: { onboardingStatusId: status.id },
    ...USER_INCLUDE,
  });
}

// retrofit-6: set a new bcrypt password hash (password-reset confirm flow).
export async function updatePassword(
  userId: number,
  passwordHash: string,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });
}

// ---------------------------------------------------------------------------
// Session queries
// ---------------------------------------------------------------------------

export { type Session };

export async function createSession(data: {
  userId: number;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: Date;
  refreshTokenHash: string;
}): Promise<Session> {
  return prisma.session.create({ data });
}

export async function findSessionById(id: number): Promise<Session | null> {
  return prisma.session.findUnique({ where: { id } });
}

export async function findSessionByRefreshHash(
  hash: string,
): Promise<Session | null> {
  return prisma.session.findUnique({ where: { refreshTokenHash: hash } });
}

export async function revokeSession(id: number): Promise<void> {
  await prisma.session.update({
    where: { id },
    data: { revokedAt: new Date() },
  });
}

// Refresh-token rotation (audit SEC, decision 7). Atomically swap the session's
// refreshTokenHash to a freshly-issued one and slide the absolute expiry, but ONLY if the
// row still carries `oldHash` and is not revoked. The conditional updateMany makes two
// concurrent refreshes with the same token safe: exactly one wins (count===1) and mints the
// new token; the loser sees count===0 and is rejected — so a single refresh token can never
// be exchanged for two live tokens. Returns true when this caller won the rotation.
export async function rotateSessionRefreshHash(
  sessionId: number,
  oldHash: string,
  newHash: string,
  expiresAt: Date,
): Promise<boolean> {
  const result = await prisma.session.updateMany({
    where: { id: sessionId, refreshTokenHash: oldHash, revokedAt: null },
    data: { refreshTokenHash: newHash, expiresAt },
  });
  return result.count === 1;
}

// retrofit-6: bulk-revoke every live session for a user. Used by the
// password-reset confirm flow so a reset locks out any attacker session.
export async function revokeAllSessionsForUser(userId: number): Promise<void> {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function findActiveSessionsByUser(userId: number): Promise<Session[]> {
  return prisma.session.findMany({
    where: {
      userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// Onboarding transitions (called by subscriptions module during activation)
// ---------------------------------------------------------------------------

export async function transitionToCompleteOnboarding(
  userId: number,
  tx?: PrismaTransactionClient,
): Promise<void> {
  // Use the main prisma client for the lookup — static seed data, safe outside tx.
  // Keeps the transaction query count low to avoid Neon's P2028 timeout.
  const status = await prisma.onboardingStatus.findUniqueOrThrow({ where: { name: 'complete' } });
  const client = tx ?? prisma;
  await client.user.update({
    where: { id: userId },
    data: { onboardingStatusId: status.id },
  });
}

// ---------------------------------------------------------------------------
// Profile update
// ---------------------------------------------------------------------------

export async function updateProfile(
  userId: number,
  data: {
    fullName?: string;
    displayName?: string | null;
    avatarUrl?: string | null;
    newsletterSubscribed?: boolean;
    // retrofit-5: preference fields, written by updatePreferences (PATCH /users/preferences).
    priceAlertsEnabled?: boolean;
    pushEnabled?: boolean;
    baseCurrency?: string;
  },
): Promise<UserWithRelations> {
  return prisma.user.update({
    where: { id: userId },
    data,
    ...USER_INCLUDE,
  });
}

// ---------------------------------------------------------------------------
// Account deletion (retrofit-5)
// ---------------------------------------------------------------------------

// Hard-deletes the user row. DB cascades remove sessions/portfolios/subscription/
// snapshots; Payment.userId and Payment.subscriptionId are SetNull, so payment
// history survives with both FKs null (accounting). Any active Stripe subscription
// must be cancelled by the caller BEFORE this (see users.service.deleteMe).
export async function deleteUser(userId: number): Promise<void> {
  await prisma.user.delete({ where: { id: userId } });
}
