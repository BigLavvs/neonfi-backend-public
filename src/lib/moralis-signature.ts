// Neonfi backend — Moralis webhook signature verification (Stage 11).
//
// Moralis uses Keccak-256 (Ethereum), NOT NIST SHA3-256 — they produce different
// hashes for the same input. Node's crypto.createHash('sha3-256') is wrong here.
// js-sha3's keccak256 is the correct implementation.
//
// The signature covers: rawBody + MORALIS_WEBHOOK_SECRET (concatenated as strings).
// The raw body from c.req.text() is exactly what Moralis signed — never JSON.parse
// + JSON.stringify the body before signing, as re-serialization changes whitespace.

import { keccak256 } from 'js-sha3';
import { timingSafeEqual } from 'node:crypto';

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
