// Neonfi backend — environment loader & validation (Build Guide §1.2,
// System_Implementation §3 + Configuration Strategy).
//
// Loads .env via dotenv, validates EVERY required var with Zod, and THROWS +
// EXITS on any missing/invalid required var. Exports a single typed `config`
// object. Import from here everywhere — never read process.env directly outside
// this loader.

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

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

    // --- Payments ---
    STRIPE_SECRET_KEY: z.string().min(1),
    STRIPE_WEBHOOK_SECRET: z.string().min(1),
    STRIPE_PRO_MONTHLY_PRICE_ID: z.string().min(1),
    STRIPE_PRO_YEARLY_PRICE_ID: z.string().min(1),

    // --- Blockchain / token ---
    MORALIS_API_KEY: z.string().min(1),
    MORALIS_WEBHOOK_SECRET: z.string().min(1),
    COINBASE_WS_URL: z.string().min(1),
    // Vendor decision is OPEN (Appendix item 2 — Moralis is primary; CMC/CoinRanking
    // under evaluation). These are OPTIONAL; do not require either.
    COINMARKETCAP_API_KEY: z.string().optional(),
    COINRANKING_API_KEY: z.string().optional(),

    // --- Email ---
    RESEND_API_KEY: z.string().min(1),
    EMAIL_FROM_ADDRESS: z.string().min(1),

    // --- Logging ---
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  // Test DB/Redis URLs are required only when running as NODE_ENV=test.
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'test') {
      if (!env.DATABASE_URL_TEST) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DATABASE_URL_TEST'],
          message: 'DATABASE_URL_TEST is required when NODE_ENV=test',
        });
      }
      if (!env.REDIS_URL_TEST) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['REDIS_URL_TEST'],
          message: 'REDIS_URL_TEST is required when NODE_ENV=test',
        });
      }
    }
  });

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
