// Neonfi backend — Users module: data-access layer for User and Session tables.
//
// toUserDTO: centralises Gate C (displayName, not name) and Gate D
// (emailVerified derived as onboardingStatus !== 'pending_verification').
// Stage 3B: toUserDTO is now async — it queries Subscription to populate
// plan/billingCycle. Uses the "effectively active" rule: active OR
// (cancelled AND currentPeriodEnd > now).

import { type Prisma, type Session } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

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
  tx?: Prisma.TransactionClient,
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
  },
): Promise<UserWithRelations> {
  return prisma.user.update({
    where: { id: userId },
    data,
    ...USER_INCLUDE,
  });
}
