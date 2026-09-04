// Neonfi backend — security response headers (audit SEC, decision 7).
import { it, expect } from 'vitest';
import { app } from '../src/app.js';

it('sets security headers on API responses', async () => {
  const res = await app.request('/api/v1/intentional-security-header-404');
  expect(res.status).toBe(404);
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
});
