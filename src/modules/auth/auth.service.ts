// Neonfi backend — Auth module: service layer (Stage 1A).
//
// Architecture:
//   - auth module owns NO tables; it orchestrates users module + email module.
//   - All DB access goes through users.repository; this file contains only
//     business logic and orchestration.
//   - AuthError carries HTTP status + code so controllers stay thin.
//   - Refresh tokens: opaque 32-byte base64url; stored as SHA-256 hex hash in
//     Session.refreshTokenHash (§1.2). Raw token lives only in HttpOnly cookie.
//   - Non-rotating refresh (§1.6): same Session row, same refresh cookie, new
//     access token JWT on each /auth/refresh call.
//     TODO(post-MVP security review): implement refresh-token rotation — each
//     /auth/refresh should generate a new refresh token + hash, invalidate old.

import { createHash, randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { config, isProduction } from '../../lib/config.js';
import { redis } from '../../lib/redis.js';
import { signAccessToken } from '../../lib/jwt.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { recordFailedLogin, clearLockout, getLockoutState } from '../../lib/lockout.js';
import { parseDurationToMs } from '../../lib/duration.js';
import { prisma } from '../../lib/prisma.js';
import {
  findUserByEmail,
  findUserById,
  toUserDTO,
  createSession,
  findSessionById,
  findSessionByRefreshHash,
  revokeSession,
  findActiveSessionsByUser,
  type UserDTO,
  type UserWithRelations,
} from '../users/users.repository.js';
import { sendWelcomeEmail, sendVerificationEmail } from '../email/email.service.js';
import type {
  RegisterBody,
  LoginBody,
  VerifyEmailBody,
  ResendVerificationBody,
} from './auth.schemas.js';

// ---------------------------------------------------------------------------
// Shared error type
// ---------------------------------------------------------------------------

export class AuthError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

// ---------------------------------------------------------------------------
// Crypto helpers (private to this module)
// ---------------------------------------------------------------------------

function sha256hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function makeRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: sha256hex(raw) };
}

function makeVerificationToken(): string {
  return randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

export async function register(body: RegisterBody): Promise<{ user: UserDTO }> {
  // Uniqueness check before the insert to give a clear error code.
  // P2002 from Prisma is a fallback if a concurrent request races past here.
  const existing = await findUserByEmail(body.email);
  if (existing) {
    throw new AuthError(409, 'EMAIL_ALREADY_REGISTERED', 'An account with this email already exists');
  }

  // Resolve lookup-table FKs (seeded rows; throw if missing — seeding issue)
  const [authProvider, onboardingStatus] = await Promise.all([
    prisma.authProvider.findUniqueOrThrow({ where: { name: 'email' } }),
    prisma.onboardingStatus.findUniqueOrThrow({ where: { name: 'pending_verification' } }),
  ]);

  const passwordHash = await hashPassword(body.password);

  const user = await prisma.user.create({
    data: {
      email: body.email,
      passwordHash,
      fullName: body.fullName,
      displayName: body.displayName ?? null,
      authProviderId: authProvider.id,
      onboardingStatusId: onboardingStatus.id,
    },
    include: { authProvider: true, onboardingStatus: true },
  });

  // Fire-and-forget after the DB commit. Failures are logged but must not
  // break the registration response (§2.9 async/non-blocking).
  void (async () => {
    try {
      const token = makeVerificationToken();
      await redis.set(`email_verify:${token}`, String(user.id), 'EX', 86400);
      const verificationUrl = `${config.APP_BASE_URL}/verify-email?token=${token}`;
      // Log the URL so dev can test without waiting for email delivery. Never in
      // production — the URL carries a single-use verification token and would let
      // anyone with Coolify log access verify any user's email (A11).
      if (!isProduction) {
        console.log(`[auth] verification URL for ${user.email}: ${verificationUrl}`);
      }
      await sendWelcomeEmail({ to: user.email, fullName: user.fullName });
      await sendVerificationEmail({ to: user.email, fullName: user.fullName, verificationUrl });
    } catch (e) {
      console.error('[auth] register post-commit failed', e instanceof Error ? e.message : e);
    }
  })();

  return { user: await toUserDTO(user) };
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

export async function login(
  body: LoginBody,
  ip: string | null,
  userAgent: string | null,
): Promise<{ user: UserDTO; accessToken: string; refreshToken: string }> {
  // 1. Lockout check before any DB lookup (avoid leaking timing via DB query)
  const lockout = await getLockoutState(body.email);
  if (lockout.locked) {
    throw new AuthError(423, 'ACCOUNT_LOCKED', 'Account temporarily locked due to too many failed attempts', {
      retryAfterMs: lockout.ttlMs,
    });
  }

  // 2–3. Uniform error for "user not found" and "wrong password" to prevent
  //      email enumeration attacks.
  const user = await findUserByEmail(body.email);
  if (!user) {
    await recordFailedLogin(body.email);
    throw new AuthError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  if (!user.passwordHash) {
    // Google-only account — no password set; treat same as wrong credentials.
    await recordFailedLogin(body.email);
    throw new AuthError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const passwordOk = await verifyPassword(body.password, user.passwordHash);
  if (!passwordOk) {
    await recordFailedLogin(body.email);
    throw new AuthError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  // 4. Successful auth — clear lockout counter.
  await clearLockout(body.email);

  // 5. Create session
  const { raw: refreshToken, hash: refreshTokenHash } = makeRefreshToken();
  const expiresAt = new Date(Date.now() + parseDurationToMs(config.REFRESH_TOKEN_EXPIRY));

  const session = await createSession({
    userId: user.id,
    ipAddress: ip,
    userAgent,
    expiresAt,
    refreshTokenHash,
  });

  // 6. Issue access token JWT
  const accessToken = await signAccessToken({ userId: user.id, sessionId: session.id });

  return { user: await toUserDTO(user), accessToken, refreshToken };
}

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

export async function logout(sessionToken: string | null): Promise<void> {
  if (!sessionToken) return;
  try {
    // Import verifyAccessToken lazily to avoid circular — jwt is a leaf module.
    const { verifyAccessToken } = await import('../../lib/jwt.js');
    const payload = await verifyAccessToken(sessionToken);
    const session = await findSessionById(payload.sid);
    if (session && !session.revokedAt) {
      await revokeSession(session.id);
    }
  } catch {
    // Token invalid or already revoked — logout is idempotent, no error.
  }
}

// ---------------------------------------------------------------------------
// verifyEmail
// ---------------------------------------------------------------------------

export async function verifyEmail(
  body: VerifyEmailBody,
): Promise<{ user: UserDTO } | { alreadyVerified: true }> {
  // Atomic single-use: GETDEL returns the value and deletes the key in one op.
  const userIdStr = await redis.getdel(`email_verify:${body.token}`);
  if (!userIdStr) {
    throw new AuthError(400, 'INVALID_VERIFICATION_TOKEN', 'Verification token is invalid or has expired');
  }

  const userId = parseInt(userIdStr, 10);
  const user = await findUserById(userId);
  if (!user) {
    // Should not happen; user was deleted after token was issued.
    throw new AuthError(400, 'INVALID_VERIFICATION_TOKEN', 'Verification token is invalid or has expired');
  }

  // Idempotent — already verified users get a success response without re-writing.
  if (user.onboardingStatus.name !== 'pending_verification') {
    return { alreadyVerified: true };
  }

  // Transition pending_verification → verified
  const updated = await (async () => {
    const status = await prisma.onboardingStatus.findUniqueOrThrow({ where: { name: 'verified' } });
    return prisma.user.update({
      where: { id: userId },
      data: { onboardingStatusId: status.id },
      include: { authProvider: true, onboardingStatus: true },
    });
  })();

  return { user: await toUserDTO(updated) };
}

// ---------------------------------------------------------------------------
// resendVerification
// ---------------------------------------------------------------------------

export async function resendVerification(body: ResendVerificationBody): Promise<void> {
  // Rate-limit: one resend per 60s per email address.
  // SET NX returns "OK" if key was set (first call), null if key existed (rate limited).
  const rateLimitKey = `resend_verify:${body.email}`;
  // Redis SET key value EX 60 NX: set only if not exists, expire in 60s.
  const set = await redis.set(rateLimitKey, '1', 'EX', 60, 'NX');
  if (!set) {
    throw new AuthError(429, 'TOO_MANY_REQUESTS', 'Please wait before requesting another verification email');
  }

  // Uniform response to prevent email enumeration — always return ok regardless.
  const user = await findUserByEmail(body.email);
  if (!user || user.onboardingStatus.name !== 'pending_verification') {
    return;
  }

  void (async () => {
    try {
      const token = makeVerificationToken();
      await redis.set(`email_verify:${token}`, String(user.id), 'EX', 86400);
      const verificationUrl = `${config.APP_BASE_URL}/verify-email?token=${token}`;
      // Dev-only — see A11 note in register(); never log the token in production.
      if (!isProduction) {
        console.log(`[auth] resend verification URL for ${user.email}: ${verificationUrl}`);
      }
      await sendVerificationEmail({ to: user.email, fullName: user.fullName, verificationUrl });
    } catch (e) {
      console.error('[auth] resendVerification post-rate-limit failed', e instanceof Error ? e.message : e);
    }
  })();
}

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

export async function refresh(
  rawRefreshToken: string,
): Promise<{ accessToken: string }> {
  const hash = sha256hex(rawRefreshToken);
  const session = await findSessionByRefreshHash(hash);

  if (!session) {
    throw new AuthError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token not found');
  }

  if (session.revokedAt || session.expiresAt < new Date()) {
    throw new AuthError(401, 'SESSION_EXPIRED', 'Session has expired');
  }

  const user = await findUserById(session.userId);
  if (!user) {
    throw new AuthError(401, 'INVALID_REFRESH_TOKEN', 'User not found');
  }

  const accessToken = await signAccessToken({ userId: user.id, sessionId: session.id });
  return { accessToken };
}

// ---------------------------------------------------------------------------
// Google OAuth — shared OAuth2 client (one per process)
// ---------------------------------------------------------------------------

const oauthClient = new OAuth2Client({
  clientId: config.GOOGLE_CLIENT_ID,
  clientSecret: config.GOOGLE_CLIENT_SECRET,
  redirectUri: config.GOOGLE_REDIRECT_URI,
});

// ---------------------------------------------------------------------------
// googleOAuthInit — generate CSRF state + return Google auth URL
// ---------------------------------------------------------------------------

export async function googleOAuthInit(
  returnTo: string,
): Promise<{ authUrl: string; state: string }> {
  const state = randomBytes(32).toString('base64url');
  await redis.set(
    `oauth_state:${state}`,
    JSON.stringify({ returnTo, createdAt: new Date().toISOString() }),
    'EX',
    600,
  );
  const authUrl = oauthClient.generateAuthUrl({
    scope: ['openid', 'email', 'profile'],
    state,
    prompt: 'select_account',
  });
  return { authUrl, state };
}

// ---------------------------------------------------------------------------
// handleGoogleCallback — exchange code, verify ID token, upsert user + session
// ---------------------------------------------------------------------------

export type GoogleCallbackOutcome =
  | { ok: true; accessToken: string; refreshToken: string; returnTo: string }
  | { ok: false; reason: string };

export async function handleGoogleCallback(opts: {
  code: string | undefined;
  queryState: string | undefined;
  cookieState: string | undefined;
  ip: string | null;
  userAgent: string | null;
}): Promise<GoogleCallbackOutcome> {
  const { code, queryState, cookieState, ip, userAgent } = opts;

  // CSRF: cookie must be present and match query param
  if (!cookieState || !queryState || queryState !== cookieState) {
    return { ok: false, reason: 'invalid_state' };
  }

  // Atomic single-use state: GETDEL removes the key so it can't be replayed
  const stateJson = await redis.getdel(`oauth_state:${queryState}`);
  if (!stateJson) {
    return { ok: false, reason: 'invalid_state' };
  }

  let returnTo = '/dashboard';
  try {
    const parsed = JSON.parse(stateJson) as { returnTo?: string };
    if (typeof parsed.returnTo === 'string') returnTo = parsed.returnTo;
  } catch {
    // keep default
  }

  if (!code) {
    return { ok: false, reason: 'invalid_token' };
  }

  // Exchange authorization code for tokens
  let idToken: string;
  try {
    const { tokens } = await oauthClient.getToken(code);
    if (!tokens.id_token) return { ok: false, reason: 'invalid_token' };
    idToken = tokens.id_token;
  } catch {
    return { ok: false, reason: 'invalid_token' };
  }

  // Verify ID token and extract user identity
  let email: string;
  let fullName: string;
  let avatarUrl: string | null;
  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken,
      audience: config.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload) return { ok: false, reason: 'invalid_token' };
    if (!payload.email || payload.email_verified !== true) {
      return { ok: false, reason: 'invalid_token' };
    }
    email = payload.email.toLowerCase();
    fullName = payload.name ?? email.split('@')[0]!;
    avatarUrl = payload.picture ?? null;
  } catch {
    return { ok: false, reason: 'invalid_token' };
  }

  // Find or create user — no auto-merge of email+google accounts (§1.2)
  const existingUser = await findUserByEmail(email);
  if (existingUser && existingUser.authProvider.name !== 'google') {
    return { ok: false, reason: 'email_in_use_with_password' };
  }

  let user: UserWithRelations;
  if (existingUser) {
    user = existingUser;
  } else {
    const [authProvider, onboardingStatus] = await Promise.all([
      prisma.authProvider.findUniqueOrThrow({ where: { name: 'google' } }),
      // Google users bypass email verification — start as verified
      prisma.onboardingStatus.findUniqueOrThrow({ where: { name: 'verified' } }),
    ]);
    user = await prisma.user.create({
      data: {
        email,
        passwordHash: null,
        fullName,
        displayName: fullName,
        avatarUrl,
        authProviderId: authProvider.id,
        onboardingStatusId: onboardingStatus.id,
      },
      include: { authProvider: true, onboardingStatus: true },
    });
  }

  // Create session
  const { raw: refreshToken, hash: refreshTokenHash } = makeRefreshToken();
  const expiresAt = new Date(Date.now() + parseDurationToMs(config.REFRESH_TOKEN_EXPIRY));
  const session = await createSession({
    userId: user.id,
    ipAddress: ip,
    userAgent,
    expiresAt,
    refreshTokenHash,
  });

  const accessToken = await signAccessToken({ userId: user.id, sessionId: session.id });
  return { ok: true, accessToken, refreshToken, returnTo };
}

// ---------------------------------------------------------------------------
// listSessions — active sessions for the caller, current session flagged
// ---------------------------------------------------------------------------

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
