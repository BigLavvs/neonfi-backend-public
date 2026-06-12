// Neonfi backend — Users module: service layer (Stage 2).
//
// Stage 3B: toUserDTO is now async (queries subscription for plan/billingCycle).
// getMe and updateMe are both async accordingly.

import { toUserDTO, updateProfile, type UserDTO, type UserWithRelations } from './users.repository.js';
import type { PatchMeBody } from './users.schemas.js';

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
