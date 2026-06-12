// Neonfi backend — Auth module: requireAuth middleware (Stage 1A).
//
// Reads the `session` HttpOnly cookie (JWT access token), verifies it, loads
// the Session row and User, and attaches them to the Hono context.
//
// Stage 3B: AuthVariables gains an optional `subscription` field set by
// requirePlan (not requireAuth) for plan-gated routes.

import type { Context, Next, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { err } from '../../lib/envelope.js';
import { verifyAccessToken, JWTExpired } from '../../lib/jwt.js';
import { findSessionById, findUserById } from '../users/users.repository.js';
import type { UserWithRelations, Session } from '../users/users.repository.js';
import type { SubscriptionWithRelations } from '../subscriptions/subscriptions.dto.js';

export interface AuthVariables {
  user: UserWithRelations;
  session: Session;
  subscription?: SubscriptionWithRelations;  // set by requirePlan, not requireAuth
}

export type AuthEnv = { Variables: AuthVariables };

export const requireAuth: MiddlewareHandler<AuthEnv> = async (
  c: Context<AuthEnv>,
  next: Next,
) => {
  const token = getCookie(c, 'session');
  if (!token) {
    return c.json(err('UNAUTHENTICATED', 'Authentication required'), 401);
  }

  let payload;
  try {
    payload = await verifyAccessToken(token);
  } catch (e) {
    if (e instanceof JWTExpired) {
      return c.json(err('ACCESS_TOKEN_EXPIRED', 'Access token has expired'), 401);
    }
    return c.json(err('UNAUTHENTICATED', 'Invalid authentication token'), 401);
  }

  const session = await findSessionById(payload.sid);
  if (!session || session.revokedAt !== null || session.expiresAt < new Date()) {
    return c.json(err('SESSION_EXPIRED', 'Session has expired or been revoked'), 401);
  }

  const userId = parseInt(payload.sub!, 10);
  const user = await findUserById(userId);
  if (!user) {
    return c.json(err('UNAUTHENTICATED', 'User not found'), 401);
  }

  c.set('user', user);
  c.set('session', session);
  await next();
};
