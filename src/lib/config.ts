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
import { validateTestIsolation } from './test-isolation.js';

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

    // retrofit-47: read-side wallet-data providers. Moralis (already required) is primary; these
    // three are OPTIONAL fallbacks — a provider with no key is skipped in the preview/sync chain.
    GOLDRUSH_API_KEY: z.string().optional(),   // Covalent / GoldRush (covalenthq.com); key prefix cqt_
    ALCHEMY_API_KEY: z.string().optional(),
    ANKR_API_KEY: z.string().optional(),
    // retrofit-60: one-call multi-year value-history providers (also optional fallbacks).
    // Zerion auth = HTTP Basic with the key as username (empty password); Mobula auth =
    // raw key in the Authorization header. A missing key skips that provider in the chain.
    ZERION_API_KEY: z.string().optional(),
    MOBULA_API_KEY: z.string().optional(),
    // Moralis Web3 Data API base (distinct from the streams base in moralis-streams-client.ts).
    MORALIS_DEEP_INDEX_BASE: z.string().min(1).default('https://deep-index.moralis.io/api/v2.2'),
    MORALIS_SOLANA_BASE: z.string().min(1).default('https://solana-gateway.moralis.io'),

    // --- Multi-exchange price ingestion (retrofit-16) ---
    // Binance market data is reachable only from permitted SERVER egress regions
    // (not per-user). Set BINANCE_ENABLED=false on a Binance-blocked host so the
    // app degrades to Coinbase + Kraken instead of spamming reconnect errors.
    // NOTE: explicit transform, NOT z.coerce.boolean() — Boolean("false")===true,
    // so coercion would never disable it (same gotcha as TOKEN_SYNC_ENABLED).
    BINANCE_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default('true'),
    // Overridable for tests; defaulted to the verified production URLs.
    // Binance all-market 24h ticker firehose (one stream covers the catalog).
    BINANCE_WS_URL: z.string().min(1).default('wss://stream.binance.com:9443/ws/!ticker@arr'),
    // Kraken WebSocket v2 (public market data).
    KRAKEN_WS_URL: z.string().min(1).default('wss://ws.kraken.com/v2'),
    // retrofit-35: cross-source outlier guard. Ticker symbols are NOT unique across
    // exchanges, so a long-tail collision can produce a confidently-wrong price. With ≥2
    // FRESH sources, a per-exchange tick further than this ratio from the median (×ratio
    // above or ÷ratio below) is dropped as a likely collision / bad print. Default 5 —
    // generous for real volatility, tight enough to catch gross collisions.
    PRICE_OUTLIER_RATIO: z.coerce.number().min(1).default(5),

    // --- Gate.io + KuCoin long-tail streaming (retrofit-36) ---
    // Reachable from this dev host (unlike Binance), so default ON — they un-freeze the
    // long-tail catalog. Same explicit-transform boolean pattern as BINANCE_ENABLED
    // (Boolean("false") === true, so z.coerce.boolean() would never disable).
    GATE_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default('true'),
    GATE_WS_URL: z.string().min(1).default('wss://api.gateio.ws/ws/v4/'),
    KUCOIN_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default('true'),
    // KuCoin's connect flow is token-gated: POST bullet-public for a short-lived token +
    // WS endpoint, then connect to `${endpoint}?token=...`. This is the bullet URL.
    KUCOIN_BULLET_URL: z.string().min(1).default('https://api.kucoin.com/api/v1/bullet-public'),

    // --- OKX + Bybit deep/redundant streaming (retrofit-37) ---
    // Deep, fast coverage of majors/mid-caps that also keeps prices flowing when one venue
    // is down. Same explicit-transform boolean pattern as BINANCE_ENABLED; default ON.
    OKX_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default('true'),
    OKX_WS_URL: z.string().min(1).default('wss://ws.okx.com:8443/ws/v5/public'),
    BYBIT_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default('true'),
    BYBIT_WS_URL: z.string().min(1).default('wss://stream.bybit.com/v5/public/spot'),
    // Stage 12: COINMARKETCAP_API_KEY is now required. Stage 9B's CMC sync is the
    // authoritative token-catalog source; booting without the key silently disables
    // price refreshes in a way that's hard to notice in production.
    COINMARKETCAP_API_KEY: z.string().min(1),

    // --- Real historical prices for chart backfill (retrofit-42) ---
    // CoinGecko is the historical-price source for `npm run backfill:snapshots`. The key is
    // OPTIONAL: with a free demo key we use the demo host + `x-cg-demo-api-key` header
    // (≈30 req/min); without one the public host works but is slow + 429-prone. A free demo
    // key is strongly recommended for the backfill. NOTE: the demo key uses the SAME public
    // base, just with the header — only a PAID/pro key needs the pro-api host.
    COINGECKO_API_KEY: z.string().optional(),
    COINGECKO_BASE: z.string().min(1).default('https://api.coingecko.com/api/v3'),
    // Cap on how many tokens get REAL daily history in the backfill (held tokens are always
    // included on top of this; the long tail gets a synthetic series so every chart still
    // renders). Lower it for a faster keyless run. Default 250.
    REAL_HISTORY_LIMIT: z.coerce.number().int().min(1).default(250),

    // --- NFT spam: behavioral bulk signal (retrofit-86, H13.1) ---
    // A non-allowlisted contract held this many times in ONE wallet is treated as a bulk airdrop
    // (e.g. "Hefty Presents" ×17). Default 10 clears the observed legit max in the demo wallet (4)
    // with wide margin so a normal collector is never hidden; the Show-spam toggle + per-NFT manual
    // override (spamOverride) are the escape hatches for the residual edge case. Provider flags +
    // curated blocklist are PRIMARY; this is a SECONDARY, allowlist-guarded signal.
    NFT_BULK_SPAM_MIN: z.coerce.number().int().min(2).default(10),

    // --- Email ---
    RESEND_API_KEY: z.string().min(1),
    EMAIL_FROM_ADDRESS: z.string().min(1),

    // --- Server ---
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    // --- Logging ---
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    // --- Auth rate-limiting & lockout (Build Guide Appendix item 10) ---
    // Both are optional with sensible defaults; set them in .env for production.
    AUTH_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
    AUTH_LOGIN_LOCKOUT_MS: z.coerce.number().int().min(1000).default(900000),
    // Coarser per-IP cap (audit SEC): one IP spraying many accounts trips this. Generous vs the
    // per-account limit so shared/NAT egress isn't falsely locked.
    AUTH_LOGIN_IP_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(50),

    // --- Global IP rate limiting (audit SEC #27) ---
    // Redis sliding-window per trusted client IP, mounted in app.ts. Gated off automatically
    // when NODE_ENV=test so the integration suite (which fires many rapid requests) is
    // unaffected. NOTE: explicit-transform boolean (Boolean("false")===true would never
    // disable). Buckets: GLOBAL on all API routes (except signature-verified webhooks), a
    // tighter AUTH bucket on /auth/*, and a SENSITIVE bucket on provider-fanout + refund.
    RATE_LIMIT_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default('true'),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000),
    RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().min(1).default(240),
    RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(30),
    RATE_LIMIT_SENSITIVE_MAX: z.coerce.number().int().min(1).default(12),

    // --- CSRF protection (audit SEC, decision 7) ---
    // Origin/Referer allowlist on cookie-authed state-changing requests. Gated off when
    // NODE_ENV=test. CSRF_ALLOWED_ORIGINS is an optional comma-separated list ADDED to the
    // implicit allowlist (APP_BASE_URL + API_BASE_URL origins). Explicit-transform boolean.
    CSRF_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default('true'),
    CSRF_ALLOWED_ORIGINS: z.string().optional(),

    // --- Error verbosity (audit SEC error lockdown) ---
    // When true, the global error handler returns the real error message — DEBUGGING ONLY.
    // Default false so production never leaks internal error text. Deliberately NOT keyed on
    // NODE_ENV: a mis-set NODE_ENV must not be able to expose internals. Explicit-transform
    // boolean (Boolean("false") === true would never disable).
    DEBUG_ERRORS: z
      .string()
      .transform((v) => v === 'true')
      .default('false'),

    // --- Price-source debug endpoint (audit SEC #15) ---
    // GET /prices/debug exposes the internal price-feed source topology (which exchanges feed
    // each symbol) to any authenticated user. Throttling is handled by the global IP limiter;
    // this flag is the operator off-switch the finding asks for. Default true preserves current
    // behavior; set false in production to remove the endpoint (404). Explicit-transform boolean.
    PRICE_DEBUG_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default('true'),

    // --- Auth-URL debug logging (audit SEC #13) ---
    // When true, the verification / password-reset / OAuth URLs (which carry single-use
    // tokens) are logged to the console so a dev can test without real email delivery.
    // DELIBERATELY gated on this explicit opt-in, NOT on NODE_ENV: a mis-set NODE_ENV on an
    // internet-reachable staging box must never leak a token URL into the logs. Default false.
    // Explicit-transform boolean (Boolean("false") === true would never disable).
    DEBUG_AUTH_URLS: z
      .string()
      .transform((v) => v === 'true')
      .default('false'),

    // --- Webhook body size cap (audit SEC #19) ---
    // Hono bodyLimit on /webhooks/*: an unauthenticated caller can otherwise stream an
    // unbounded body that c.req.text() buffers fully BEFORE the signature check, a memory
    // DoS. 1 MiB clears a single block's batched Moralis transfers and any Stripe event
    // with wide margin; anything larger is rejected with 413 before we read it.
    WEBHOOK_MAX_BODY_BYTES: z.coerce.number().int().min(1024).default(1048576),

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

    // --- Connected-wallet token re-price (retrofit-48) ---
    // Periodic refresh of auto-listed connected-wallet tokens (not on the live firehose).
    // NOTE: explicit transform, NOT z.coerce.boolean() — Boolean("false") === true, so
    // coercion would never disable it (same gotcha as TOKEN_SYNC_ENABLED / SNAPSHOT_ENABLED).
    CONNECTED_REPRICE_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default('true'),
    CONNECTED_REPRICE_CRON: z
      .string()
      .default('*/30 * * * *')
      .refine((v) => cron.validate(v), 'CONNECTED_REPRICE_CRON must be a valid cron expression'),

    // --- Live price → Token.currentPrice flush (retrofit-70 fix #2) ---
    // Short-interval flush of the canonical live `price:<SYM>` ticks into Token.currentPrice
    // so currentPrice-fallback reads (overview allocation, daily token_price_snapshot, token
    // pages) aren't hours behind the feed. NOTE: explicit transform, NOT z.coerce.boolean() —
    // Boolean("false") === true, so coercion would never disable it (same gotcha as
    // TOKEN_SYNC_ENABLED / SNAPSHOT_ENABLED). Default ON.
    LIVE_PRICE_FLUSH_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default('true'),
    LIVE_PRICE_FLUSH_CRON: z
      .string()
      .default('*/5 * * * *')
      .refine((v) => cron.validate(v), 'LIVE_PRICE_FLUSH_CRON must be a valid cron expression'),

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

    // --- Avatar object storage (Cloudflare R2, retrofit-90) ---
    // R2 is S3-compatible. All five connection vars are OPTIONAL: when any is missing,
    // `isAvatarStorageConfigured` (below) is false and the avatar upload endpoint returns
    // 503 AVATAR_STORAGE_UNAVAILABLE — the rest of the app is unaffected and still boots.
    // The `neonfi` bucket is reused; avatar objects live under the `avatars/` key prefix and
    // are served public-read from R2_PUBLIC_BASE_URL (https://images.neonfi.live).
    R2_ENDPOINT: z.string().url().optional(),
    R2_ACCESS_KEY_ID: z.string().min(1).optional(),
    R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    R2_BUCKET: z.string().min(1).optional(),
    R2_PUBLIC_BASE_URL: z.string().url().optional(),
    // Upload guardrail (sensible default; overridable). Backstop only — the frontend
    // downsizes before upload, so payloads are normally small.
    AVATAR_MAX_BYTES: z.coerce.number().int().min(1024).default(5 * 1024 * 1024), // 5 MB

    // --- DB keep-alive ping (retrofit-17 Part 3) ---
    // OPTIONAL, default OFF. When true, src/index.ts runs `SELECT 1` every 4 min
    // to keep the Neon compute from scale-to-zero auto-suspend (which causes the
    // slow/erroring first request after idle). TRADEOFF: this consumes free-tier
    // compute-hours continuously, defeating scale-to-zero's savings — opt in only
    // for active dev. NOTE: explicit transform, NOT z.coerce.boolean() —
    // Boolean("false") === true, so coercion would never disable it (same gotcha
    // as BINANCE_ENABLED / TOKEN_SYNC_ENABLED / SNAPSHOT_ENABLED).
    DB_KEEPALIVE_ENABLED: z
      .string()
      .transform((v) => v === 'true')
      .default('false'),
  });
  // DATABASE_URL_TEST and REDIS_URL_TEST are mandatory when NODE_ENV=test.
  // validateTestIsolation() compares logical database/cache targets and exits
  // before Prisma or Redis clients are created if tests would touch runtime
  // resources.

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

const isolationIssues = validateTestIsolation(process.env);
if (isolationIssues.length > 0) {
  const issues = isolationIssues
    .map((i) => `  - ${i.key}: ${i.message}`)
    .join('\n');
  // Never print connection strings here. The variable names and reason are enough
  // for operators to fix test isolation without exposing credentials in logs.
  // eslint-disable-next-line no-console
  console.error(`\n[config] Unsafe test environment:\n${issues}\n`);
  process.exit(1);
}

export type Config = z.infer<typeof schema>;

export const config: Config = parsed.data;

export const isProduction = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';

// retrofit-90: true only when EVERY R2 connection var is set. The avatar upload/clear
// endpoint 503s cleanly when this is false, so the app boots on machines without R2.
export const isAvatarStorageConfigured =
  !!config.R2_ENDPOINT &&
  !!config.R2_ACCESS_KEY_ID &&
  !!config.R2_SECRET_ACCESS_KEY &&
  !!config.R2_BUCKET &&
  !!config.R2_PUBLIC_BASE_URL;
