// Neonfi backend — environment loader & validation (Build Guide §1.2,
// System_Implementation §3 + Configuration Strategy).
//
// Loads .env via dotenv, validates EVERY required var with Zod, and THROWS +
// EXITS on any missing/invalid required var. Exports a single typed `config`
// object. Import from here everywhere — never read process.env directly outside
// this loader.

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import cron from 'node-cron';

loadDotenv();

// `test` is included alongside development|production because the test-only vars
// (DATABASE_URL_TEST, REDIS_URL_TEST) are conditionally required when
// NODE_ENV=test (Build Guide §3.2). The docs name development|production for the
// runtime; `test` is the integration-test runtime value (System_Implementation
// Testing Strategy → "Separate environment variables").
const NodeEnv = z.enum(['development', 'production', 'test']);

const schema = z
  .object({
    // --- Core ---
    APP_BASE_URL: z.string().url(),
    API_BASE_URL: z.string().url(),
    NODE_ENV: NodeEnv,

    // --- Database (Neon dual URL) ---
    DATABASE_URL: z.string().min(1),
    DIRECT_URL: z.string().min(1),
    DATABASE_URL_TEST: z.string().optional(),

    // --- Cache ---
    REDIS_URL: z.string().min(1),
    REDIS_URL_TEST: z.string().optional(),

    // --- Auth & Security ---
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 bytes (256 bits)'),
    ACCESS_TOKEN_EXPIRY: z.string().min(1),
    REFRESH_TOKEN_EXPIRY: z.string().min(1),
    COOKIE_SECRET: z.string().min(1),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    GOOGLE_REDIRECT_URI: z.string().url(),

    // --- Payments ---
    STRIPE_SECRET_KEY: z.string().min(1),
    STRIPE_WEBHOOK_SECRET: z.string().min(1),
    STRIPE_PRO_MONTHLY_PRICE_ID: z.string().min(1),
    STRIPE_PRO_YEARLY_PRICE_ID: z.string().min(1),

    // --- Blockchain / token ---
    MORALIS_API_KEY: z.string().min(1),
    MORALIS_WEBHOOK_SECRET: z.string().min(1),
    COINBASE_WS_URL: z.string().min(1),
    // Stage 12: COINMARKETCAP_API_KEY is now required. Stage 9B's CMC sync is the
    // authoritative token-catalog source; booting without the key silently disables
    // price refreshes in a way that's hard to notice in production.
    COINMARKETCAP_API_KEY: z.string().min(1),
    COINRANKING_API_KEY: z.string().optional(),

    // --- Email ---
    RESEND_API_KEY: z.string().min(1),
    EMAIL_FROM_ADDRESS: z.string().min(1),

    // --- Logging ---
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    // --- Auth rate-limiting & lockout (Build Guide Appendix item 10) ---
    // Both are optional with sensible defaults; set them in .env for production.
    AUTH_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
    AUTH_LOGIN_LOCKOUT_MS: z.coerce.number().int().min(1000).default(900000),

    // --- Token metadata sync (Stage 9B) ---
    // NOTE: deliberately NOT z.coerce.boolean() — Boolean("false") === true in JS,
    // so "false" would NOT disable. Stage 13 caught the same bug for SNAPSHOT_ENABLED;
    // mirror the same explicit-transform pattern here.
    TOKEN_SYNC_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default('true'),
    TOKEN_SYNC_CRON: z
      .string()
      .default('0 */6 * * *')
      .refine((v) => cron.validate(v), 'TOKEN_SYNC_CRON must be a valid cron expression'),

    // --- Daily balance snapshot job (Stage 13) ---
    // NOTE: deliberately NOT z.coerce.boolean() like TOKEN_SYNC_ENABLED above —
    // z.coerce.boolean() runs Boolean("false") === true, so "false" would NOT
    // disable. §1.6 requires SNAPSHOT_ENABLED=false to skip cron registration, so
    // we parse the string explicitly.
    SNAPSHOT_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default('true'),
    SNAPSHOT_CRON: z
      .string()
      .default('0 0 * * *')
      .refine((v) => cron.validate(v), 'SNAPSHOT_CRON must be a valid cron expression'),
  });
  // DATABASE_URL_TEST and REDIS_URL_TEST are optional. When present and
  // NODE_ENV=test, prisma.ts / redis.ts use them instead of the dev URLs
  // (option a — separate test DB). When absent and NODE_ENV=test, both
  // singletons fall back to DATABASE_URL / REDIS_URL with per-test table
  // cleanup (option b — dev DB, chosen by Idowu for Stage 1A).

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // Fail loudly and exit — a backend that boots with a missing secret is the
  // silent-divergence failure mode §0.2 warns about.
  // eslint-disable-next-line no-console
  console.error(`\n[config] Invalid or missing environment variables:\n${issues}\n`);
  process.exit(1);
}

export type Config = z.infer<typeof schema>;

export const config: Config = parsed.data;

export const isProduction = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';
