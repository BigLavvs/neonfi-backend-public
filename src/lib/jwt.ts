// JWT primitives for the access-token half of the two-cookie session model
// (Build Guide §2.2 / stage-1a.md §1.1).
//
// Algorithm: HS256 signed with JWT_SECRET.
// Payload: { sub: "<userId>", sid: <sessionId>, iat, exp }
//   - `sub` is the string encoding of the userId (jose convention).
//   - `sid` is the integer sessionId used to look up the Session row.
//
// jose is used (not jsonwebtoken) because it is ESM-native and has no
// Buffer-polyfill requirement (stage-1a.md §4.3 / §8 notes).

import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import type { JWTPayload } from 'jose';
import { config } from './config.js';

export interface AccessTokenPayload extends JWTPayload {
  sub: string; // string(userId) — jose requires sub to be a string
  sid: number; // sessionId (integer)
}

const secret = new TextEncoder().encode(config.JWT_SECRET);

export async function signAccessToken(payload: {
  userId: number;
  sessionId: number;
}): Promise<string> {
  return new SignJWT({ sub: String(payload.userId), sid: payload.sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(config.ACCESS_TOKEN_EXPIRY) // e.g. "15m"
    .sign(secret);
}

export interface VerifyResult {
  payload: AccessTokenPayload;
  expired: boolean;
}

export async function verifyAccessToken(
  token: string,
): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify<AccessTokenPayload>(token, secret);
  return payload;
}

// Re-export jose's JWTExpired so callers can do isinstance checks without
// importing jose directly.
export const JWTExpired = joseErrors.JWTExpired;
