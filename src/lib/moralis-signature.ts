// Neonfi backend — Moralis webhook signature verification (Stage 11).
//
// Moralis uses Keccak-256 (Ethereum), NOT NIST SHA3-256 — they produce different
// hashes for the same input. Node's crypto.createHash('sha3-256') is wrong here.
// js-sha3's keccak256 is the correct implementation.
//
// The signature covers: rawBody + MORALIS_WEBHOOK_SECRET (concatenated as strings).
// The raw body from c.req.text() is exactly what Moralis signed — never JSON.parse
// + JSON.stringify the body before signing, as re-serialization changes whitespace.

import jsSha3 from 'js-sha3';
import { timingSafeEqual } from 'node:crypto';

// js-sha3 is CommonJS and assembles its exports dynamically, so Node's ESM lexer can't
// expose `keccak256` as a named import — `import { keccak256 } from 'js-sha3'` passes under
// vitest's loader but throws at the real tsx/node boot ("does not provide an export named
// 'keccak256'"). Default-import the module object, then destructure. Do NOT revert to a
// named import. (boot fix; to be committed via retrofit-11.)
const { keccak256 } = jsSha3;

export function computeMoralisSignature(rawBody: string, secret: string): string {
  return keccak256(rawBody + secret);
}

export function verifyMoralisSignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  const expected = computeMoralisSignature(rawBody, secret);
  // Strip 0x prefix if present — Moralis sometimes includes it
  const cleanSig = signature.startsWith('0x') ? signature.slice(2) : signature;
  if (expected.length !== cleanSig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(cleanSig, 'hex'));
  } catch {
    // Invalid hex in signature — treat as mismatch
    return false;
  }
}
