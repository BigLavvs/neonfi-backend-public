type EnvMap = Partial<Record<string, string>>;

export interface TestIsolationIssue {
  key: 'DATABASE_URL_TEST' | 'REDIS_URL_TEST';
  code: 'missing' | 'invalid' | 'same_as_runtime';
  message: string;
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace('-pooler.', '.');
}

function parseUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function databaseTarget(raw: string | undefined): string | null {
  const url = parseUrl(raw);
  if (!url) return null;
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) return null;
  const port = url.port || '5432';
  const database = url.pathname.replace(/\/+$/, '') || '/';
  return `postgresql://${normalizeHost(url.hostname)}:${port}${database}`;
}

export function redisTarget(raw: string | undefined): string | null {
  const url = parseUrl(raw);
  if (!url) return null;
  if (!['redis:', 'rediss:'].includes(url.protocol)) return null;
  const port = url.port || '6379';
  const db = url.pathname.replace(/^\/+/, '') || '0';
  return `${normalizeHost(url.hostname)}:${port}/${db}`;
}

export function validateTestIsolation(env: EnvMap): TestIsolationIssue[] {
  if (env.NODE_ENV !== 'test') return [];

  const issues: TestIsolationIssue[] = [];
  const databaseUrlTest = env.DATABASE_URL_TEST?.trim();
  const redisUrlTest = env.REDIS_URL_TEST?.trim();

  if (!databaseUrlTest) {
    issues.push({
      key: 'DATABASE_URL_TEST',
      code: 'missing',
      message: 'DATABASE_URL_TEST is required when NODE_ENV=test',
    });
  }
  if (!redisUrlTest) {
    issues.push({
      key: 'REDIS_URL_TEST',
      code: 'missing',
      message: 'REDIS_URL_TEST is required when NODE_ENV=test',
    });
  }

  if (databaseUrlTest) {
    const testTarget = databaseTarget(databaseUrlTest);
    if (!testTarget) {
      issues.push({
        key: 'DATABASE_URL_TEST',
        code: 'invalid',
        message: 'DATABASE_URL_TEST must be a PostgreSQL URL',
      });
    } else {
      const runtimeTargets = [databaseTarget(env.DATABASE_URL), databaseTarget(env.DIRECT_URL)];
      if (runtimeTargets.some((target) => target !== null && target === testTarget)) {
        issues.push({
          key: 'DATABASE_URL_TEST',
          code: 'same_as_runtime',
          message: 'DATABASE_URL_TEST must point to a separate test database',
        });
      }
    }
  }

  if (redisUrlTest) {
    const testTarget = redisTarget(redisUrlTest);
    if (!testTarget) {
      issues.push({
        key: 'REDIS_URL_TEST',
        code: 'invalid',
        message: 'REDIS_URL_TEST must be a Redis URL',
      });
    } else {
      const runtimeTarget = redisTarget(env.REDIS_URL);
      if (runtimeTarget !== null && runtimeTarget === testTarget) {
        issues.push({
          key: 'REDIS_URL_TEST',
          code: 'same_as_runtime',
          message: 'REDIS_URL_TEST must point to a separate test Redis database',
        });
      }
    }
  }

  return issues;
}
