// Neonfi backend — rate limiter unit test (audit SEC #27).
//
// The limiter is gated off when NODE_ENV=test, so we mock ../src/lib/config.js to force it ON
// (isTest:false, RATE_LIMIT_ENABLED:true) and mock ../src/lib/redis.js with an in-memory sorted
// set so the sliding-window logic runs deterministically — no real Redis.

import { it, expect, describe, beforeEach, vi } from 'vitest';
import type { Context } from 'hono';

vi.mock('../src/lib/config.js', () => ({
  config: { RATE_LIMIT_ENABLED: true, RATE_LIMIT_WINDOW_MS: 60000 },
  isTest: false,
  isProduction: false,
}));

const mocks = vi.hoisted(() => ({ store: new Map<string, Array<{ score: number; member: string }>>(), throwOnExec: false }));

vi.mock('../src/lib/redis.js', () => ({
  redis: {
    pipeline() {
      const results: Array<[null, unknown]> = [];
      const api: Record<string, unknown> = {};
      api.zremrangebyscore = (key: string, min: number, max: number) => {
        const arr = mocks.store.get(key) ?? [];
        const kept = arr.filter((e) => !(e.score >= min && e.score <= max));
        mocks.store.set(key, kept);
        results.push([null, arr.length - kept.length]);
        return api;
      };
      api.zadd = (key: string, score: number, member: string) => {
        const arr = mocks.store.get(key) ?? [];
        arr.push({ score, member });
        mocks.store.set(key, arr);
        results.push([null, 1]);
        return api;
      };
      api.zcard = (key: string) => {
        results.push([null, (mocks.store.get(key) ?? []).length]);
        return api;
      };
      api.pexpire = () => {
        results.push([null, 1]);
        return api;
      };
      api.exec = async () => {
        if (mocks.throwOnExec) throw new Error('redis down');
        return results;
      };
      return api;
    },
  },
}));

import { rateLimit } from '../src/lib/rate-limit.js';

function makeCtx(ip: string): { c: Context; getJson: () => { body: unknown; status: number } | null } {
  let jsonResp: { body: unknown; status: number } | null = null;
  const c = {
    req: {
      header: (name: string) => (name.toLowerCase() === 'x-forwarded-for' ? ip : undefined),
      path: '/api/v1/test',
    },
    env: undefined,
    header: () => {},
    json: (body: unknown, status?: number) => {
      jsonResp = { body, status: status ?? 200 };
      return jsonResp as unknown;
    },
  } as unknown as Context;
  return { c, getJson: () => jsonResp };
}

beforeEach(() => {
  mocks.store.clear();
  mocks.throwOnExec = false;
});

describe('rate limiter (audit SEC #27)', () => {
  it('allows up to the limit, then 429s the next request from the same IP', async () => {
    const mw = rateLimit({ id: 'test', limit: 3, windowMs: 60000 });
    const next = vi.fn(async () => undefined);

    // First 3 are allowed → next() called each time.
    for (let i = 0; i < 3; i++) {
      const { c, getJson } = makeCtx('9.9.9.9');
      await mw(c, next);
      expect(getJson()).toBeNull();
    }
    expect(next).toHaveBeenCalledTimes(3);

    // 4th trips the limit → 429 RATE_LIMITED, next() NOT called again.
    const { c, getJson } = makeCtx('9.9.9.9');
    await mw(c, next);
    const resp = getJson();
    expect(resp?.status).toBe(429);
    expect((resp?.body as { error: { code: string; details: { retryAfter: number } } }).error.code).toBe('RATE_LIMITED');
    expect((resp?.body as { error: { details: { retryAfter: number } } }).error.details.retryAfter).toBe(60);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('keeps separate buckets per IP', async () => {
    const mw = rateLimit({ id: 'test', limit: 1, windowMs: 60000 });
    const next = vi.fn(async () => undefined);

    const a = makeCtx('1.1.1.1');
    await mw(a.c, next);
    expect(a.getJson()).toBeNull(); // A's first → allowed

    const b = makeCtx('2.2.2.2');
    await mw(b.c, next);
    expect(b.getJson()).toBeNull(); // B's first → allowed (independent bucket)

    const a2 = makeCtx('1.1.1.1');
    await mw(a2.c, next);
    expect(a2.getJson()?.status).toBe(429); // A's second → blocked
  });

  it('fails OPEN when Redis errors (never locks everyone out)', async () => {
    mocks.throwOnExec = true;
    const mw = rateLimit({ id: 'test', limit: 1, windowMs: 60000 });
    const next = vi.fn(async () => undefined);

    const { c, getJson } = makeCtx('3.3.3.3');
    await mw(c, next);
    // No 429 produced; request was allowed through.
    expect(getJson()).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
