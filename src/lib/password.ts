// Password hashing with bcryptjs — pure-JS implementation avoids node-gyp
// issues on Windows and cross-platform builds (stage-1a.md §4.3 / §7.4).
// Cost factor 12 is a deliberate balance: ~300ms on a modern CPU, which is
// acceptable for login/register but not trivially brute-forceable.

import bcrypt from 'bcryptjs';

const COST = 12;

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, COST);
}

export async function verifyPassword(
  plaintext: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}
