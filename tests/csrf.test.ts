// Neonfi backend — CSRF middleware unit test (audit SEC, decision 7).
// Gated off when NODE_ENV=test, so we mock config to force it ON.
import { it, expect, describe, vi } from 'vitest';
import type { Context } from 'hono';

vi.mock('../src/lib/config.js', () => ({
  config: {
    CSRF_ENABLED: true,
    APP_BASE_URL: 'https://app.neonfi.live',
    API_BASE_URL: 'https://api.neonfi.live',
    CSRF_ALLOWED_ORIGINS: '',
  },
  isTest: false,
}));

import { csrfProtection } from '../src/lib/csrf.js';

function ctx(method: string, headers: Record<string, string>, path = '/api/v1/portfolios') {
  let resp: { body: unknown; status: number } | null = null;
  const c = {
    req: { method, path, header: (n: string) => headers[n.toLowerCase()] },
    json: (body: unknown, status?: number) => {
      resp = { body, status: status ?? 200 };
      return resp as unknown;
    },
  } as unknown as Context;
  return { c, get: () => resp };
}

describe('CSRF protection (audit SEC)', () => {
  const mw = csrfProtection();

  it('blocks a mutating request with a foreign Origin → 403', async () => {
    const { c, get } = ctx('POST', { origin: 'https://evil.example' });
    const next = vi.fn(async () => undefined);
    await mw(c, next);
    expect(get()?.status).toBe(403);
    expect((get()?.body as { error: { code: string } }).error.code).toBe('CSRF_FORBIDDEN');
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a mutating request from an allowlisted Origin', async () => {
    const { c, get } = ctx('POST', { origin: 'https://app.neonfi.live' });
    const next = vi.fn(async () => undefined);
    await mw(c, next);
    expect(get()).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows GET regardless of Origin (not state-changing)', async () => {
    const { c, get } = ctx('GET', { origin: 'https://evil.example' });
    const next = vi.fn(async () => undefined);
    await mw(c, next);
    expect(get()).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows a mutating request with no Origin/Referer (non-browser)', async () => {
    const { c, get } = ctx('POST', {});
    const next = vi.fn(async () => undefined);
    await mw(c, next);
    expect(get()).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('blocks a foreign Referer when Origin is absent', async () => {
    const { c, get } = ctx('DELETE', { referer: 'https://evil.example/page' });
    const next = vi.fn(async () => undefined);
    await mw(c, next);
    expect(get()?.status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});
