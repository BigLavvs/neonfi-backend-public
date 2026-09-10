import { randomBytes } from 'node:crypto';
import { redis } from '../../lib/redis.js';
import { signAccessToken } from '../../lib/jwt.js';
import { findActiveSessionsByUser, findSessionById, revokeSession } from '../users/users.repository.js';
import { AuthError } from './auth.shared.private.js';

export interface SessionItem {
  id: number;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
  current: boolean;
}

export async function listSessions(
  userId: number,
  currentSessionId: number,
): Promise<SessionItem[]> {
  const sessions = await findActiveSessionsByUser(userId);
  return sessions.map((s) => ({
    id: s.id,
    ipAddress: s.ipAddress,
    userAgent: s.userAgent,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    current: s.id === currentSessionId,
  }));
}

// ---------------------------------------------------------------------------
// revokeSessionById — ownership check then revoke; 403 prevents enumeration
// ---------------------------------------------------------------------------

export async function revokeSessionById(
  sessionId: number,
  currentUserId: number,
  currentSessionId: number,
): Promise<{ loggedOut: boolean }> {
  const session = await findSessionById(sessionId);

  // Uniform 403 for not-found or wrong user (§3.4 — no enumeration leak)
  if (!session || session.userId !== currentUserId) {
    throw new AuthError(403, 'FORBIDDEN', 'Session not found or access denied');
  }

  // Idempotent: already-revoked sessions succeed without error
  if (!session.revokedAt) {
    await revokeSession(session.id);
  }

  return { loggedOut: session.id === currentSessionId };
}

// ---------------------------------------------------------------------------
// issueWsTicket — 32-byte opaque ticket stored in Redis for 60 s
// ---------------------------------------------------------------------------

export async function issueWsTicket(
  userId: number,
  sessionId: number,
): Promise<{ token: string }> {
  const token = randomBytes(32).toString('base64url');
  await redis.set(`ws_ticket:${token}`, `${userId}:${sessionId}`, 'EX', 60);
  return { token };
}

