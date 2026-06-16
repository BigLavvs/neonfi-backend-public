// Neonfi backend — transient-connection retry unit test (retrofit-17 gate #1).
//
// Pure unit test: no DB, no Redis. Drives the exported retry helper from
// src/lib/prisma.ts with fake operations and an INJECTED instant delay so the
// test is fast (no real backoff sleeps). Asserts the retry only fires for the
// transient connection codes (P1001/P1017) and never for query/constraint errors.

import { it, expect, describe, vi } from 'vitest';
import {
  withConnectionRetry,
  isRetryableConnectionError,
  RETRYABLE_CONNECTION_CODES,
} from '../src/lib/prisma.js';

// Instant delay — keeps the backoff loop's structure but never actually waits.
const noDelay = (): Promise<void> => Promise.resolve();

// Mirror the two error shapes Prisma actually produces:
//   PrismaClientKnownRequestError      → `.code`      (P1017, P2002)
//   PrismaClientInitializationError    → `.errorCode` (P1001)
const knownRequestError = (code: string): { code: string } => ({ code });
const initError = (errorCode: string): { errorCode: string } => ({ errorCode });

describe('isRetryableConnectionError', () => {
  it('matches P1001 (.errorCode) and P1017 (.code) only', () => {
    expect(isRetryableConnectionError(initError('P1001'))).toBe(true);
    expect(isRetryableConnectionError(knownRequestError('P1017'))).toBe(true);

    expect(isRetryableConnectionError(knownRequestError('P2002'))).toBe(false);
    expect(isRetryableConnectionError(new Error('boom'))).toBe(false);
    expect(isRetryableConnectionError(null)).toBe(false);
    expect(isRetryableConnectionError(undefined)).toBe(false);
  });

  it('exposes exactly the two transient connection codes', () => {
    expect([...RETRYABLE_CONNECTION_CODES].sort()).toEqual(['P1001', 'P1017']);
  });
});

describe('withConnectionRetry', () => {
  it('retries P1017 twice then returns the resolved value', async () => {
    const op = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(knownRequestError('P1017'))
      .mockRejectedValueOnce(knownRequestError('P1017'))
      .mockResolvedValueOnce('ok');

    const result = await withConnectionRetry(op, { delay: noDelay });

    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(3); // 2 failures + 1 success
  });

  it('retries a P1001 initialization error', async () => {
    const op = vi
      .fn<[], Promise<number>>()
      .mockRejectedValueOnce(initError('P1001'))
      .mockResolvedValueOnce(42);

    const result = await withConnectionRetry(op, { delay: noDelay });

    expect(result).toBe(42);
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on a non-retryable error (P2002 unique constraint), no retry', async () => {
    const err = knownRequestError('P2002');
    const op = vi.fn<[], Promise<never>>().mockRejectedValue(err);

    await expect(withConnectionRetry(op, { delay: noDelay })).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1); // tried once, never retried
  });

  it('gives up after MAX_ATTEMPTS and rethrows the last transient error', async () => {
    const err = knownRequestError('P1017');
    const op = vi.fn<[], Promise<never>>().mockRejectedValue(err);

    // Default cap is 4 attempts.
    await expect(withConnectionRetry(op, { delay: noDelay })).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(4);
  });

  it('passes through immediately when the op succeeds on the first try', async () => {
    const op = vi.fn<[], Promise<string>>().mockResolvedValue('first');

    const result = await withConnectionRetry(op, { delay: noDelay });

    expect(result).toBe('first');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('honors a custom maxAttempts cap', async () => {
    const op = vi.fn<[], Promise<never>>().mockRejectedValue(initError('P1001'));

    await expect(
      withConnectionRetry(op, { delay: noDelay, maxAttempts: 2 }),
    ).rejects.toMatchObject({ errorCode: 'P1001' });
    expect(op).toHaveBeenCalledTimes(2);
  });
});
