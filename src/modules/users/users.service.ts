// Neonfi backend — Users module: service layer (Stage 2).
//
// Stage 3B: toUserDTO is now async (queries subscription for plan/billingCycle).
// getMe and updateMe are both async accordingly.

import { toUserDTO, updateProfile, deleteUser, type UserDTO, type UserWithRelations } from './users.repository.js';
import type { PatchMeBody, PatchPreferencesBody } from './users.schemas.js';
import { getEffectivePlan, cancelSubscription } from '../subscriptions/subscriptions.service.js';

export async function getMe(user: UserWithRelations): Promise<{ user: UserDTO }> {
  return { user: await toUserDTO(user) };
}

export async function updateMe(
  user: UserWithRelations,
  body: PatchMeBody,
): Promise<{ user: UserDTO }> {
  if (Object.keys(body).length === 0) {
    return { user: await toUserDTO(user) };
  }
  const updated = await updateProfile(user.id, body);
  return { user: await toUserDTO(updated) };
}

export async function updatePreferences(
  user: UserWithRelations,
  body: PatchPreferencesBody,
): Promise<{ user: UserDTO }> {
  if (Object.keys(body).length === 0) {
    return { user: await toUserDTO(user) };
  }
  const updated = await updateProfile(user.id, body);
  return { user: await toUserDTO(updated) };
}

// ---------------------------------------------------------------------------
// deleteMe — DELETE /users/me (account deletion, hard delete).
// ---------------------------------------------------------------------------

export async function deleteMe(user: UserWithRelations): Promise<{ deleted: boolean }> {
  // If the user has an effectively-active Pro subscription, cancel it at Stripe
  // first so deletion doesn't leave a live paid subscription billing a deleted
  // user. Reuse the subscriptions service (no duplicated Stripe logic); Free/no-sub
  // users skip. cancelSubscription is idempotent for already-cancelled subs, and
  // getEffectivePlan returns 'free' for expired subs — so none of cancelSubscription's
  // guard errors (NO_SUBSCRIPTION/CANNOT_CANCEL_FREE/EXPIRED) are reachable here.
  const plan = await getEffectivePlan(user.id);
  if (plan === 'pro') {
    await cancelSubscription(user);
  }

  // DB cascades remove sessions/portfolios/subscription/snapshots; Payment FKs
  // (userId + subscriptionId) SetNull so payment history survives (retrofit-5 delta A).
  await deleteUser(user.id);
  return { deleted: true };
}
