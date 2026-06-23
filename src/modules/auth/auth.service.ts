// Neonfi backend — Auth module: service layer (Stage 1A).
//
// Architecture:
//   - auth module owns NO tables; it orchestrates users module + email module.
//   - All DB access goes through users.repository; this file contains only
//     business logic and orchestration.
//   - AuthError carries HTTP status + code so controllers stay thin.
//   - Refresh tokens: opaque 32-byte base64url; stored as SHA-256 hex hash in
//     Session.refreshTokenHash (§1.2). Raw token lives only in HttpOnly cookie.
//   - Rotating refresh with reuse detection (audit SEC, decision 7): each
//     /auth/refresh mints a NEW refresh token + hash on the same Session row,
//     marks the spent hash consumed in Redis, and issues a fresh access token.
//     Replaying a rotated-out (consumed) token revokes the whole session.

import { createHash, randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { config, isProduction } from '../../lib/config.js';
import { redis } from '../../lib/redis.js';
import { signAccessToken } from '../../lib/jwt.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import {
  recordFailedLogin,
  clearLockout,
  getLockoutState,
  emailIpSubject,
  ipSubject,
} from '../../lib/lockout.js';
import { parseDurationToMs } from '../../lib/duration.js';
import { prisma } from '../../lib/prisma.js';
import {
  findUserByEmail,
  findUserById,
  toUserDTO,
  createSession,
  findSessionById,
  findSessionByRefreshHash,
  rotateSessionRefreshHash,
  revokeSession,
  revokeAllSessionsForUser,
  findActiveSessionsByUser,
  updatePassword,
  type UserDTO,
  type UserWithRelations,
} from '../users/users.repository.js';
import { sendWelcomeEmail, sendVerificationEmail, sendPasswordResetEmail } from '../email/email.service.js';
import type {
  RegisterBody,
  LoginBody,
  VerifyEmailBody,
  ResendVerificationBody,
  PasswordResetRequestBody,
  PasswordResetConfirmBody,
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

// Timing-attack defense: when the email is unknown (or a Google-only account
// with no password), we still run a bcrypt compare against a fixed dummy hash so
// the response time of "no such user" matches "wrong password". The dummy hash is
// computed once and cached for the process lifetime.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword('neonfi-timing-equalizer-not-a-real-secret');
  }
  return dummyHashPromise;
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
  // 1. Lockout check before any DB lookup (avoid leaking timing via DB query).
  //    Two dimensions (audit SEC, per-IP):
  //      - emailSub = (account, IP) — caps brute force on ONE account from ONE IP
  //        WITHOUT letting an attacker lock the victim out from a different IP (so
  //        the per-email lockout can't be weaponized as a targeted DoS).
  //      - ipSub    = IP across all accounts — catches one IP spraying many accounts.
  const emailSub = emailIpSubject(body.email, ip);
  const ipSub = ipSubject(ip);
  const [emailLockout, ipLockout] = await Promise.all([
    getLockoutState(emailSub),
    getLockoutState(ipSub, config.AUTH_LOGIN_IP_MAX_ATTEMPTS),
  ]);
  if (emailLockout.locked || ipLockout.locked) {
    throw new AuthError(423, 'ACCOUNT_LOCKED', 'Account temporarily locked due to too many failed attempts', {
      retryAfterMs: Math.max(emailLockout.ttlMs, ipLockout.ttlMs),
    });
  }

  const recordFailure = () =>
    Promise.all([recordFailedLogin(emailSub), recordFailedLogin(ipSub)]);

  // 2–3. Uniform error for "user not found" and "wrong password" to prevent
  //      email enumeration. In both no-user and no-password (Google-only) cases we
  //      still run a bcrypt compare against a dummy hash so response timing matches
  //      the wrong-password path and can't be used to enumerate accounts.
  const user = await findUserByEmail(body.email);
  const passwordHashToCheck = user?.passwordHash ?? (await getDummyHash());
  const passwordOk = await verifyPassword(body.password, passwordHashToCheck);

  if (!user || !user.passwordHash || !passwordOk) {
    await recordFailure();
    throw new AuthError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  // 4. Successful auth — clear both lockout counters.
  await Promise.all([clearLockout(emailSub), clearLockout(ipSub)]);

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
// requestPasswordReset — email-auth users only; mirrors resendVerification
// (rate-limit first, enumeration-uniform 200, fire-and-forget email). [retrofit-6]
// ---------------------------------------------------------------------------

export async function requestPasswordReset(body: PasswordResetRequestBody): Promise<void> {
  // Rate-limit FIRST so the 429 leaks nothing: set before the existence check.
  // SET NX returns "OK" on first call, null if the key already exists.
  const rateLimitKey = `reset_request:${body.email}`;
  const set = await redis.set(rateLimitKey, '1', 'EX', 60, 'NX');
  if (!set) {
    throw new AuthError(429, 'TOO_MANY_REQUESTS', 'Please wait before requesting another password reset');
  }

  // Uniform 200 regardless of outcome — no enumeration. Only email-auth accounts
  // can reset a password; Google-only users (authProvider 'google') get nothing.
  const user = await findUserByEmail(body.email);
  if (!user || user.authProvider.name !== 'email') {
    return;
  }

  void (async () => {
    try {
      const token = makeVerificationToken();
      await redis.set(`password_reset:${token}`, String(user.id), 'EX', 3600);
      const resetUrl = `${config.APP_BASE_URL}/reset-password?token=${token}`;
      // Dev-only — see A11 note in register(); never log the token in production.
      if (!isProduction) {
        console.log(`[auth] password reset URL for ${user.email}: ${resetUrl}`);
      }
      await sendPasswordResetEmail({ to: user.email, fullName: user.fullName, resetUrl });
    } catch (e) {
      console.error('[auth] requestPasswordReset post-rate-limit failed', e instanceof Error ? e.message : e);
    }
  })();
}

// ---------------------------------------------------------------------------
// confirmPasswordReset — single-use token → set new password → revoke ALL
// sessions. No auto-login; the frontend sends the user to login. [retrofit-6]
// ---------------------------------------------------------------------------

export async function confirmPasswordReset(body: PasswordResetConfirmBody): Promise<void> {
  // Atomic single-use: GETDEL returns the value and deletes the key in one op.
  const userIdStr = await redis.getdel(`password_reset:${body.token}`);
  if (!userIdStr) {
    throw new AuthError(400, 'INVALID_RESET_TOKEN', 'Password reset token is invalid or has expired');
  }

  const userId = parseInt(userIdStr, 10);
  const user = await findUserById(userId);
  // Defensive: the request flow only issues tokens for email accounts, but
  // re-check here so a stale token can never set a password on a Google account.
  if (!user || user.authProvider.name !== 'email') {
    throw new AuthError(400, 'INVALID_RESET_TOKEN', 'Password reset token is invalid or has expired');
  }

  const passwordHash = await hashPassword(body.password);
  await updatePassword(userId, passwordHash);

  // Revoke every live session so a reset locks out any attacker session.
  await revokeAllSessionsForUser(userId);
}

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

// Rotating refresh with reuse detection (audit SEC, decision 7). Each /auth/refresh
// mints a NEW refresh token, swaps it into the session row, and marks the spent token's
// hash consumed in Redis. Presenting a previously-rotated-out (consumed) token is treated
// as theft: the whole session is revoked so neither the attacker nor the victim can keep
// refreshing — both are forced to re-authenticate.
export async function refresh(
  rawRefreshToken: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const oldHash = sha256hex(rawRefreshToken);
  const session = await findSessionByRefreshHash(oldHash);

  if (!session) {
    // Not a CURRENT token. If we recorded this hash as already-consumed, the token was
    // rotated out and is now being replayed → reuse/theft. Revoke the session family.
    const reusedSessionId = await redis.get(`refresh_used:${oldHash}`);
    if (reusedSessionId) {
      const sid = parseInt(reusedSessionId, 10);
      if (Number.isInteger(sid)) {
        await revokeSession(sid);
        console.warn('[auth]', JSON.stringify({ event: 'refresh_token_reuse_detected', sessionId: sid }));
      }
    }
    throw new AuthError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token not found');
  }

  if (session.revokedAt || session.expiresAt < new Date()) {
    throw new AuthError(401, 'SESSION_EXPIRED', 'Session has expired');
  }

  const user = await findUserById(session.userId);
  if (!user) {
    throw new AuthError(401, 'INVALID_REFRESH_TOKEN', 'User not found');
  }

  // Rotate: mint a new refresh token, slide the absolute expiry, and atomically swap it in.
  const { raw: refreshToken, hash: newHash } = makeRefreshToken();
  const refreshTtlMs = parseDurationToMs(config.REFRESH_TOKEN_EXPIRY);
  const newExpiresAt = new Date(Date.now() + refreshTtlMs);
  const rotated = await rotateSessionRefreshHash(session.id, oldHash, newHash, newExpiresAt);
  if (!rotated) {
    // Lost a concurrent rotation race — this exact token was already exchanged by a parallel
    // refresh. Reject rather than minting a second live token from one refresh token.
    throw new AuthError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token not found');
  }

  // Mark the spent token consumed so a later replay trips reuse detection above. TTL matches
  // the refresh lifetime — past that the token is expired anyway and the marker is moot.
  await redis.set(`refresh_used:${oldHash}`, String(session.id), 'PX', refreshTtlMs);

  const accessToken = await signAccessToken({ userId: user.id, sessionId: session.id });
  return { accessToken, refreshToken };
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
