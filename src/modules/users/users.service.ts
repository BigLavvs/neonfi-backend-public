// Neonfi backend — Users module: service layer (Stage 2).
//
// Owns the profile read + profile update logic. Deliberately thin:
// - GET /users/me needs no DB round-trip (user already on context from middleware)
// - PATCH /users/me delegates to updateProfile() in the repository
//
// plan + billingCycle are null until Stage 3 wires up Subscription rows.
// No emails are sent from any function here.

import { toUserDTO, updateProfile, type UserDTO, type UserWithRelations } from './users.repository.js';
import type { PatchMeBody } from './users.schemas.js';

export function getMe(user: UserWithRelations): { user: UserDTO } {
  return { user: toUserDTO(user) };
}

export async function updateMe(
  user: UserWithRelations,
  body: PatchMeBody,
): Promise<{ user: UserDTO }> {
  if (Object.keys(body).length === 0) {
    return { user: toUserDTO(user) };
  }
  const updated = await updateProfile(user.id, body);
  return { user: toUserDTO(updated) };
}
