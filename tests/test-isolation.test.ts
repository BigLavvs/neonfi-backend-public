import { describe, expect, it } from 'vitest';
import { validateTestIsolation } from '../src/lib/test-isolation.js';

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://app:secret@db.example.com:5432/neonfi?sslmode=require',
  DIRECT_URL: 'postgresql://app:secret@db-direct.example.com:5432/neonfi?sslmode=require',
  REDIS_URL: 'redis://:secret@cache.example.com:6379/0',
};

describe('test environment isolation validation', () => {
  it('requires explicit test database and Redis URLs when NODE_ENV=test', () => {
    const issues = validateTestIsolation(baseEnv);
    expect(issues).toEqual([
      expect.objectContaining({ key: 'DATABASE_URL_TEST', code: 'missing' }),
      expect.objectContaining({ key: 'REDIS_URL_TEST', code: 'missing' }),
    ]);
  });

  it('rejects test URLs that point at the runtime database or Redis target', () => {
    const issues = validateTestIsolation({
      ...baseEnv,
      DATABASE_URL_TEST: 'postgresql://other:creds@db.example.com:5432/neonfi',
      REDIS_URL_TEST: 'redis://cache.example.com:6379/0',
    });
    expect(issues).toEqual([
      expect.objectContaining({ key: 'DATABASE_URL_TEST', code: 'same_as_runtime' }),
      expect.objectContaining({ key: 'REDIS_URL_TEST', code: 'same_as_runtime' }),
    ]);
  });

  it('rejects Redis URLs with the same host, port, and database but different credentials', () => {
    const issues = validateTestIsolation({
      ...baseEnv,
      DATABASE_URL_TEST: 'postgresql://app:secret@db.example.com:5432/neonfi_test',
      REDIS_URL_TEST: 'redis://:different-secret@cache.example.com:6379/0',
    });
    expect(issues).toEqual([
      expect.objectContaining({ key: 'REDIS_URL_TEST', code: 'same_as_runtime' }),
    ]);
  });

  it('rejects Redis URLs with the same host, port, and database across redis and rediss protocols', () => {
    const issues = validateTestIsolation({
      ...baseEnv,
      DATABASE_URL_TEST: 'postgresql://app:secret@db.example.com:5432/neonfi_test',
      REDIS_URL_TEST: 'rediss://cache.example.com:6379/0',
    });
    expect(issues).toEqual([
      expect.objectContaining({ key: 'REDIS_URL_TEST', code: 'same_as_runtime' }),
    ]);
  });

  it('normalizes omitted Redis database path to database 0', () => {
    const issues = validateTestIsolation({
      ...baseEnv,
      DATABASE_URL_TEST: 'postgresql://app:secret@db.example.com:5432/neonfi_test',
      REDIS_URL_TEST: 'redis://cache.example.com:6379',
    });
    expect(issues).toEqual([
      expect.objectContaining({ key: 'REDIS_URL_TEST', code: 'same_as_runtime' }),
    ]);
  });

  it('allows separate test database and Redis targets', () => {
    expect(validateTestIsolation({
      ...baseEnv,
      DATABASE_URL_TEST: 'postgresql://app:secret@db.example.com:5432/neonfi_test',
      REDIS_URL_TEST: 'redis://:secret@cache.example.com:6379/1',
    })).toEqual([]);
  });
});
