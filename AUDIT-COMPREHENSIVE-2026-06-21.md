# NeonFi — Comprehensive Audit Report

**Date:** 2026-06-21  
**Scope:** `neonfi-backend` (Hono + TypeScript + Prisma + Redis + WebSockets, 139 source files / ~21k LOC) and `Neonfi` frontend (SvelteKit 2 + Svelte 5 runes, 82 source files / ~25k LOC).  
**Method:** 43 specialist audit agents reading every source file in full, across four lenses — code quality, performance/resource efficiency, security, and documentation divergence — plus two cross-cutting duplication/dead-code sweeps. Findings are de-duplicated only where exact; near-duplicates surfaced by independent agents are kept as distinct rows for transparency.  
**Total findings:** 470  (1 critical, 32 high, 99 medium, 270 low, 68 info)

> This report is descriptive — **no code was changed.** Each finding cites an exact `file:line` and a concrete fix. Severities reflect real exploitability/impact, not theoretical risk.

---

## Executive Summary

NeonFi is a well-structured, layered application (controller → service → repository, shared DTO/schema modules) that has clearly been hardened through many retrofit iterations. The architecture is sound; most findings are **incremental correctness, efficiency, and consistency issues** rather than fundamental design flaws. That said, the audit surfaced **one critical security defect, 32 high-severity issues**, and a large tail of medium/low cleanups that together represent meaningful technical debt and a few real production risks.

### The one thing to fix first

**🔴 CRITICAL — Moralis webhook idempotency key is constant per stream** (`src/modules/webhooks/moralis-handlers.ts:159`). The idempotency guard keys off the stream id rather than the individual delivery, so after the *first* webhook is processed, **every subsequent on-chain event for that stream is silently dropped for 30 days**. For connected wallets this means transfers/price-driven balance updates stop syncing after the first event — a silent data-integrity failure that looks like "the app just stopped updating." Fix: key idempotency off per-delivery content (e.g. `keccak256(rawBody)`, which already exists as a fallback, or `streamId + chainId + block.number + logIndex`).

### Highest-impact themes

**Security (1 critical · 4 high).** Beyond the Moralis key: (1) **no global/IP rate limiting anywhere** — `register`, `login`, `password-reset/confirm`, `verify-email`, and `refresh` are completely unthrottled, enabling brute force, credential stuffing, and email-enumeration/DoS; (2) the **refund flow never revokes Pro access nor cancels the Stripe subscription**, allowing recurring refund abuse while keeping paid features; (3) **`VITE_MOCK_AUTH` is a build-time auth bypass** that is currently `=true` on disk — if a production build picks up that `.env`, all auth guards vanish. Backend route protection is solid (cookie auth + ownership checks); the static frontend correctly treats its guards as UX-only. A recurring smell is over-reliance on a single `NODE_ENV==="production"` switch governing error leakage, token logging, and cookie `Secure` flags.

**Performance (63 findings, 12 high).** The hot paths have clear wins: (1) `/overview` **fetches each portfolio's assets twice** and re-runs the live-price map a second time — the single biggest server-side redundancy; (2) the **price resolver does ~13 sequential Redis round-trips per exchange tick with no pipelining**, a sustained firehose under live market data; (3) `/prices/refresh` runs a **blocking `redis.keys('overview:*')`** keyspace scan on every call; (4) the frontend **rebuilds entire SVG chart geometry on every price tick** (dashboard + performance pages) because the live total overwrites the last data point; (5) several **N+1 fan-outs** (wallet page = 3 REST calls per portfolio; `recalc.ts` unindexed symbol scans in bulk loops; connected-reprice making per-token CoinGecko calls).

**Code quality (282 findings across both stacks).** The dominant pattern is **duplicated business rules that can drift out of sync**: the "subscription effectively active" predicate is re-implemented in 5 places; the CMC `fetchPrices` dedup still carries the exact market-cap-collision bug that was already fixed in its two sibling functions; the refund-eligibility window is hardcoded inconsistently (3 days vs 7 days vs the server flag) across three spots in the payments page. There is a steady supply of **dead code** (unused repository functions `createUser`/`updateUserOnboardingStatus`, unused schemas/interfaces) and a notable **functional bug**: the Add-Transaction modal lets the user pick a portfolio-transfer destination token that is **never sent to the backend**.

**Documentation divergence (74 findings).** The code has deliberately moved past the written specs in several places — most prominently the **WebSocket contract**: the spec describes a per-symbol `subscribe` handshake + flat `{symbol,price,change24h}` payload, but the implementation is a **broadcast firehose with a `payload.prices[]` batch** (a real product decision from retrofit-28 that the docs were never updated to match). Schema drift is also documented-vs-real: `BalanceSnapshot` PK is now composite, `Transaction.transactionHash` uniqueness is per-portfolio not global, `Payment.subscriptionId` is nullable + `SetNull`, and `GET /auth/google` replaced the spec's `POST`. None of these are bugs — they are **stale specs** that should be reconciled so the docs remain a source of truth.

### Findings by severity

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 32 |
| Medium | 99 |
| Low | 270 |
| Info | 68 |
| **Total** | **470** |

### Findings by dimension

| Audit dimension | Findings |
|---|---|
| Security | 51 |
| Performance & resource efficiency | 63 |
| Code quality — backend | 159 |
| Code quality — frontend | 123 |
| Documentation divergence | 74 |
| **Total** | **470** |

### Prioritized — all Critical & High findings

> Note: docs rows 23–33 cluster around the same WebSocket-contract divergence, independently reported by the architecture, API-contract, implementation, and frontend doc-checkers. Treat them as **one reconciliation task**.

| # | Sev | Area | Location | Issue | Recommended fix |
|---|-----|------|----------|-------|-----------------|
| 1 | **CRIT** | SEC | BE:src/modules/webhooks/moralis-handlers.ts:159-165, 503-508, 581 | Moralis idempotency key is constant per stream — every webhook after the first is silently dropped for 30 days | Make the idempotency key unique PER DELIVERY, not per stream. Best option: key off content that is unique per event — e.g. keccak256(rawBody) (the existing fallback), or… |
| 2 | High | Q-BE | BE:src/modules/tokens/sync/coinmarketcap-provider.ts:206-208 | CMC fetchPrices dedup uses market-cap-only — the exact bug fetchMetadata/fetchTopTokens were fixed for (TON/junk-ticker collision) | Reuse the same lowest-cmc_rank-then-market_cap reducer used in fetchMetadata. Extract a shared `pickBestEntry(entries)` helper and call it from all three resolution site… |
| 3 | High | Q-BE | BE:src/lib/moralis-streams-client.ts:58-68 | createStream's address-add fetch ignores HTTP status — failure silently leaves a stream watching no address | Check `res.ok` on the address-add response and throw (or at minimum log a clear error) when it fails, consistent with the create and delete calls. The caller treats a th… |
| 4 | High | Q-BE | BE:src/lib/health.ts:46-59 | /health returns 503 (whole app marked unhealthy) when the Coinbase WS feed is transiently down | Treat Coinbase as a non-fatal/informational signal in the liveness probe: keep `coinbase` in the response body but compute `ok` from DB+Redis only (or expose Coinbase vi… |
| 5 | High | Q-FE | FE:src/routes/(dashboard)/payments/+page.svelte:68-80, 177-191, 358-3… | Two independent refund flows both call the same endpoint that ignores which payment was selected | Consolidate to one refund entry point. If the backend only refunds the most-recent eligible payment, remove the per-row refund affordance (or send the selected paymentId… |
| 6 | High | Q-FE | FE:src/routes/(dashboard)/payments/+page.svelte:90-94, 185, 315, 358,… | Refund eligibility window is inconsistent across three places (3 days vs 7 days vs server flag) | Use a single source of truth — the server refundAvailable flag — for every refund affordance, and derive all copy from one constant. Remove the client-side isEligible()… |
| 7 | High | Q-FE | FE:src/lib/components/modals/AddTransactionModal.svelte:138-160, 195,… | Portfolio-transfer destination token is selected but never sent to the backend | Either pass the chosen destination token to the transfer API (and have the backend record the destination leg in that token) or remove the destination-token picker + its… |
| 8 | High | PERF | BE:src/modules/overview/overview.service.ts:265-297, 113-127, 274-275 | Overview re-fetches each portfolio's assets twice (computeDerived + findAllAssetsByPortfolioId) and re-runs getLivePriceMap a 2nd time | Fetch each portfolio's assets+token ONCE (e.g. a single `prisma.asset.findMany({ where:{ portfolioId:{ in: ids } }, include:{token:true} })` grouped by portfolioId), pas… |
| 9 | High | PERF | BE:src/modules/transactions/recalc.ts:51-74 | recalcAssetBalance runs an unindexed symbol scan on detail tables and adds a per-call portfolio/token lookup, amplified by bulk loops | Add @@index([symbol]) (or a composite the filter can use) to NativeTransactionDetail and Erc20TransactionDetail. In bulk loops, fetch the portfolio.type ONCE and pass it… |
| 10 | High | PERF | BE:src/modules/prices/prices.service.ts:155-156 | redis.keys('overview:<userId>:*') runs a blocking O(keyspace) scan on every /prices/refresh | Replace KEYS with a non-blocking SCAN cursor loop (MATCH overview:<userId>:* COUNT 100), or better, eliminate the wildcard entirely: the overview cache key has a bounded… |
| 11 | High | PERF | BE:src/lib/price-resolver.ts:101-103, 113, 205-235 | recordTick performs ~13 sequential Redis round-trips per exchange tick with no pipelining | Pipeline the per-tick writes: combine the per-exchange SET with the canonical SET/PUBLISH (and the history LPUSH+LTRIM+EXPIRE) into a single redis.pipeline().exec() so e… |
| 12 | High | PERF | BE:src/lib/price-resolver.ts:101-104, 111-113, 205 | resolveCanonical runs an 8-key MGET + SET (+ optional PUBLISH) on every single exchange tick — sustained Redis firehose | Pipeline the per-tick Redis work (single MULTI/pipeline for the per-exchange SET + the canonical SET) to cut round-trips. Keep the per-exchange ticks in an in-process Ma… |
| 13 | High | PERF | BE:src/modules/wallet-data/reprice.ts:47-71 | Connected-reprice job makes a per-token CoinGecko HTTP call per wallet, including non-auto-listed tokens — chatty N×M external fan-out, no batching | Restrict the reprice loop to tokens actually known to be autoListed for that wallet (query the autoListed asset/token rows up front and intersect with the summary), so n… |
| 14 | High | PERF | BE:src/modules/overview/overview.service.ts:274-275, 113-127 (derive.… | Overview re-fetches each portfolio's assets twice (computeDerived + findAllAssetsByPortfolioId) — duplicate identical asset+token queries | Fetch assets+token once per portfolio in buildOverview, then pass the already-loaded assets (and a single overview-wide live-price map) into a pure deriveFromAssets() so… |
| 15 | High | PERF | FE:src/lib/ws.ts:68-93 | Price firehose applies every single-symbol tick individually, cloning two full Maps per frame with no client-side coalescing | Coalesce the firehose on the client: buffer incoming frames into a pending Map and flush once per animation frame (requestAnimationFrame) or every ~250-500ms, doing a SI… |
| 16 | High | PERF | FE:src/routes/(dashboard)/dashboard/+page.svelte:26-28,88-138,207-212 | Dashboard portfolio chart rebuilds all SVG path geometry on every price tick because the last point is overwritten with the live total | Decouple the static historical geometry from the live tip. Build `chartXs/chartYs/chartLine/chartArea` from the IMMUTABLE `data.chartPoints` once per range/data change,… |
| 17 | High | PERF | FE:src/routes/(dashboard)/performance/+page.svelte:37-39,104-171,186-… | Performance page chart mutates pcPts last point with live total, forcing full path/area/tick recompute per tick (same pattern as dashboard) | Same as finding 2: render the static line from `pcWindow` values (recomputed only on range/series change) and overlay only the live tip segment + dot per tick. Avoid re-… |
| 18 | High | PERF | FE:src/routes/(dashboard)/dashboard/+page.ts:153-228 (load); navigati… | Dashboard refetches the entire /overview + transactions(limit=500) + /prices/history on every chart range click | Decouple the chart range from the page load like the performance page does. Fetch once at the widest window (e.g. days=1095 or the 365 cap) and re-window the chart clien… |
| 19 | High | PERF | FE:src/routes/(dashboard)/wallet/+page.ts:239-269 | Wallet page does an N+1 fan-out: 3 REST calls per portfolio (assets + transactions + nfts) on top of the list call | Add a backend bulk endpoint (e.g. /overview already returns per-portfolio holdings + assetCount + totalValue; extend it or add /portfolios/full) so the wallet page can h… |
| 20 | High | SEC | BE:src/app.ts:32-76 | No global / IP-based rate limiting on any endpoint — register, verify-email, refresh, and reset-confirm are completely unthrottled | Add a global IP-based rate-limit middleware (Redis sliding-window, keyed on a TRUSTED client IP) mounted in app.ts, with tighter buckets on the /auth/* mutating endpoint… |
| 21 | High | SEC | FE:.env:.env:3 (VITE_MOCK_AUTH=true); src/routes/(dashboard)/+layout.… | VITE_MOCK_AUTH dev bypass is build-time and would fully disable auth if a build picks up the on-disk .env (currently VITE_MOCK_AUTH=true) | Make mock-auth impossible to ship: (1) also gate on import.meta.env.DEV, e.g. `const MOCK = import.meta.env.DEV && import.meta.env.VITE_MOCK_AUTH==='true'`, so productio… |
| 22 | High | SEC | BE:src/modules/subscriptions/subscriptions.service.ts:384-428 | Refund does not revoke Pro access or cancel the Stripe subscription — recurring refund abuse | On refund, also cancel/expire the subscription: call stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: true }) (or immediate cancel for a money-b… |
| 23 | High | DOCS | BE:prisma/schema.prisma:400, 422 | Transaction.transactionHash uniqueness scope changed: spec is GLOBAL @unique, impl is per-portfolio composite | Update the spec to the per-portfolio composite uniqueness (the impl behavior is deliberate and correct for shared/re-added wallets), so the documented constraint matches… |
| 24 | High | DOCS | BE:prisma/schema.prisma:197-198 | Payment.subscriptionId nullability and onDelete reversed vs spec (required+implicit Restrict -> optional+SetNull) | Update spec Payment.subscriptionId to nullable + onDelete: SetNull to match the account-deletion requirement, or reconcile intent. |
| 25 | High | DOCS | BE:prisma/schema.prisma:563, 580 | BalanceSnapshot primary key changed from `id` to composite (portfolioId, snapshotDate) | Update the spec to reflect the composite PK on (portfolioId, snapshotDate) with id as a non-PK column, matching the TimescaleDB requirement. |
| 26 | High | DOCS | BE:src/ws/server.ts:180-204, 11-17, 152-171 | WebSocket fan-out is a global broadcast firehose, not the spec's per-token subscription registry | Either update the architecture spec to document the broadcast-firehose design (the actual product decision per retrofit-28) or implement the per-token registry + subscri… |
| 27 | High | DOCS | BE:src/ws/server.ts:193-197 | price_update message payload shape diverges from spec (prices[] array vs flat {symbol,price,change24h}) | Align the wire shape — either emit the documented flat `payload:{symbol,price,change24h}` or update the spec to the `payload.prices[]` batch shape actually sent. |
| 28 | High | DOCS | BE:src/ws/server.ts:193-197 | WS price_update payload shape diverges from spec (nested `prices[]` array vs flat `{symbol,price,change24h}`) | Either update the written spec (System_Architecture WebSocket section + Build Guide §2.7) to document the firehose `payload.prices[]` shape as the authoritative contract… |
| 29 | High | DOCS | BE:src/ws/server.ts:158-204 | WS server broadcasts every price to every socket; no `symbol → [socketIds]` subscription registry (subscribe/unsubscribe protocol dropped) | Reconcile the System_Architecture WebSocket/Price Module sections to document the firehose model, or restore the subscription registry + subscribe protocol. The frontend… |
| 30 | High | DOCS | BE:src/modules/auth/auth.controller.ts:230-274 | POST /auth/google documented but built as GET /auth/google (verb mismatch + split into two endpoints) | Either add a `POST /auth/google` token-exchange endpoint matching the documented contract, or update architecture.txt + Build Guide + implementation.txt to specify the r… |
| 31 | High | DOCS | BE:src/ws/server.ts:193-197 | WebSocket price_update payload nests an array (payload.prices[]) instead of the documented flat payload.{symbol,price,change24h} | Reconcile the WS broadcast with the frontend ws.ts consumer: either restore the documented `payload: { symbol, price, change24h }` per-symbol shape, or confirm ws.ts was… |
| 32 | High | DOCS | BE:src/ws/server.ts:160-162 | Inbound WebSocket 'subscribe' message and per-symbol subscription registry (symbol → [socketIds]) are not implemented | Decide explicitly: either implement the documented per-symbol registry + subscribe protocol, or update architecture.txt WebSocket section + Build Guide §2.7/Stage 10 to… |
| 33 | High | DOCS | FE:src/lib/ws.ts:62-93 | WebSocket price_update contract diverges from spec: firehose batch payload + no subscribe handshake | Either update the spec (architecture.txt WebSocket section + build-guide §2.7) to document the retrofit-28 firehose contract (`payload.prices[]` batch, no per-client sub… |

---

## Contents

1. **Security** — auth, IDOR, injection, webhooks, SSRF, rate-limiting, payments integrity, frontend
2. **Performance & Resource Efficiency** — DB/N+1, Redis/caching, external-API fan-out, hot-path compute, frontend rendering & network
3. **Code Quality — Backend** — dead code, duplication, spaghetti, hardcoded values, smells
4. **Code Quality — Frontend** — components, modals, routes, styling, dead/duplicated UI logic
5. **Documentation Divergence** — schema, architecture, implementation, API contract, frontend vs. the written specs
6. **Appendices** — methodology, API/WS inventory, full breakdown

---

## Security

NeonFi's security posture rests almost entirely on a single trust boundary — the cookie-authenticated backend — with the frontend's static deploy reducing all route guards to UX-only client code. The most serious issues are a constant Moralis idempotency key that silently drops every webhook after the first per chain (critical), a refund flow that never revokes Pro access (high), a complete absence of IP/global rate limiting (high), and a build-time mock-auth flag that ships full auth bypass if a stray `.env` is picked up (high). A recurring theme is over-reliance on `NODE_ENV === 'production'` as the single switch governing error-message leakage, token logging, and cookie `Secure` flags.

**Severity tally:** Critical: 1 · High: 4 · Medium: 9 · Low: 21 · Info: 9

Note: the JWT algorithm-pinning issue and the per-email-lockout DoS each appear multiple times in the source findings at differing severities; these near-duplicates are retained as distinct rows below (rows 2, 14, 30, 35, 48 for JWT; rows 1, 28 for lockout) and consolidated in the write-ups where applicable.

| # | Sev | Category | Location (file:lines) | Issue | Recommended fix |
|---|-----|----------|-----------------------|-------|-----------------|
| 1 | Medium | security | src/lib/lockout.ts:18-26,39-54; auth.service.ts:146-171 | Lockout keyed only on email; check runs before password verify, so any known email can be locked out by 5 bad attempts (15 min) with no per-IP cost | Add per-IP failure dimension + global per-IP budget; exponential backoff/CAPTCHA step-up instead of weaponizable hard lock |
| 2 | Low | security | src/lib/jwt.ts:44-49 | `jwtVerify` lacks `algorithms` allowlist; safe today only via jose's implicit symmetric-key guard | Pass `{ algorithms: ['HS256'] }` |
| 3 | Low | security | src/modules/auth/auth.service.ts:10-13,355-376 | Non-rotating refresh tokens; stolen token valid for full lifetime, no reuse detection | Rotate refresh token + hash each refresh; detect reuse and revoke session family |
| 4 | Low | security | src/modules/users/users.schemas.ts:24-29; users.service.ts:14-23 | `PATCH /users/me` accepts arbitrary external `avatarUrl`, bypassing validated upload pipeline (outbound-image/beacon vector) | Drop `avatarUrl` from patch schema or constrain to R2 public base host |
| 5 | Info | security | src/ws/server.ts:180-204 | WS firehose broadcasts every price tick to every socket with no per-user scoping (public data) | No action for confidentiality; use `socketsByUser` targeting if user-specific data is ever pushed |
| 6 | Low | security | Neonfi/src/hooks.server.ts:24-28; (dashboard)/+layout.ts:27-37; .env | `VITE_MOCK_AUTH=true` short-circuits client route guards; build-time constant, risky if inherited by prod build | Force `false`/unset in prod; CI guard fails build if `true`; remove bypass |
| 7 | Low | security | src/modules/portfolios/portfolios.schemas.ts:5-6,51-54 | `walletAddress` is `z.string().min(1)` with no max/format; multi-MB string parsed before later regex rejects it | Add `.max(64)` + EVM/Solana regex at schema layer |
| 8 | Low | security | src/modules/transactions/transactions.service.ts:284-322 | Webhook path skips Zod; `BigInt(...)` on untrusted strings throws → 500 without dedupe → infinite Moralis retry; no magnitude cap | Guard BigInt conversions as deterministic skip; run body through `CreateTransactionBodySchema.safeParse` |
| 9 | Info | security | src/modules/prices/prices.service.ts:323-333 | `getPriceDebug` interpolates unvalidated `symbol` query into Redis key names (not injectable, literal GET) | Validate symbol with `z.string().min(1).max(20).regex(/^[A-Za-z0-9]+$/)` |
| 10 | Medium | security | src/app.ts:69-73 | Global `onError` returns raw `e.message` whenever `NODE_ENV !== 'production'`; leaks provider bodies/IDs/DB detail | Always return generic message; gate verbose mode behind explicit `DEBUG_ERRORS` flag |
| 11 | Low | security | src/lib/moralis-streams-client.ts:51-54,77-80 | Upstream Moralis response body concatenated into thrown Error → reaches client via 500 handler in non-prod; also logged | Log upstream body server-side only; throw fixed internal message |
| 12 | Info | security | src/modules/email/email.service.ts:50,57,64; auth.service.ts:124,278,315 | User email (PII) logged in cleartext across email/auth flows | Log internal user id / redacted email; gate behind `LOG_LEVEL=debug` |
| 13 | Low | security | src/modules/auth/auth.service.ts:123-124,277-278,314-315 | Full verification/reset/OAuth token URLs logged to console (dev-gated by single `isProduction`) | Require explicit DEBUG flag; never log token; fail-fast on unrecognized `NODE_ENV` |
| 14 | Low | security | src/lib/jwt.ts:44-49 | `verifyAccessToken` does not pin JWT algorithm (HS256) | Pass `{ algorithms: ['HS256'] }` |
| 15 | Low | security | src/modules/prices/prices.controller.ts:98-102 | `/prices/debug` (requireAuth only) exposes internal price-feed source topology to any user; unthrottled mget | Restrict to admin/operator role or remove from prod; rate-limit |
| 16 | Info | security | src/app.ts:32-76 | No CORS or security-header middleware configured (conservative for cookie API; documented gap) | Keep CORS closed; add explicit allowlist + `secureHeaders()`/CSP if ever needed |
| 17 | Critical | security | src/modules/webhooks/moralis-handlers.ts:159-165,503-508,581 | Idempotency key `streamId_chainId_tag` is constant per stream → first event pins key 30 days, all later transfers acked-and-dropped; balances silently stop updating | Make key unique per delivery (keccak256(rawBody) or streamId+chainId+block#+blockHash+txHash+logIndex); add regression test |
| 18 | Medium | security | src/modules/webhooks/moralis-handlers.ts:100,482-593 | `confirmed` flag never read; unconfirmed events ingested and never reconciled on reorg | Process only `confirmed===true` (ack others) or track + reconcile; include flag in idempotency key |
| 19 | Medium | security | src/modules/webhooks/webhooks.controller.ts:13-14,26; moralis-handlers.ts:484 | Webhook bodies buffered unbounded via `c.req.text()` before signature check → unauth memory/CPU DoS | Apply Hono `bodyLimit` (256KB–1MB) to webhook routes; return 413 early; rate-limit `/webhooks/*` |
| 20 | Low | security | src/app.ts:69-73 | (dup of #10) Global handler leaks `e.message` in non-prod, including internet-reachable staging | Gate verbose bodies on explicit DEBUG flag; never return `e.message` on internet-facing deploys |
| 21 | Low | security | src/modules/webhooks/webhooks.service.ts:61-103 | Stripe dedupe key set only after side effects; partial-failure/crash → re-dispatch; duplicate emails/`plan_changed` publishes | Rely on DB idempotency; claim key with `SET NX` before dispatch, clear on failure; derive side effects from idempotent transitions |
| 22 | Low | security | src/modules/webhooks/moralis-handlers.ts:131-153,226-271,296-348 | Moralis payload consumed with no Zod; `BigInt`/`10n**BigInt(decimals)` on raw strings can throw or allocate huge BigInt → retry loop / CPU | Zod schema (numeric regex, decimals ≤36, address format); try/catch BigInt → deterministic skip |
| 23 | Low | security | src/modules/users/users.schemas.ts:24-29 | (dup of #4) `avatarUrl` accepts arbitrary off-site URL, bypassing avatar sniff; self-scoped image beacon | Constrain to R2 public base or reject from profile patch; https-only + host allowlist |
| 24 | Low | security | src/modules/portfolios/portfolios.controller.ts:80-96 | `POST /wallet/preview` has no rate limit; authed user loops valid addresses to burn provider credits / proxy lookups | Add per-user/IP cooldown mirroring `resync_cooldown` |
| 25 | Info | security | src/modules/tokens/canonical-price.ts:44-47 | Auto-listed token `contract` interpolated into CoinGecko URL without re-validating address shape (provider-sourced) | Validate contract against EVM/base58 shape or URL-encode before fetch |
| 26 | Info | security | src/modules/wallet-data/providers/moralis.ts:149-153 | `ipfs://` rewrite appends unsanitized path to fixed gateway (host hardcoded; client-render only) | Strip/encode path after `ipfs://`, validate CID shape, length-cap; add frontend `img-src` CSP |
| 27 | High | security | src/app.ts:32-76 | No global/IP rate limiting anywhere: register (bcrypt-12 CPU DoS), verify-email, password-reset/confirm, refresh, wallet/preview all unthrottled | Add Redis sliding-window IP limiter (trusted-proxy IP) globally, tighter on `/auth/*` mutations + provider-fanout routes |
| 28 | Medium | security | src/lib/lockout.ts:13-26,49-53 | (dup of #1) Per-email-only lockout enables targeted account-lockout DoS against any victim; useless vs email-rotating spray | Pair with per-IP counter + global per-IP login limit; consider (email+IP) scope or CAPTCHA |
| 29 | Medium | security | src/modules/auth/auth.service.ts:155-171 | Timing enumeration: bcrypt (~300ms) runs only when account exists with password; fast path leaks "registered user" despite uniform error | Always compare against a precomputed dummy hash on missing/no-password user |
| 30 | Low | security | src/lib/jwt.ts:44-48 | (dup) JWT verify omits algorithm allowlist; attacker could force HS384/HS512 against same secret | Pass `{ algorithms: ['HS256'] }` |
| 31 | Low | security | src/modules/auth/auth.service.ts:85-91 | `register()` returns 409 `EMAIL_ALREADY_REGISTERED` → direct account-existence oracle on unthrottled endpoint | Throttle per IP; consider verification-mediated uniform response if enumeration resistance needed |
| 32 | Low | security | src/modules/auth/auth.service.ts:255-263,292-299 | Reset/resend throttle is per-email 60s only; rotating recipient abuses Resend quota / uses app as spam relay | Add per-IP + global cap alongside per-email window |
| 33 | Low | security | src/lib/cookies.ts:23-43 | Cookie session auth with no CSRF token; relies solely on `SameSite=Lax` | Add double-submit CSRF token or Origin/Referer allowlist for state-changing requests |
| 34 | Medium | security | Neonfi/svelte.config.js:1-20; +layout.ts:1; src/hooks.server.ts:13-86 | adapter-static + `prerender=true` strips server bundle → `hooks.server.ts` auth guard is dead code; route gating is client-only | Treat backend as sole trust boundary; document guard as UX-only; use Node/edge adapter or nginx cookie check if server gating required |
| 35 | High | security | Neonfi/.env:3; (dashboard)/+layout.ts:28-37; onboarding/+page.ts:20-29; hooks.server.ts:25-28 | `VITE_MOCK_AUTH` build-time flag fully disables auth (fake Dev User); on-disk `.env` currently `true` | Gate on `import.meta.env.DEV`; build assertion throwing if prod+true; set `.env` to false |
| 36 | Medium | security | Neonfi/src/app.html:1-14; nginx.conf:1-9; svelte.config.js:1-20 | No CSP on any layer; missing X-Frame-Options/nosniff/Referrer-Policy/HSTS; app uses `{@html}` and renders provider image URLs | Add CSP (kit.csp or nginx), `frame-ancestors 'none'`, X-Frame-Options DENY, nosniff, Referrer-Policy, HSTS |
| 37 | Medium | security | Neonfi/.env:5-6 | Live Neon Postgres credentials in plaintext `.env` inside the frontend working tree (unused by frontend) | Remove `DATABASE_URL`/`DIRECT_URL` from frontend; rotate the leaked password |
| 38 | Medium | security | Neonfi/src/lib/api.ts:23-27,57-64 | `credentials:'include'` with no anti-CSRF token; safety hinges on backend SameSite/CORS (not visible to frontend) | Confirm HttpOnly+Secure+SameSite cookie & exact-origin CORS; add double-submit token or required custom header |
| 39 | Low | security | Neonfi/src/lib/ws.ts:60 | WS auth ticket passed in URL query (`?token=`) → exposed to proxy/access logs, history (single-use, public data) | Send ticket in first frame or `Sec-WebSocket-Protocol`; ensure WS logs strip query strings |
| 40 | Low | security | Neonfi/(dashboard)/payments/+page.svelte:52-56; onboarding/+page.svelte:106-111 | `window.location.href = checkoutUrl` with no origin validation → latent open-redirect sink | Parse with `new URL()`, assert https + host endsWith `stripe.com`, else error |
| 41 | Low | security | Neonfi/(public)/design-system/+page.svelte:1-40; static/robots.txt:1-3 | Public crawlable `/design-system` ships internal component gallery in prod | Exclude from prod build / move behind auth / `Disallow: /design-system` |
| 42 | Info | security | Neonfi/src/lib/stores/theme.ts:11,4 | Theme cookie set without `Secure`/`SameSite`; loose substring read (non-sensitive) | Append `; SameSite=Lax; Secure`; tighten read to exact key match |
| 43 | Info | security | Neonfi/src/lib/components/Sidebar.svelte:132 | `{@html item.icon}` (constant-only today) would become XSS sink if input ever dynamic | Keep input compile-time constant; add warning comment; use components/sanitize if dynamic |
| 44 | Info | security | Neonfi/(dashboard)/wallet/+page.svelte:446; NftDetailModal.svelte:73,121; TokenIcon.svelte:35-37,56 | Arbitrary NFT/provider image URLs in `<img src>` with no CSP → external beacon/IP leak on authed pages | Constrain via CSP `img-src` and/or proxy+normalize images through backend |
| 45 | High | security | src/modules/subscriptions/subscriptions.service.ts:384-428 | Refund issues Stripe refund but never cancels subscription or downgrades plan → user keeps Pro and rides renewals refunding each within 3-day window | Cancel/expire subscription + downgrade local plan in same flow (or off `charge.refunded` webhook) |
| 46 | Medium | security | src/modules/subscriptions/subscriptions.service.ts:388-425 | Refund endpoint has no rate limit, no local idempotency guard, no Stripe idempotency key → concurrent double-refund attempts (blocked only by Stripe) | Redis `SET NX` cooldown; set `refundAvailable=false` in DB before Stripe call; pass `idempotencyKey: refund:<paymentId>` |
| 47 | Low | security | src/modules/webhooks/webhooks.service.ts:72-97 | Stripe idempotency is non-atomic check-then-set; concurrent duplicate deliveries both dispatch (bounded by DB unique constraints) | Atomic `SET NX` claim before dispatch; delete key on handler error |
| 48 | Low | security | src/modules/webhooks/stripe-handlers.ts:285-299 | `invoice.payment_failed` uses `payment.create` on `@unique` PI → second event for same PI throws → 500 → infinite Stripe retry, never deduped | Use `payment.upsert` keyed on `stripePaymentIntentId` with `update:{}` |
| 49 | Info | security | Neonfi/(dashboard)/payments/+page.svelte:90-94,185,315 | Refund window UI inconsistent: hint says 7 days, code/policy say 3 days → dispute risk | Single source of truth = 3 days; fix the "7 days" string |
| 50 | Low | security | Neonfi/(dashboard)/payments/+page.svelte:358-365 | Per-row refund eligibility is client-only; backend ignores targeted `paymentId` and always refunds latest → confusing mismatch (server-authoritative) | Accept+validate scoped `paymentId`, or present single "refund latest" action |
| 51 | Info | security | src/lib/jwt.ts:47 | (dup) JWT verify lacks algorithm pin; info-level restatement for payment-authz path | Pass `{ algorithms: ['HS256'] }` |

---

### #17 (Critical) — Moralis idempotency key is constant per stream; every webhook after the first is silently dropped for 30 days

**What it is.** `extractEventId()` derives the replay/idempotency key from `${payload.streamId}_${payload.chainId}_${payload.tag}`. For a live Moralis Stream all three values are immutable for the stream's lifetime — the stream is created once with a single `tag: 'neonfi'`, `streamId` is the fixed stream id, and `chainId` is fixed per chain. So `extractEventId` returns the **same** string for every webhook delivery on a given chain. The handler then treats that constant as a dedupe token.

**Why it matters.** After the first delivery the handler writes `redis.set(\`moralis_event:${eventId}\`, '1', 'EX', REDIS_TTL_30_DAYS)` (2,592,000 s). Every subsequent delivery hits `const seen = await redis.get(...)` and short-circuits with `return c.json(ok({ received: true, duplicate: true }), 200)`. Net effect: the **first** on-chain event ingested per chain pins the key for 30 days, and **all later transfers** (native/erc20/NFT) for every tracked wallet on that chain are acked-and-discarded without ever being written. Connected-portfolio balances and activity feeds silently stop updating — a correctness-and-availability failure that looks like "nothing is broken" because every request returns 200. The unit tests miss it because each test injects a unique `streamId` (`stream-269`, `stream-272`, …), which masks the production constant-key behavior. The body-hash fallback branch is never reached because `streamId`/`chainId`/`tag` are always present.

**Evidence.**
```ts
if (payload.streamId && payload.chainId && payload.tag !== undefined) {
  return `${payload.streamId}_${payload.chainId}_${payload.tag}`;   // constant per stream
}
// ...
const seen = await redis.get(`moralis_event:${eventId}`);
if (seen) { return c.json(ok({ received: true, duplicate: true }), 200); }
// ...
await redis.set(`moralis_event:${eventId}`, '1', 'EX', REDIS_TTL_30_DAYS);
```

**Fix.** Make the idempotency key unique **per delivery**, not per stream. Prefer keying off content that is unique per event — `keccak256(rawBody)` (the existing fallback), or a per-transfer composite. Because Moralis batches multiple logs per delivery, derive the key per transfer:

```ts
function extractEventId(payload: MoralisPayload, rawBody: string): string {
  // unique per delivery; rawBody differs for every distinct webhook
  return `kc:${keccak256(rawBody)}`;
}

// or, for per-transfer granularity inside the loop:
const txKey = `${payload.streamId}_${chainId}_${block.number}_${block.hash}_${tx.hash}_${log.logIndex}`;
```

The `transactionHash` DB unique constraint already provides per-transfer idempotency for fungible transfers, so the Redis dedupe should at minimum include block hash/number so distinct blocks are never collapsed. Add a regression test that posts two **different** payloads sharing the same `streamId`/`chainId`/`tag` and asserts **both** are processed.

---

### #27 (High) — No global or IP-based rate limiting on any endpoint

**What it is.** `createApp()` wires the full route tree with no rate-limiting middleware. A repo-wide search finds only per-module `requireAuth`/`requirePlan`/ownership `.use()` calls and the per-email login lockout — there is no `app.use()` for any IP- or token-based throttle (and no `secureHeaders`/`cors`/`csrf` either).

**Why it matters.** This leaves unthrottled, among others: `POST /auth/register` (account/email spam and a bcrypt cost-12 CPU-exhaustion DoS — each register runs a ~300 ms hash), `POST /auth/verify-email` (token guessing), `POST /auth/password-reset/confirm` (reset-token guessing), `POST /auth/password-reset` (only a per-email 60 s `SET NX`, trivially fanned out across emails), `POST /auth/refresh`, and every authed mutation including `POST /portfolios/wallet/preview`, which fans out to external blockchain providers and can burn paid provider credits. The per-email login lockout is the *only* brute-force control and is itself per-email (see #1/#28). `x-forwarded-for`/`x-real-ip` are read in the auth controller but used only to populate `Session.ipAddress` for display — never for throttling.

**Evidence.**
```ts
const app = new Hono();
// ... no app.use(rateLimit...) anywhere
api.route('/auth', authRouter);
app.route('/api/v1', api);

// auth.controller.ts:111 — IP captured but only stored, never throttled:
const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
        ?? c.req.header('x-real-ip') ?? null;
```

**Fix.** Add a global Redis sliding-window IP limiter mounted in `app.ts`, with tighter buckets on the `/auth/*` mutating endpoints and on provider-fanout routes (`/portfolios/wallet/preview`, `/resync`). Because XFF is attacker-spoofable, derive the client IP from a configured trusted-proxy hop count, not blindly from the first XFF value:

```ts
const limiter = (max: number, windowS: number) => async (c, next) => {
  const ip = trustedClientIp(c);                 // from configured proxy hop count
  const key = `rl:${c.req.path}:${ip}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, windowS);
  if (n > max) return c.json(err('RATE_LIMITED', 'Too many requests'), 429);
  await next();
};
app.use('/api/v1/auth/register',         limiter(5, 3600));
app.use('/api/v1/auth/password-reset/*', limiter(5, 3600));
app.use('/api/v1/auth/*',                limiter(30, 60));
app.use('/api/v1/portfolios/wallet/preview', limiter(10, 60));
```

---

### #35 (High) — `VITE_MOCK_AUTH` build-time flag can ship full auth bypass

**What it is.** A build-time flag `VITE_MOCK_AUTH` short-circuits *all* auth: when `'true'`, `(dashboard)/+layout.ts` returns a fake session `{ user: { id: 'dev', name: 'Dev User', email: 'dev@example.com' }, plan: 'free', onboardingStatus: 'complete' }` with no backend call, and `onboarding/+page.ts` and `hooks.server.ts` do the same. The working-tree `.env` currently has `VITE_MOCK_AUTH=true`, and Vite inlines this at build time.

**Why it matters.** Any build made from a machine where `.env` carries `true` (and `.env.local` is absent or edited) ships a bundle where the entire app is accessible as a fake Dev User with **no backend auth at all**. The current `build/` was made with `.env.local` (`false`) so the mock branch was tree-shaken out, and CI/fresh-clone builds fall back to `.env.example` (unset → false). But there is no *runtime* guard preventing a mock-auth bundle from being deployed — it depends entirely on which dotenv file the build picks up. The TODO comments ("remove this bypass when backend is ready") confirm it was meant to be temporary.

**Evidence.**
```ts
// src/routes/(dashboard)/+layout.ts:29-37
if (MOCK_AUTH) {
  return { session: { user: { id: 'dev', name: 'Dev User', email: 'dev@example.com' /* … */ },
                      plan: 'free', onboardingStatus: 'complete' } };
}
// .env:3
VITE_MOCK_AUTH=true
```

**Fix.** Make a mock-auth bundle impossible to ship:
1. Also gate on `import.meta.env.DEV`, so production `vite build` can never enable it:
   ```ts
   const MOCK_AUTH = import.meta.env.DEV && import.meta.env.VITE_MOCK_AUTH === 'true';
   ```
2. Add a build-time assertion in `vite.config`/`svelte.config` that throws when `mode === 'production' && process.env.VITE_MOCK_AUTH === 'true'`.
3. Set `VITE_MOCK_AUTH=false` in the on-disk `.env` now.

---

### #45 (High) — Refund does not revoke Pro access or cancel the Stripe subscription (recurring refund abuse)

**What it is.** `refundSubscription()` issues a Stripe refund of the most recent succeeded payment but performs **no** subscription cancellation and **no** plan downgrade. It calls only `stripe.refunds.create({ payment_intent })` and returns. `cancel_at_period_end` is never set, unlike `cancelSubscription` and `downgradeSubscription`, which both set it.

**Why it matters.** The subscription stays active after the refund, so (1) the user keeps Pro access, and (2) Stripe renews at the next period, creating a fresh `Payment` row with `refundAvailable: true` (set by `handleInvoicePaymentSucceeded`). Because the refund window is 3 days (`THREE_DAYS_MS`) and the user is refunded their last charge but never downgraded, a user can ride Pro **indefinitely** by refunding each renewal within its 3-day window. `handleChargeRefunded` only flips the `Payment` to `refunded` + `refundAvailable: false`; it never touches subscription status or plan. The frontend `RefundConfirmModal.svelte` explicitly promises the opposite ("Requesting a refund will immediately revert your account to the Free plan"), which is false — confirming the intended behavior diverges from the implementation, and this is a direct revenue-leak / abuse path.

**Evidence.**
```ts
// refundSubscription — no cancel, no downgrade:
await stripe.refunds.create(refundParams);
return { refundRequested: true, paymentId: payment.id };

// handleChargeRefunded — never touches Subscription:
data: { statusId: refundedStatus.id, refundAvailable: false }
```

**Fix.** On refund, also cancel/expire the subscription and downgrade the local plan in the same flow (or drive both off the `charge.refunded` webhook):

```ts
await stripe.refunds.create({ payment_intent: payment.stripePaymentIntentId },
                            { idempotencyKey: `refund:${payment.id}` });
await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true });
await updateSubscriptionById(sub.id, { statusId: cancelledStatus.id, scheduledPlan: 'free' });
```

This makes the modal's promise true and closes the refund-and-keep-Pro loop. (See also #46: add a Redis cooldown, set `refundAvailable=false` before the Stripe call, and pass an idempotency key.)


---

## Performance & Resource Efficiency

This pass examined the read-heavy dashboard aggregation path (`/overview`), the connected-wallet sync/reprice pipelines, the price-resolver firehose, the WebSocket broadcast layer, schema indexing, and the SvelteKit frontend's reactive chart/store stack. The dominant themes are (a) redundant duplicate reads in `buildOverview` (each portfolio's assets, snapshots, and live-price map are fetched multiple times per request), (b) un-pipelined per-tick Redis traffic and un-coalesced WS fan-out in the price subsystem, (c) per-item serialized DB/HTTP round-trips in the connected-wallet sync/ingest loops, and (d) a frontend firehose that clones full Maps and rebuilds entire SVG chart geometry on every single price tick. Several findings overlap (the overview duplicate-asset/duplicate-snapshot/duplicate-mget reads and the price-resolver Redis firehose were each surfaced twice by independent passes); exact duplicates are noted in the table rather than dropped.

**Severity tally:** Critical: 0 · High: 11 · Medium: 18 · Low: 19 · Info: 0 (48 findings total)

| # | Sev | Category | Location (file:lines) | Issue | Recommended fix |
|---|-----|----------|-----------------------|-------|-----------------|
| 1 | High | perf | overview.service.ts:265-297, derive.ts:113-127 | Each portfolio's assets+token fetched twice (computeDerived + findAllAssetsByPortfolioId) and getLivePriceMap run a 2nd time; 2N asset reads + 2 mgets where N+1 suffice | Fetch assets once via `findMany({where:{portfolioId:{in:ids}}})`, pass loaded assets + one union liveMap into a refactored computeDerived |
| 2 | High | perf | overview.service.ts:274-275 (+derive.ts:113-127) | **(dup of #1)** Duplicate identical asset+token `findMany` between computeDerived and findAllAssetsByPortfolioId on cold cache | Same as #1: load assets once, thread into a pure deriveFromAssets() |
| 3 | High | perf | recalc.ts:51-74 | recalcAssetBalance scans Native/Erc20TransactionDetail by **un-indexed `symbol`** + re-fetches portfolio/token/asset per call, amplified in bulk loops (K×) | Add `@@index([symbol])` on both detail tables; pass portfolio.type + token row into recalc instead of per-call findUnique |
| 4 | High | perf | recalc.ts:65-74, schema.prisma:446-489 | **(dup of #3)** Detail queries filter un-indexed `symbol`+relation portfolioId on every tx write; over-fetch full detail+tx+direction rows | Add `@@index([symbol])` (or query via indexed Transaction.portfolioId); use `select` for only needed cols |
| 5 | High | perf | prices.service.ts:155-156 | `redis.keys('overview:<userId>:*')` runs a blocking O(keyspace) scan on every /prices/refresh, stalling the price firehose/ws-auth/derive reads | Replace KEYS with SCAN, or use a per-user version-counter key (`overview:<uid>:<ver>:...`) + INCR for O(1) invalidation |
| 6 | High | perf | price-resolver.ts:101-103,113,205-235 | recordTick does ~4-13 sequential un-pipelined Redis RTTs per exchange tick; dominant Redis load (thousands RTT/sec) | Pipeline per-tick SET+MGET+SET+PUBLISH+history into one `pipeline().exec()` |
| 7 | High | perf | price-resolver.ts:101-104,111-113,205 | **(dup of #6)** resolveCanonical 8-key MGET + SET (+PUBLISH) per tick; mget re-reads the key just SET | Pipeline; keep per-exchange ticks in an in-process Map so resolveCanonical reads memory, only WRITES Redis |
| 8 | High | perf | price-resolver.ts:84-104,111-235 | **(dup of #6)** 3-7 sequential awaited Redis ops per tick defeat ioredis auto-pipelining | Batch into one MULTI/pipeline; debounce per-symbol canonical recompute (~100ms) |
| 9 | High | perf | reprice.ts:47-71 | Connected-reprice does a per-token CoinGecko HTTP GET per wallet (incl. non-auto-listed majors); W×T serial external calls/30min, 429 risk | Intersect with autoListed tokens only; use batch `/simple/token_price/{platform}?contract_addresses=...`; add throttle/backoff |
| 10 | High | perf | Neonfi/src/lib/ws.ts:68-93 | Frontend firehose applies each single-symbol tick individually, cloning **two full Maps per frame** ("no client throttle"); root amplifier of #34-37 | rAF/250-500ms coalesce buffer → single `prices.set(merged)` per flush; skip priceChanges publish when change24h absent |
| 11 | High | perf | Neonfi/.../dashboard/+page.svelte:26-28,88-138,207-212 | Chart rebuilds ALL SVG path geometry every tick because last point is overwritten with live total (invalidates chartXs/Ys/Line/Area/ticks/markers) | Build static geometry from immutable `data.chartPoints` once; render only the live tip segment+dot per tick |
| 12 | High | perf | Neonfi/.../performance/+page.svelte:37-39,104-171,186-192 | **(same pattern as #11)** pcPts mutates last point with live total → full path/area/tick recompute per tick | Static line from pcWindow once; overlay live tip per tick; avoid re-spreading array into Math.min/max |
| 13 | High | perf | Neonfi/.../dashboard/+page.ts:153-228 (+page.svelte:394) | Each range click `goto('?range=')` re-runs full load: /overview + transactions(limit=500) + /prices/history; 1H/1D and 1Y/ALL return identical payloads | Fetch widest window once, re-window client-side (like performance page); collapse redundant ranges; memoize identical /prices/history calls |
| 14 | High | perf | Neonfi/.../wallet/+page.ts:239-269 | N+1 fan-out: 3 REST calls per portfolio (assets+transactions+nfts) on top of list; per-portfolio transactions unbounded (no limit) | Hydrate from /overview (already has holdings/assetCount/totalValue) or bulk endpoint; pass `?limit=`; lazy-load NFTs on tab open |
| 15 | Medium | perf | derive.ts:239-259,113-123 | computeShortTermDeltas fans out 3 separate snapshot findFirst (1/7/30d); overview reads 24h snap a 4th time | Fetch last ~31 days of approx=false snapshots in one query, pick baselines in JS; expose 24h baseline to overview |
| 16 | Medium | perf | sync.ts:768-824 | setConnectedBalancesFromSummary upserts assets one-by-one in a sequential loop (per-token RT on sync/resync/webhook) | createMany(skipDuplicates)+updateMany / bulk UPDATE...FROM VALUES; or bounded Promise.all; reuse asset fetch for currentConnectedValue |
| 17 | Medium | perf | overview.service.ts:519-617,564-608 | buildValueHistory nested O(dates×portfolios×points) forward-fill over unbounded ~1095-day series, materialized twice | Bound DB read to window; per-series cursor merge-walk → O(D+ΣK); build connectedValueHistory from same pass |
| 18 | Medium | perf | overview.service.ts:274-289,383-390 | **(dup of #15)** buildOverview re-queries 24h snapshot baseline computeDerived already fetched (N extra findFirst) | Derive totals 24h from derivedList (`value24hAgo = totalValue - pnl24hValue`); drop snaps24hAgo fetch |
| 19 | Medium | perf | overview.service.ts:274,297 | Three overlapping live-price mgets for same symbol set (N per-portfolio in derive + union mget + catalog mget) | Fetch union liveMap once, thread into computeDerived variant accepting prefetched map |
| 20 | Medium | perf | overview.service.ts:186-191 | **(dup of #28)** computeTopMovers mgets the entire ~500-token catalog every miss; no rank/limit filter (incl. scam tokens) | Restrict to firehose/ranked rows; or resolver-maintained Redis sorted-set of recent movers |
| 21 | Medium | perf | overview.service.ts:286,243-247 | **(dup of #15/#18)** Redundant findSnapshotNearDaysAgo(p,1) per portfolio computeDerived already computed | Build totals 24h from derived pnl24hValue/totalValue; drop the duplicate Promise.all |
| 22 | Medium | perf | overview.service.ts:276,286,244-246 | Per-portfolio snapshot data fetched ~5 ways per request (full ASC series + 4 windowed lookups), all derivable from the one series read | Fetch full ASC series once, derive 24h/7d/30d baselines in-memory (binary search) |
| 23 | Medium | perf | schema.prisma:382-427; transactions.repository.ts:90-99,122-129 | **Missing index on Transaction.timestamp** forces filtered full sort over user's whole tx set on every dashboard load + N earliest-date sorts | Add `@@index([portfolioId, timestamp])` (and possibly `@@index([timestamp])`) |
| 24 | Medium | perf | catalog-ingest.ts:37-67 | runTokenCatalogIngest does a redundant findUnique + upsert per token, serialized over top-N (~1000 RT/ingest) | Drop bookkeeping findUnique; batch via INSERT...ON CONFLICT or chunked createMany+updateMany |
| 25 | Medium | perf | sync.ts:32-61 | runTokenMetadataSync: sequential `prisma.token.update` + `redis.del` per catalog token (~500 each/6h) | Pipeline Redis DELs; group updates via UPDATE...FROM(VALUES) or chunked Promise.all |
| 26 | Medium | perf | sync.ts:449-488 | sampleMoralisValueHistory: up to 100 sequential Moralis HTTP calls (2×50 samples) on connect path | Bounded concurrency (p-limit 4-8); pre-resolve blocks in one pass; cache dateToBlock |
| 27 | Medium | perf | sync.ts:704-721 | **(dup of #6 low / N+1)** buildConnectedCostMap does per-token `token.findFirst` (case-insensitive contract) inside PnL loop | Collect unresolved contracts, single `findMany({contractAddress:{in:[...]}})` (lowercased), map in memory |
| 28 | Medium | perf | overview.service.ts:183-244 | computeTopMovers full-catalog findMany + 500-key mget + 500 JSON.parse every 60s window for 6 movers | Resolver-fed Redis sorted-set ZREVRANGE top 6; or restrict catalog scan to ranked rows |
| 29 | Medium | perf | ws/server.ts:180-204,230-233 | WS firehose builds a 1-symbol frame + loops every socket per price move; O(symbols-moving × sockets), no coalescing | Buffer pmessages into Map, flush one multi-symbol frame on ~250-500ms timer |
| 30 | Medium | perf | ws/server.ts:180-204,230-233 | **(dup of #29)** broadcastPrice re-resolves+re-serializes per symbol; dedup removes no-op repeats but not distinct-symbol coalescing | Buffer + short-timer flush; one ISO timestamp per flush |
| 31 | Medium | perf | sync.ts:330-334 | GoldRush balances_nft fetched twice per sync (no-spam=true holdings + no-spam=false spam set); same endpoint | Fetch once with no-spam=false, derive both in app code; at minimum Promise.all the spam calls |
| 32 | Medium | perf | sync.ts:305-317,342-388,768-807 | importTransfers/importNftHoldings/setConnectedBalances all serialize per-row DB writes (multi-statement each); 50-tx page = hundreds of RT | Bounded-concurrency pool where order-independent; pre-resolve distinct tokens in one findMany; batch creates |
| 33 | Medium | perf | Neonfi/.../wallet/+page.svelte:92-112,132 | liveAssets re-maps AND re-sorts the whole asset list (O(N log N)) on every tick; depends on $priceChanges too | Compute stable sort order once from loader; only update per-row text reactively; debounce live re-sort |
| 34 | Medium | perf | Neonfi/src/lib/ws.ts:88-92 | priceChanges store cloned+published every tick but consumed only on wallet page — pure overhead on 3 of 4 pages | Only clone/publish when a batch entry carries numeric change24h; fold into single coalesced flush |
| 35 | Medium | perf | Neonfi/.../performance/+page.svelte:74-95 | Value-series rebuild refetches /prices/history + runs O(symbols×timeline) on every range switch, no cache/abort | Memoize series per (symbols,range); fetch widest range once + window client-side; AbortController |
| 36 | Medium | perf | Neonfi/src/lib/ws.ts:76-93 | **(dup of #10/#34)** Firehose clones full Map per frame, no rAF/throttle; re-triggers all $derived consumers | rAF/250ms flush, mutate once per flush; allocate new Map only when symbols changed |
| 37 | Medium | perf | Neonfi/.../performance/+page.ts:140-147 | One /analytics/:id/summary request per portfolio (N+1) just for deposits + 7d/30d windows (Pro-gated aggregation each) | Fold totalDeposits/withdrawals/pnl7d/30d into /overview payload; or cache summaries |
| 38 | Medium | perf | Neonfi/.../wallet/[portfolioSlug]/[tokenSlug]/+page.ts:83-135 | 4 sequential awaits to locate one token; over-fetch full portfolio/asset/tx lists then filter client-side, no symbol/limit | Promise.all steps 3+4; add server-side `?symbol=`/`?limit=` to transactions endpoint |
| 39 | Low | perf | sync.ts:704-721 | **(dup of #27)** buildConnectedCostMap tier-3 per-token catalog findFirst inside loop | Batch unresolved contracts into one findMany, build contract→id map |
| 40 | Low | perf | recalc.ts:144-157 | recalcPortfolioNetDeposit re-reads all portfolio assets after each per-token recalc in bulk loops | Use `aggregate({_sum:{netDeposit}})`; skip for connected portfolios |
| 41 | Low | perf | recalc.ts:144-157 | **(dup of #40)** Full asset re-scan+re-sum per mutation inside write tx when only one asset changed | DB-side aggregate or maintain netDeposit incrementally |
| 42 | Low | perf | overview.service.ts:183-244 | **(dup of #28)** computeTopMovers full-catalog scan + per-token price mget every miss | Pre-filter to ranked/firehose tokens; or resolver sorted-set |
| 43 | Low | perf | overview.service.ts:287-288 | earliestUserTransactionDate fan-out: one findFirst per portfolio (N where 1 suffices) | `groupBy({by:['portfolioId'],_min:{timestamp}})` like countTransactionsByPortfolioForUser |
| 44 | Low | perf | sync.ts:449-488 | **(dup of #26)** sampleMoralisValueHistory sequential per-sample HTTP pairs, no concurrency | Bounded concurrency (p-limit 4-6) |
| 45 | Low | perf | sync.ts:411-416 | currentConnectedValue/reprice over-fetch full Asset+Token rows when only balance + currentPrice needed | `select:{balance:true,token:{select:{currentPrice:true}}}` |
| 46 | Low | perf | coinmarketcap-provider.ts:149-187 | fetchTopTokens single oversized listings/latest call + synchronous reduce; no pagination guard (scaling cliff) | Paginate start/limit windows + merge if catalog grows; else clamp/document limit |
| 47 | Low | perf | overview.service.ts:13-16,166-172 | overview:<uid>:* cache only TTL/price-refresh evicts it, never on tx/asset/snapshot writes (60s staleness; eviction coupled to costly KEYS) | Per-user version-counter key; INCR in invalidatePnlCache + snapshot job (fixes #5 too) |
| 48 | Low | perf | derive.ts:40,113-155 | computeDerived 60s TTL forces full provider-truth recompute (3 snapshot queries) per minute though deltas change daily | Split cache: long-TTL price-independent parts (snapshot/cost-basis), recompute only live totalValue per 60s read |
| 49 | Low | perf | prices.service.ts:287-289,323-332 | getPriceDebug issues 50 separate 9-key mgets (≈450 keys) for no-symbol debug board | One flat mget of 450 keys, slice per symbol |
| 50 | Low | perf | coinbase.ts:260-265 | Each of up to 9 exchange singletons publishes a `client_events` reconnect frame independently → burst of duplicate client notifications | Surface reconnect only on real degradation (top feed down / all down); coalesce/debounce across exchanges |
| 51 | Low | perf | moralis-streams-client.ts:42-68 | createStream: 2 sequential Moralis calls (create + add-address) per portfolio; add-address has no `!res.ok` check | Check res.ok; consider one stream watching multiple addresses |
| 52 | Low | perf | derive.ts:137-144,200,227,386-387 | `Number(decimal.toString())` double string-parse per number in per-asset/per-snapshot hot loops | Use `decimal.toNumber()`; hoist conversions once per row |
| 53 | Low | perf | overview.service.ts:586-608 | **(dup of #17)** buildValueHistory rescans each portfolio series from index 0 for every kept date — O(D×P×K) | Forward-advancing per-series cursor (merge sweep) → O(D+P×K) |
| 54 | Low | perf | ws/server.ts:140-145; subscriptions.service.ts:51-55 | getEffectivePlan runs a Subscription+plan+status join on every WS upgrade; reconnect storm = one join/socket | Cache plan in Redis (60-300s) invalidated on plan_changed; or embed plan in ws_ticket |
| 55 | Low | perf | price-resolver.ts:70-75,213-214,225-227 | lastPublishedPrice/lastHistSampleAt module Maps grow unbounded by symbol (junk tickers never evicted) | LRU cap or prune entries past staleness window in resolveCanonical |
| 56 | Low | perf | Neonfi/src/lib/chart-zoom-pan.ts:68-73,284-298 | Cached SVG rect invalidated only on resize, not scroll → stale hover/wheel coords after scrolling | Invalidate on scroll (passive) or re-read rect per gesture |
| 57 | Low | perf | Neonfi/src/lib/components/AreaChart.svelte:90-95,66-84 | ResizeObserver writes svgW state every frame → rebuilds all path strings during resize/layout thrash | Quantize width to integer px, skip no-op writes; or debounce to trailing frame |
| 58 | Low | perf | Neonfi/src/lib/chart-markers.ts:99-159 | buildTransactionMarkers O(tx×timeline) linear nearest-index scan re-run on every windowed-timeline identity change | Binary search (times sorted) → O(tx×log points); gate $derived to real data changes |
| 59 | Low | perf | Neonfi/.../payments/+page.ts:33-47 | Subscription + payments fetches run sequentially though independent (extra round-trip) | `Promise.all([...])` |
| 60 | Low | perf | Neonfi/src/lib/auth-redirect.ts:11-21 | Guards each issue an uncached GET /users/me, no client-side coalescing across navigations | Short-lived module-level coalesced promise; or pass session down from layout |
| 61 | Low | perf | Neonfi/src/lib/ws.ts:94-117 | onerror→close→scheduleReconnect can storm /auth/ws-token (+/auth/refresh) during outages; attempt only capped at 30s | Cap consecutive ticket-mint failures; guard double-schedule; don't mint ticket until network reachable |
| 62 | Low | perf | Neonfi/src/lib/chart-markers.ts:77-86,106-158 | **(dup of #58)** fetchUserTransactions hardcodes limit=500 + linear nearest-index scan, refetched on every range change | Lower limit / window by chart start; binary search; reuse already-fetched transactions |
| 63 | Low | perf | Neonfi/.../settings/+page.ts:54-62 | Settings fetches the entire heavy /overview aggregate solely to read per-portfolio assetCount | Add assetCount to /portfolios list (or counts endpoint); or share dashboard's /overview via store |

---

### #1 / #2 (dup) — Overview re-fetches each portfolio's assets twice and re-runs getLivePriceMap

**What it is.** In `buildOverview`, the same parallel block runs both `Promise.all(portfolios.map(p => computeDerived(p.id)))` and `Promise.all(portfolios.map(p => findAllAssetsByPortfolioId(p.id)))`. On a cold derive cache, `computeDerived → computeFromDb` already issues `prisma.asset.findMany({ where:{portfolioId}, include:{token:true} })` (derive.ts:115-118), and `findAllAssetsByPortfolioId` issues the byte-identical query (assets.repository.ts:5-9). Each portfolio's assets+token rows are therefore SELECTed twice. Compounding it, `computeFromDb` calls `getLivePriceMap(symbols)` (derive.ts:127) and `buildOverview` calls `getLivePriceMap(allSymbols)` again (overview.service.ts:297) — two Redis mget round-trips over essentially the same symbol set.

**Why it matters.** This is the dashboard hot path, gated only by a 60s overview cache. On every overview cache miss the derive cache is usually also cold (both wrap the same window), so a user with N portfolios pays `2N` asset SELECTs and at least `N+1` price mgets where `N+1` reads and `1` mget would suffice. On Neon's pooled latency, doubling the per-portfolio query count is directly visible in dashboard load time.

**Evidence.**
```js
const [derivedList, assetsList, ...] = await Promise.all([
  Promise.all(portfolios.map((p) => computeDerived(p.id))),       // derive.ts:115 → findMany assets+token
  Promise.all(portfolios.map((p) => findAllAssetsByPortfolioId(p.id))), // identical findMany
  ...]);
// later, line 297:
const liveMap = await getLivePriceMap(assetsList.flat().map((a) => a.token.symbol)); // 2nd mget
```

**Fix.** Load assets once for all portfolios and thread them through:
```ts
// one query for the whole user
const allAssets = await prisma.asset.findMany({
  where: { portfolioId: { in: ids } },
  include: { token: true },
});
const assetsByPortfolio = Map.groupBy(allAssets, (a) => a.portfolioId);

// one union live-price map for the whole request
const liveMap = await getLivePriceMap([...new Set(allAssets.map((a) => a.token.symbol))]);

// refactor computeDerived to accept preloaded inputs (skip its internal reads)
const derivedList = await Promise.all(
  portfolios.map((p) => computeDerived(p.id, { assets: assetsByPortfolio.get(p.id) ?? [], liveMap })),
);
```
`computeDerived(portfolioId, opts?)` should fall back to its current self-fetching behaviour when `opts` is absent (preserving the standalone analytics callers), but skip the `findMany` and `getLivePriceMap` when they are supplied. This removes the `N` redundant asset SELECTs and the 1 redundant union mget, and lets the per-portfolio derive mgets be dropped entirely.

---

### #3 / #4 (dup) — recalcAssetBalance scans detail tables on an un-indexed `symbol` column

**What it is.** `recalcAssetBalance` runs, per call: a `portfolio.findUnique` (connected guard), a `token.findUnique`, an `asset.findUnique`, and two `findMany` over `nativeTransactionDetail`/`erc20TransactionDetail` filtered by `{ symbol: token.symbol, transaction: { portfolioId } }`. Neither detail table declares an index on `symbol` (schema.prisma:446-489 only have `transactionId @unique`), so each detail `findMany` filters an un-indexed column and joins back through `transaction.portfolioId`. It also over-fetches: the full detail + transaction + direction rows are pulled when only `amount`, `usdValue`, `direction.name`, `transferGroupId`, `timestamp`, and `id` are read (recalc.ts:79-88).

**Why it matters.** This runs on every manual buy/sell/transfer CUD and is the backbone of the average-cost replay. In the bulk import paths it is called **once per affected token inside a loop** (transactions.bulk.ts:335-337, assets.bulk.ts:196-197), so a CSV import of K tokens becomes `K × (3 findUnique + 2 un-indexed detail scans)`. As transaction volume grows (connected wallets import ~100 rows each, plus load-more), each scan degrades toward a filtered sequential scan, and the per-call `portfolio.findUnique` re-fetches a row the caller already has.

**Evidence.**
```ts
const [nativeTxs, erc20Txs] = await Promise.all([
  tx.nativeTransactionDetail.findMany({
    where: { symbol: token.symbol, transaction: { portfolioId } }, // symbol not indexed
    include: { transaction: { include: { direction: true } } },    // over-fetch
  }),
  tx.erc20TransactionDetail.findMany({ where: { symbol: token.symbol, transaction: { portfolioId } }, ... }),
]);
```

**Fix.** Add the index and trim the selection:
```prisma
model NativeTransactionDetail {
  // ...
  @@index([symbol])
}
model Erc20TransactionDetail {
  // ...
  @@index([symbol])
}
```
```ts
const detailSelect = {
  amount: true, usdValue: true,
  transaction: { select: { id: true, timestamp: true, transferGroupId: true, direction: { select: { name: true } } } },
} as const;
```
And in the bulk loops, fetch `portfolio.type` (and the connected/manual flag) once and pass it into a `recalcAssetBalance(tx, portfolioId, tokenId, { portfolioType, token })` signature so the per-call `portfolio.findUnique`/`token.findUnique` collapse. Alternatively, drive the query off the already-indexed `transaction.portfolioId` and filter `symbol` in memory.

---

### #5 — `redis.keys('overview:<userId>:*')` blocking scan on every /prices/refresh

**What it is.** `invalidateUserReadCaches`, called on every successful `POST /prices/refresh`, busts the per-user overview response cache with:
```ts
const overviewKeys = await redis.keys(`overview:${userId}:*`);
if (overviewKeys.length > 0) await redis.del(...overviewKeys);
```
`KEYS` is single-threaded and O(N over the entire keyspace) — it walks **every** key, including the high-cardinality `price:<SYM>`, `price:<SYM>:<exchange>`, and `price_hist:<SYM>` keys this same system writes (hundreds of symbols × ~8 exchanges = thousands of keys, refreshed every tick).

**Why it matters.** `KEYS` blocks the Redis event loop for the duration of the scan, stalling **all** Redis traffic: the price firehose writes (#6), WS ticket auth, and derive cache reads. `/prices/refresh` is a user-hittable endpoint; under concurrent use this serializes the whole price subsystem behind repeated full-keyspace scans. (The same anti-pattern exists offline in backfill-snapshots.ts:374 — lower priority.)

**Fix (preferred — version counter, O(1), also fixes #47).** Stop using a wildcard entirely:
```ts
// read path
const ver = (await redis.get(`overview_ver:${userId}`)) ?? '0';
const key = `overview:${userId}:${ver}:${days}:${txLimit}:${idsKey}`;

// invalidation — O(1), no scan, no DEL fan-out
await redis.incr(`overview_ver:${userId}`);
```
Stale-version keys simply expire by their existing 60s TTL. Call `INCR` from both `invalidateUserReadCaches` (price refresh) **and** `invalidatePnlCache`/the snapshot job, which closes the staleness gap in #47 at the same time. If a counter scheme is too invasive short-term, at minimum replace `KEYS` with a non-blocking `SCAN` cursor loop (`MATCH overview:<userId>:* COUNT 100`).

---

### #6 / #7 / #8 (dup) — Price resolver runs 3-13 un-pipelined Redis round-trips per exchange tick

**What it is.** `recordTick` is invoked once per symbol per exchange tick (binance/coinbase/okx/bybit/gate/kucoin/kraken — array frames from binance/gate/kucoin fan out to many `recordTick` calls per frame). Each call awaits, **in series**: `redis.set(price:<SYM>:<ex>)`, then `resolveCanonical` which does `redis.mget(...8 keys)`, `redis.set(price:<SYM>)`, conditionally `redis.publish(price:<SYM>)`, and on the 3-minute history gate `lpush + ltrim + expire`. None are pipelined; each tick pays full network RTT 3-13 times. The MGET is also partly redundant with the SET 2 lines earlier — the exchange that just ticked re-reads the key it just wrote.

**Why it matters.** This is the single highest-throughput path in the system. At full coverage (~500 symbols × 7 venues, binance ~1/sec) this is on the order of thousands of serial Redis RTTs per second, each blocking on network latency. The only `pipeline()` in the entire codebase is lib/lockout.ts:41; the hottest path uses none. ioredis would auto-pipeline commands issued within one event-loop tick, but the explicit `await` between each command defeats it.

**Evidence.**
```ts
await redis.set(`price:${sym}:${exchange}`, JSON.stringify(tick), 'EX', PRICE_TTL_S);
await resolveCanonical(sym, now);
//   inside resolveCanonical:
const raws = await redis.mget(...EXCHANGES.map((e) => `price:${sym}:${e}`)); // 8 keys
await redis.set(`price:${sym}`, payload, 'EX', PRICE_TTL_S);
await redis.publish(`price:${sym}`, payload);
// + lpush/ltrim/expire on the history gate
```

**Fix.** Two complementary changes:

1. **Keep per-exchange ticks in process memory** (the feed-owning process already holds `lastPublishedPrice`/`lastHistSampleAt` Maps), so `resolveCanonical` reads memory and the MGET(8) leaves the hot path entirely:
```ts
const lastTickByExchange = new Map<string, Map<string, Tick>>(); // sym -> ex -> tick
function recordTick(sym, exchange, tick, now) {
  let bySym = lastTickByExchange.get(sym);
  if (!bySym) lastTickByExchange.set(sym, (bySym = new Map()));
  bySym.set(exchange, tick);
  resolveCanonicalInMemory(sym, bySym, now); // no Redis reads
}
```
2. **Pipeline the remaining writes** into one RTT:
```ts
const p = redis.pipeline();
p.set(`price:${sym}:${exchange}`, JSON.stringify(tick), 'EX', PRICE_TTL_S);
p.set(`price:${sym}`, payload, 'EX', PRICE_TTL_S);
if (changed) p.publish(`price:${sym}`, payload);
if (histGateOpen) p.lpush(histKey, entry).ltrim(histKey, 0, 479).expire(histKey, HIST_TTL_S);
await p.exec();
```
Optionally debounce per-symbol canonical recomputation (~100-250ms) since downstream consumers already dedupe on price change. Expected impact: collapses the per-tick Redis cost from ~10 key touches + multiple RTTs to one pipelined RTT (and removes the MGET entirely).

---

### #9 — Connected-reprice job: per-token CoinGecko call per wallet, including majors

**What it is.** `repriceConnectedTokens` iterates every connected wallet holding ≥1 auto-listed token, fetches the full wallet summary, then loops over **every** token in that summary calling `reconcileTokenPrice`, which issues a separate CoinGecko `/coins/{platform}/contract/{address}` GET per token (canonical-price.ts:44). There is no filter to only the auto-listed tokens that need repricing — majors already on the firehose/CMC also trigger a CoinGecko call. With W wallets × T tokens that is `W×T` sequential external calls every 30 minutes (`CONNECTED_REPRICE_CRON` default `*/30`), gated only by a single 250ms sleep *between wallets* (not between token calls).

**Why it matters.** CoinGecko's keyless tier is heavily rate-limited. This both wastes compute on tokens that don't need it and risks 429s — and a 429 silently flags an otherwise-good price as "unverified," degrading correctness. The fan-out scales multiplicatively with users and holdings.

**Evidence.**
```ts
for (const t of summary.tokens) {
  if (t.usdPrice == null && !t.contractAddress) continue;
  const { price, priceConfidence } = await reconcileTokenPrice(slug, t.contractAddress, t.usdPrice); // per-token CoinGecko GET
}
```

**Fix.** Restrict to the tokens that actually need repricing and batch the API call:
```ts
// 1. only autoListed tokens for this wallet need CoinGecko reconciliation
const autoListed = await prisma.asset.findMany({
  where: { portfolioId, token: { autoListed: true } },
  select: { token: { select: { contractAddress: true } } },
});
const need = new Set(autoListed.map((a) => a.token.contractAddress?.toLowerCase()));
const contracts = summary.tokens
  .filter((t) => t.contractAddress && need.has(t.contractAddress.toLowerCase()))
  .map((t) => t.contractAddress!);

// 2. one batched call per chain instead of one per token
const prices = await cg.get(
  `/simple/token_price/${platform}?contract_addresses=${contracts.join(',')}&vs_currencies=usd`,
);
```
Add a short throttle/backoff between chain calls to respect the keyless limit. Majors never hit CoinGecko, and a wallet's reprice collapses from `T` calls to ~1 per chain.

---

### #10 / #36 (dup) — Frontend firehose clones two full Maps per single-symbol tick ("no client throttle")

**What it is.** The backend broadcasts one `price_update` frame per symbol per move (#29). For **each** frame, `ws.ts` runs:
```ts
prices.update((map) => { const next = new Map(map); for (const p of batch) if (...) next.set(p.symbol, p.price); return next; });
priceChanges.update((map) => { const next = new Map(map); ... return next; }); // comment: "no client throttle"
```
Two full Map clones (O(N) in tracked symbols) plus two store publishes for a single changed value. Each publish re-runs every `$prices`/`$priceChanges` subscriber on the mounted page.

**Why it matters.** This is the root amplifier behind the chart and wallet findings (#11, #12, #33, #34). Under a busy market the exchange feeds are sub-second per-trade across hundreds of symbols, so the client receives a high-frequency stream of one-entry frames — each triggering two O(N) allocations and a full reactive pass. This is 1-2 orders of magnitude more reactive work than the display can use.

**Evidence.** See snippet above; only consumer of `priceChanges` is `wallet/+page.svelte:105`.

**Fix.** Coalesce on the client with a single flush per animation frame:
```ts
let pending = new Map<string, number>();
let pendingChanges = new Map<string, number>();
let scheduled = false;

function onBatch(batch) {
  for (const p of batch) {
    if (p?.symbol && typeof p.price === 'number') pending.set(p.symbol, p.price);
    if (p?.symbol && typeof p.change24h === 'number') pendingChanges.set(p.symbol, p.change24h);
  }
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(flush);
  }
}
function flush() {
  scheduled = false;
  if (pending.size) {
    prices.update((m) => { const next = new Map(m); for (const [s, v] of pending) next.set(s, v); return next; });
    pending = new Map();
  }
  if (pendingChanges.size) { /* same, only if non-empty */ pendingChanges = new Map(); }
}
```
This collapses N ticks/frame into one Map rebuild and one reactive pass, and the `priceChanges` store is only touched when a frame actually carried `change24h` (also resolves #34).

---

### #11 — Dashboard chart rebuilds all SVG path geometry on every price tick

**What it is.** `liveTotalValue` ($derived) recomputes on every `$prices` publish (reduces over all holdings). `chartPts` ($derived.by) clones `data.chartPoints` and sets `out[last] = liveTotalValue`, so its **identity changes every tick**. That invalidates the entire downstream chain — `chartMn`, `chartMx`, `chartSpan`, `chartXs` (maps all points), `chartYs` (maps all points), `chartLine` (joins a full path string), `chartArea`, `estLine`/`realLine`, `yTicks`, `xTicks`, and the `markerByIndex` rebuild — even though only the rightmost point moved. `Math.min(...chartPts)`/`Math.max(...chartPts)` also spread over the whole array each tick.

**Why it matters.** On a chart of ~120 points, every tick reformats full SVG path strings and forces Svelte to re-diff every `<path>`/`<text>`/marker in the SVG. Combined with the un-throttled firehose (#10), a volatile market drives a full O(points) path rebuild many times per second on the main thread — the most expensive client-side cost in the app.

**Evidence.**
```ts
const chartPts = $derived.by(() => { const base = data.chartPoints; ...; out[out.length-1] = liveTotalValue; return out; });
const chartXs = $derived(chartPts.map((_, i) => xAt(i)));
const chartLine = $derived(chartXs.map((x, i) => `${i===0?'M':'L'}${x.toFixed(1)},${chartYs[i].toFixed(1)}`).join(' '));
```

**Fix.** Decouple the static historical geometry from the live tip:
```ts
// computed ONCE per range/data change from the immutable series
const baseXs   = $derived(data.chartPoints.map((_, i) => xAt(i)));
const baseYs   = $derived(data.chartPoints.map((v) => yAt(v)));
const baseLine = $derived(baseXs.map((x, i) => `${i===0?'M':'L'}${x.toFixed(1)},${baseYs[i].toFixed(1)}`).join(' '));
const baseMn   = $derived(Math.min(...data.chartPoints));
const baseMx   = $derived(Math.max(...data.chartPoints));

// only this recomputes per tick — a short overlay segment + dot
const tipY  = $derived(yAt(liveTotalValue));
const tipSeg = $derived(`M${baseXs.at(-2)},${baseYs.at(-2)} L${baseXs.at(-1)},${tipY}`);
```
Render `baseLine`/`baseArea` plus a tiny `<path d={tipSeg}>` and the live dot. Widen `baseMn/baseMx` only if `liveTotalValue` exceeds the cached range. Combined with #10's rAF coalescing, this turns a full O(points) rebuild per tick into an O(1) tip update.

---

### #12 — Performance page chart mutates last point with live total (same pattern as #11)

**What it is.** `pcPts` ($derived.by) does `base[base.length-1] = liveTotalValue` over `pcWindow.map(...)`; its identity changes every tick, invalidating `pcMn`/`pcMx` (`Math.min/max(...pcPts)`), `pcXs`, `pcYs`, `pcLine`, `pcArea`, `pcEstLine`, `pcRealLine`, `pcYTicks`, `pcXTicks`, and re-evaluating `perfMarkers`.

**Why it matters.** Identical root cause and cost to #11 — every live tick reformats the whole performance-chart SVG path set. The performance page can also mount multiple charts, multiplying the per-tick cost.

**Evidence.**
```ts
const pcPts = $derived.by(() => {
  const base = pcWindow.map((h) => h.value);
  if (base.length < 2 || !data.hasData) return base;
  base[base.length - 1] = liveTotalValue;
  return base;
});
const pcLine = $derived(pcXs.map((x, i) => `${i===0?'M':'L'}${x.toFixed(1)},${pcYs[i].toFixed(1)}`).join(' '));
```

**Fix.** Same shape as #11: build the static line/area/ticks from `pcWindow` values (recomputed only on range/series change), overlay only the live tip segment + dot per tick, and avoid re-spreading the full array into `Math.min`/`Math.max` each tick (cache `pcMn`/`pcMx` from the static series, widen only when the live value exceeds the range).

---

### #13 — Dashboard refetches /overview + transactions(500) + /prices/history on every chart range click

**What it is.** Each range tab navigates with `goto('?range=${r}')` (+page.svelte:394), and `range` is a URL param the `load` reads (+page.ts:156). That re-runs the **whole** load on every click: `/overview?days=...` (the large aggregate with per-portfolio holdings, allocation, valueHistory, connectedValueHistory, recentTransactions), `fetchUserTransactions()` (`/overview/transactions?limit=500`), and `fetchPriceSeries()` (`/prices/history`). Only the chart *window* changes between clicks, yet totals/PnL/allocation/topMovers/recentTransactions are re-downloaded. Worse, `RANGE_DAYS` maps 1H→1, 1D→1 (identical days), and 1Y→365, ALL→3650 which the backend clamps to 365 — so **1H↔1D and 1Y↔ALL return byte-identical /overview payloads**, and switching among 1W/1M/1Y/ALL re-pulls the same limit=500 transactions and overlapping /prices/history each time.

**Why it matters.** Every range click incurs a full heavy server-side cross-portfolio aggregation (snapshots, PnL, value-history reconstruction) plus a 500-row transaction pull plus a price-history fetch, for data that did not change. This is the most network- and server-CPU-expensive frontend interaction, and several of the round-trips are provably redundant. The performance page already demonstrates the correct pattern (fetch `days=1095` once, re-window client-side, range out of the URL).

**Evidence.**
```js
// +page.svelte:394
onclick={() => goto(`?range=${r}`, { keepFocus: true, noScroll: true })}
// +page.ts:156
const range = url.searchParams.get('range') ?? '1M';
// +page.ts:165
await api.get(`${ENDPOINTS.overview}?days=${days}`);
// +page.ts:67
'ALL': 3650, // backend clamps to 365
```

**Fix.** Decouple chart range from the page load. Fetch once at the widest window (the 365-day cap, or 1095) and re-window the chart client-side in `+page.svelte` — the intraday helpers already window by `RANGE_MS`, so `reconstructValueSeries`/`buildAggregateValueSeries` can run reactively in the component:
```ts
// load: range-independent, runs once
const ov = await api.get(`${ENDPOINTS.overview}?days=365`);
const txs = await fetchUserTransactions();          // once, reused across ranges
const series = await fetchPriceSeries(syms, 'ALL');  // widest, windowed client-side

// component: reactive, no navigation
let range = $state('1M');
const windowed = $derived(reconstructValueSeries(series, txs, range));
```
If range must stay in the URL, gate the load so only the 1H/1D `/prices/history` fetch re-runs and the already-loaded /overview + transactions are reused. At minimum, collapse 1H/1D and 1Y/ALL to a single fetch and memoize identical `(symbols, range)` /prices/history calls.

---

### #14 — Wallet page N+1 fan-out: 3 REST calls per portfolio on top of the list call

**What it is.** The wallet load fetches `GET /portfolios`, then for **each** portfolio issues three more requests — `/portfolios/:id/assets`, `/portfolios/:id/transactions`, and (connected) `/portfolios/:id/nfts?includeSpam=true` — via `Promise.all(list.map(...))`. For N portfolios this is `1 + 3N` round-trips. The per-portfolio transactions endpoint is called with **no `limit`**, so it returns the full transaction list per portfolio (and the token-detail page later re-fetches that same full list to filter client-side, #38).

**Why it matters.** Server compute and total request volume scale linearly with portfolio count, and the unbounded transactions pull grows with connected-wallet imports (~100 rows each, more on load-more). Much of this data — per-portfolio `assetCount`, holdings, `totalValue` — is **already computed by `/overview`**, which this page does not use. NFTs are eagerly fetched for every connected portfolio even when the user never opens the NFT tab.

**Evidence.**
```js
list.map(async (p, i) => {
  const [assets, txs, nfts] = await Promise.all([
    api.get(ENDPOINTS.portfolios.assets(p.id)),
    api.get(ENDPOINTS.portfolios.transactions(p.id)),       // no limit
    p.type === 'connected' ? api.get(`${ENDPOINTS.portfolios.nfts(p.id)}?includeSpam=true`) : null,
  ]);
  ...
});
```

**Fix.** Hydrate from a single aggregate and defer NFTs:
- Use `/overview` (which already returns per-portfolio `holdings[]`, `assetCount`, `totalValue`) to populate the wallet asset view in one call, or add a `/portfolios/full` bulk endpoint.
- Pass a bounded `?limit=` to the per-portfolio transactions fetch (the wallet view shows only a recent slice).
- Lazy-load `/portfolios/:id/nfts` only when the user opens that portfolio's NFT tab, rather than eagerly for every connected portfolio on initial load.

This collapses the initial wallet load from `1 + 3N` round-trips to ~1-2 and removes the unbounded transaction pulls.


---

## Code Quality — Backend

This pass surveyed the NeonFi backend for code-quality concerns — duplication, dead code, hardcoded values, weak typing, control-flow ("spaghetti") smells, and silent-failure hazards — across auth, subscriptions/billing, portfolios, transactions, assets, tokens/pricing, wallet-data providers, exchange WebSocket clients, webhooks, overview/analytics, and operational scripts. The dominant themes are (1) pervasive copy-paste of cross-cutting concerns (the "effectively active" subscription rule, portfolio-ownership middleware, `parseId`, decimal/regex validators, WS resilience scaffolding, provider chain maps) and (2) a cluster of silent-failure / unsound-cast hazards in the money and connectivity paths (unchecked Moralis address-attach, Coinbase-WS-gates-liveness, `as <status>` casts, provider-truth precision loss). None are exploitable injection vulnerabilities, but several are latent correctness or availability risks that warrant fixing before launch.

**Severity tally:** Critical 0 · High 4 · Medium 23 · Low 78 · Info 16 (112 findings total).

| # | Sev | Category | Location (file:lines) | Issue | Recommended fix |
|---|-----|----------|------------------------|-------|-----------------|
| 1 | Medium | duplication | auth/plan.ts:36-40 | "Effectively active" subscription predicate reimplemented in ~5 places (plan.ts, users.repository toUserDTO, subscriptions.service getEffectivePlan, prices.controller, stripe-handlers) | Extract one `isSubscriptionEffectivelyActive(sub, now?)` helper and call everywhere |
| 2 | Low | duplication | auth/auth.controller.ts:111-115, 252-256 | X-Forwarded-For/X-Real-IP + UA parsing copy-pasted in /login and /google/callback | Extract `getClientIp(c)` / `getUserAgent(c)` helpers |
| 3 | Low | dead-code | lib/jwt.ts:39-49 | `VerifyResult` interface unused and misdescribes `verifyAccessToken` (no `expired` flag) | Delete the interface, or implement a non-throwing variant |
| 4 | Low | dead-code | users/users.repository.ts:98-107 | `createUser` exported but never called; register/OAuth use inline `prisma.user.create` | Route create paths through `createUser` or delete it |
| 5 | Low | dead-code | users/users.repository.ts:109-121 | `updateUserOnboardingStatus` unused; verifyEmail inlines the same lookup+update | Use the helper in verifyEmail or delete it |
| 6 | Low | dead-code | auth/auth.schemas.ts:48-50 | `SessionIdParamSchema` unused; controller hand-rolls `parseInt`+`Number.isInteger` | Validate the `:id` param with the schema or delete it |
| 7 | Medium | smell | auth/auth.controller.ts:80-88 | Lockout `retryAfterMs` placed at top-level `meta`; FE reads `error.retryAfter`/`error.details.retryAfter`, so 423 countdown never shows | Nest under `error.details`, emit `retryAfter` in seconds (match retrofit-65) |
| 8 | Low | hardcoded | auth/auth.service.ts:586 | WS-ticket TTL `60` hardcoded twice (service + controller `expiresIn`), plus scattered 86400/3600/600 magic TTLs | Named constants; controller derives `expiresIn` from the same const |
| 9 | Low | hardcoded | users/users.controller.ts:92-93 | Avatar over-size message literal "5 MB" but limit is `config.AVATAR_MAX_BYTES` | Interpolate the configured limit into the message |
| 10 | Low | smell | auth/plan.ts:54-55 | `c.set('subscription', subscription as any)` discards type checking though include == `SubscriptionWithRelations` | Cast to `SubscriptionWithRelations` (or rely on inference) |
| 11 | Low | smell | auth/auth.service.ts:226-231 | `findUserById(NaN)` on corrupt Redis token id → Prisma 500 instead of 400 (same in confirmPasswordReset, middleware) | Guard `Number.isInteger(userId)` before the DB call |
| 12 | Low | duplication | users/users.controller.ts:115-116, 131-132 | Avatar handlers repeat `updateProfile`+`toUserDTO` and bypass the service layer | Move persist into `setAvatar`/`clearAvatar` service fns |
| 13 | Low | smell | auth/auth.controller.ts:261-268 | OAuth callback emits 4 distinct `oauth_error` reasons the register page never reads | Consume `oauth_error` on FE or collapse to one generic reason |
| 14 | Low | smell | auth/auth.service.ts:12-13 | Stale post-MVP TODO: refresh tokens non-rotating; leaked token valid for full window | Track in security backlog; implement rotation + reuse detection |
| 15 | Medium | smell | portfolios.dto.ts:70; portfolios.service.ts:38-54; schema.prisma:299-338 | `Portfolio.slug` has no column; recomputed per read, uniqueness enforced in-memory → concurrent duplicate-slug race | Persist `slug` with `@@unique([userId,slug])` + catch P2002, or make slug display-only |
| 16 | Medium | duplication | portfolios.dto.ts:62-64 | `canonicalAllTime` all-time mapping re-implemented (inverted) vs overview.service.ts:105-109 | Export shared `canonicalAllTime(type, derived)` and call from both |
| 17 | Low | hardcoded | portfolios derive.ts/dto.ts/service.ts (multiple) | `'connected'`/`'manual'` magic literals across ~10 sites; no enum/const; inline union re-declared | Introduce `PORTFOLIO_TYPE` const + `PortfolioTypeName` union |
| 18 | Low | duplication | portfolios.schemas.ts:13,21,22 | Decimal regex `/^\d+(\.\d+)?$/` copy-pasted ×3 here + 2 other modules; omits error message | Reuse exported `decimalStr` validator |
| 19 | Low | spaghetti | portfolios/derive.ts:113-216 | `computeFromDb` ~100 lines mixing valuation, avg-cost, connected/manual branching, snapshot deltas, 3 return shapes | Extract `computeAllTime(...)`, build the return object once |
| 20 | Low | smell | portfolios.service.ts:106,113,126,137,150 | Repeated `validation.normalized!` because validator return type doesn't encode `valid:true ⇒ normalized` | Type validator as discriminated union; drop the `!` |
| 21 | Low | hardcoded | portfolios/wallet-validator.ts:10-17 | Only EVM vs Solana; any future non-EVM chain silently treated as EVM | Drive address family from chain metadata (`addressFormat`) |
| 22 | Low | hardcoded | portfolios.service.ts:134 | Moralis webhook path `/api/v1/webhooks/moralis` hardcoded in service + tests + docs | Single shared route constant referenced by mount + stream registration |
| 23 | Low | hardcoded | portfolios.service.ts:24,295 | `PLAN_CAPS {free:1,pro:10}` and `RESYNC_COOLDOWN_S {free:86400,pro:300}` baked into module | Move plan economics into config / plans constants module |
| 24 | Low | smell | portfolios.service.ts:208-218 | `priceAtTime`/`timestamp`/`notes` silently dropped when `amount` absent or zero | Reject (400) when present without positive amount, or document precedence (Zod refine) |
| 25 | Low | smell | portfolios.controller.ts:66,129,159,183,204 | Per-route `e.statusCode as <union>` casts are unsound; can send wrong/untyped code | Single helper mapping `PortfolioError` → Hono `ContentfulStatusCode` |
| 26 | Low | smell | portfolios/derive.ts:84-90 | Cache-hit guard validates only 3 fields; stale-shape payload returns `undefined` newer fields cast as `DerivedFields` | Version the cache key or validate against a Zod schema |
| 27 | Low | duplication | lib/bulk-import.ts:16; transactions.schemas.ts:11; lib/decimal.ts:19 | `MAX_DECIMAL` 20,8 magnitude bound declared 4× with inconsistent boundary operators (`<`/`>=`/clamp) | Export one shared constant from decimal.ts; pick one boundary convention |
| 28 | Low | duplication | lib/bulk-import.ts:51; transactions.schemas.ts:5; assets.schemas.ts:3 | Non-negative decimal regex copy-pasted in 3 modules | Extract shared `DECIMAL_STRING_RE` / `decimalStr` |
| 29 | Low | smell | transactions/transactions.bulk.ts:157-166 | Bulk rejects `price=0` while single-create accepts `priceAtTime='0'` — parity claim untrue | Align both paths; update the parity comment |
| 30 | Medium | spaghetti | transactions/transactions.service.ts:864-1052 | `updateTransaction` ~190 lines; near-duplicate native/erc20 usd-recompute blocks; `baseData as Parameters<...>` cast | Extract shared detail-update helper; type `baseData` |
| 31 | Medium | duplication | transactions/transactions.service.ts:122-269,284-393,478-510 | create/createFromWebhook/seedAcquisition repeat write+recalc skeleton; identical P2002→409 catch ×3 | Factor `createTxRowOrThrowDuplicate` + a shared internal writer |
| 32 | Medium | hardcoded | transactions.bulk.ts:238-239; transactions.service.ts:157 | Free-tier rank gate `rank>10` magic literal duplicated, with divergent messages | `FREE_PLAN_MAX_TOKEN_RANK` + shared `isTokenAllowedForPlan` predicate |
| 33 | Medium | smell | transactions/usd-value.ts:45-67 | `computeUsdValue` swallows cache parse errors and returns `'0'` on price miss → corrupts cost basis silently | Log parse failure; return null/flag the "no price" case for callers |
| 34 | Low | smell | transactions.service.ts:232,242,365,374 | `usdValue!` non-null assertions rely on non-local invariant | Compute usdValue inside the type-narrowed branch |
| 35 | Low | hardcoded | transactions.dto.ts:30,110 | `status:'completed'` literal with no backing column | Tech-debt; add real `status` column when on-chain tracking ships |
| 36 | Low | smell | transactions/recalc.ts:82-138 | Decimal→`Number(...)` float arithmetic for cost-basis/realized-PnL then `.toFixed(8)` — accumulation error on money path | Use Prisma.Decimal/decimal lib or document error bound |
| 37 | Low | smell | transactions.bulk.ts:290-296 | `skipped` conflates duplicate vs invalid rows; `errors` is per-error vs per-row across modes | Document/expose distinct per-row counts |
| 38 | Low | smell | transactions.service.ts:291,318-321 | `usdValueOverride` typed `number\|null` but only `!= null` checked; negative/NaN silently clamped to 0 despite "≥0" comment | Validate `Number.isFinite && >= 0`, or fix the comment |
| 39 | Low | smell | transactions/transactions.repository.ts:33-38,71-76 | `buildWhere` typeFilter passed unvalidated at repo layer (allow-list only in controller) | Type `typeFilter` as `'native'\|'erc20'\|'nft'` union |
| 40 | High | duplication | tokens/sync/coinmarketcap-provider.ts:206-208 | `fetchPrices` dedups by market-cap only — the exact TON/junk-ticker bug fixed in retrofit-40 for fetchMetadata/fetchTopTokens; can publish wrong coin's price | Reuse lowest-cmc_rank reducer via shared `pickBestEntry` |
| 41 | Medium | smell | coinmarketcap-provider.ts:57-60,41-45,211 | `change24h` typed non-nullable but CMC `percent_change_24h` can be null; line 211 assigns with no `?? null` | Type field nullable; guard assignment with `?? null` |
| 42 | Low | duplication | tokens/sync/catalog-ingest.ts:19-27 | Lazy CMC-provider singleton copy-pasted 3× (catalog-ingest, sync, prices.service) | Export one memoized `getCmcProvider()` |
| 43 | Medium | duplication | assets/assets.bulk.ts:154-169 | Opening-cost-basis derivation re-implemented vs addAsset (assets.service.ts:74-92); plan-rank + dup-opening checks too | Extract shared `resolveOpeningCostBasis(...)` + plan-rank predicate |
| 44 | Low | duplication | assets/assets.dto.ts:47,102 | Live price-resolution line duplicated between `toAssetDTO` and `computeTotalValue` (load-bearing money calc) | Extract `resolveAssetPrice(asset, priceMap)` |
| 45 | Low | spaghetti | tokens/tokens.service.ts:99-114 | `getTokenPriceHistory` double-fetches the token row via `getTokenById` (extra DB + Redis) | Fetch token once; resolve live price inline |
| 46 | Low | hardcoded | coinmarketcap-provider.ts:14,18,134,180 | CMC base URLs + logo CDN hardcoded (CoinGecko base is config-driven); logo template duplicated | Move base to config; extract `cmcLogoUrl(id)` |
| 47 | Low | hardcoded | tokens/tokens.constants.ts:10-39 | Seed catalog stale: TON/MATIC renamed; frozen prices; symbols are unique key | Drop/rename stale tickers; mark prices illustrative |
| 48 | Low | smell | tokens/tokens.dto.ts:22,66,78 | `priceConfidence` typed `string\|null` instead of existing `PriceConfidence` union | Type field `PriceConfidence \| null` |
| 49 | Low | smell | tokens/canonical-price.ts:86-93 | Returns `'verified'` even when provider was rejected (>25% deviation) and substituted canonical | Add `'corrected'` state or document semantics |
| 50 | Low | smell | assets/assets.controller.ts:23-28 | `assetErr` hand-builds envelope instead of `err()`; bulk handler too | Extend `err()` to accept `meta`/`data`; route both through it |
| 51 | Info | hardcoded | tokens/tokens.service.ts:23-25,30,109 | `MIN_REAL_HISTORY_POINTS`, `1e8`, history-day clamps scattered; `toFixed(8)` in 5 files | Centralize `PRICE_DECIMALS`/`roundPrice`/`dec8` + history bounds |
| 52 | Medium | smell | wallet-data/providers/alchemy.ts:255-265,341-348 | `Number(BigInt(hex))` before dividing loses precision above 2^53 (18-dec ≥ ~9007 tokens); ERC-1155 too | Scale via BigInt/string math before `Number` |
| 53 | Low | duplication | wallet-data/sync.ts:71-73 | `dec8()` defined identically in sync, reprice, backfill-snapshots | Export one `dec8` from lib/decimal.ts |
| 54 | Low | duplication | wallet-data/providers/goldrush.ts:614-618 | `num()` ≡ `toNum()` (moralis.ts:141-145), byte-identical | Move `toFiniteNumber` to shared util |
| 55 | Low | duplication | wallet-data/providers/zerion.ts:68-80 | Group-by-day + lexicographic-sort reducer duplicated ×4 (zerion/mobula/goldrush/sync) | Extract `collapseDailySeries(points)` |
| 56 | Low | dead-code | wallet-data/types.ts:101 | `WalletTokenPnl.unrealizedPnlUsd` written by providers but never read; costs a GraphQL subselect | Drop the field+fetch or wire a real cross-check |
| 57 | Medium | hardcoded | wallet-data/sync.ts:531 | `chain?.moralisId ?? '0x1'` silently samples Ethereum for a non-eth wallet if chain null | Resolve hex from chain constant or bail/log; never default to eth |
| 58 | Low | smell | wallet-data/sync.ts:528-535 | Solana value-history routed through EVM-hex Moralis sampler (404-skips silently) | Guard sampler to EVM chains explicitly |
| 59 | Low | spaghetti | wallet-data/sync.ts:896-952 | `syncConnectedHoldings` 57-line god-fn; `resyncConnectedHoldings` ~85% duplicated, drifted | Extract `runConnectedSync(portfolio, opts)` |
| 60 | Low | hardcoded | wallet-data/nft-spam.ts:55-70 | Eth-only spam/allowlist contract sets + magic 6h TTLs hardcoded, chain-unaware | Move lists to config/DB keyed by chain; named TTL consts |
| 61 | Low | spaghetti | wallet-data/sync.ts:759-824 | `setConnectedBalancesFromSummary` holds two divergent cost/no-cost write paths with duplicated upserts | Split `computeAssetCostFields` + single upsert + zeroing helper |
| 62 | Low | smell | wallet-data/sync.ts:1017-1023 | `importMoreTransfers` comment describes abandoned opening-lot residual design (pre-retrofit-58) | Update comment to provider-truth model |
| 63 | Info | dead-code | wallet-data/providers/mobula.ts:13,37-39 | History-only providers carry stub `getSummary` always-error + unused `ProviderResult` import; previewWallet still dispatches it | Make `getSummary` optional; skip providers lacking it |
| 64 | Low | smell | wallet-data/index.ts:190-192,207-209 | `getSpamContracts!`/`getWalletSpamContracts!` non-null asserts kept in lockstep with `supports` by hand | Single accessor that guards internally, returns null when absent |
| 65 | Low | hardcoded | wallet-data/providers/zerion.ts:59 (and mobula/ankr/goldrush/alchemy) | Provider base hosts hardcoded inline; only Moralis is config-driven; GoldRush base repeated 6× | Promote each base to config; hoist GoldRush base const |
| 66 | Low | smell | wallet-data/providers/alchemy.ts:80-92 | "Drop unpriced non-native dust" rule re-implemented in all 4 summary providers | Centralize filter in `buildSummary`/shared helper |
| 67 | Info | smell | wallet-data/providers/goldrush.ts:504 | `possibleSpam:false` hardcoded for GoldRush vs provider-flag for Moralis/Alchemy → weakens spam OR-signal | Surface honestly or document field is provider-relative |
| 68 | Medium | smell | lib/coinbase.ts:141-166 | Coinbase ticker handler records ALL products (no `isCatalogSymbol` guard) unlike the other 6 clients → pollutes resolver | Add `if (!isCatalogSymbol(base.toUpperCase())) continue;` |
| 69 | Medium | duplication | prices/prices.service.ts:101-102 | Resolver and refreshPrices write same `price:<SYM>` key with different shapes (`ts` vs `timestamp`, no `source`) → debug board reads `ts:0`/`unknown` | Shared canonical (de)serializer; standardize on `{price,change24h,source,ts}` |
| 70 | Medium | smell | lib/price-resolver.ts:93,125 | `recordTick`/`resolveCanonical` accept `price===0` (only `Number.isFinite`) → a zero print can become canonical | Tighten to `!Number.isFinite(price) \|\| price <= 0` |
| 71 | Low | duplication | prices/prices.controller.ts:50-55 | 429 hand-builds `{error,meta}` envelope instead of `err()` | Extend `err()` for meta/details and use it |
| 72 | Low | duplication | prices/prices.service.ts:55,73 | "5 symbols" cap as 3 independent literals (schema/slice/break) + controller message | Single `MAX_REFRESH_SYMBOLS` constant |
| 73 | Low | dead-code | lib/price-symbols.ts:49-52 | `toBinanceBase` exported, used only in tests; trivial identity wrapper | Remove (adjust test) or note intentionally unused |
| 74 | Medium | duplication | lib/binance.ts:39-216 (+6 sibling clients) | 7 WS client classes duplicate ~90% resilience boilerplate (state, backoff, reconnect, client_events, timers) | Extract abstract `BaseExchangeClient`/mixin |
| 75 | Low | hardcoded | lib/coinbase.ts:19-20 (+6 clients) | `RECONNECT_BACKOFF_MS`/`RECONNECT_ALERT_AFTER_ATTEMPTS`/`?? 30_000` redefined in 7 files | Move to one shared constants module |
| 76 | Low | hardcoded | lib/bybit.ts:244 (+gate/okx/coinbase) | REST discovery base URLs hardcoded while WS endpoints are config-driven | Promote REST bases to config |
| 77 | Low | duplication | lib/kucoin.ts:50 (+bybit/gate/okx/coinbase) | `'User-Agent':'neonfi-backend'` literal repeated in every discovery fetch | One shared `USER_AGENT`/`DISCOVERY_HEADERS` |
| 78 | Low | spaghetti | lib/price-resolver.ts:111-236 | `resolveCanonical` ~125 lines, 5 responsibilities; no-majority branch re-implements priority sort | Decompose into pure helpers; reuse `pickWinner` |
| 79 | Low | smell | prices/prices.service.ts:330-332 | `/prices/debug` runs 50× single-key `mget` over arbitrary rank slice incl. empty symbols | Pipeline mgets / filter to symbols with canonical data |
| 80 | Low | smell | lib/binance.ts:132-138 | Quote-dedupe ignores recency; `change24h` absent→0 erases unknown/zero distinction | Prefer fresher same-frame element; document the 0 convention |
| 81 | Low | spaghetti | lib/kraken.ts:35-36,203-217 | binance/kraken use ws.ping/pong while 5 others use message watchdog — undocumented split | Standardize on message watchdog; document exceptions |
| 82 | Info | smell | lib/live-price.ts:7,45 | Header comment says payload field `timestamp`; resolver actually writes `ts` | Update header to `{price,change24h,source,ts}` |
| 83 | Info | smell | lib/coinbase.ts:29,153-156 | `loggedFirstTick` module-global → beacon process-wide, non-resettable in tests | Move to instance field or expose test reset |
| 84 | Info | smell | lib/kucoin.ts:197,209 | Subscribe/ping frames use `id:Date.now()` (collision-prone, not correlated) | Use `randomUUID()` (already imported) |
| 85 | Low | dead-code | subscriptions/subscriptions.controller.ts:44-53 | `parseBody` factory defined but never used; excludes RefundSchema | Delete or adopt in all 4 POST handlers |
| 86 | Medium | duplication | payments/payments.dto.ts:21-27 (and subscriptions.service.ts:382,403-406) | Refund-eligibility rule + `THREE_DAYS_MS` duplicated; UI flag and server gate can diverge | Extract `isPaymentRefundable(payment)` + `REFUND_WINDOW_MS` |
| 87 | Low | duplication | webhooks/moralis-handlers.ts:39 (and webhooks.service.ts:17) | `REDIS_TTL_30_DAYS=2592000` duplicated | Shared constant |
| 88 | Medium | duplication | webhooks/moralis-handlers.ts:108-124 (and build-summary.ts:13-29) | Two hand-kept native-symbol maps for same 15 chains, keyed differently; can drift | Derive native symbols from chains.constants.ts |
| 89 | Low | duplication | webhooks/stripe-handlers.ts:171-180,255-263,318-322 (and subscriptions.service.ts:209-210,315) | Stripe Basil/dahlia expanded-field casts copy-pasted across handlers | Shared typed accessors (`getInvoiceSubscriptionId`, `getItemPeriod`) |
| 90 | High | smell | lib/moralis-streams-client.ts:58-68 | Address-attach fetch ignores `res.ok`; failure leaves stream watching no address → connected wallet silently never updates | Check `res.ok` and throw on failure |
| 91 | Low | smell | payments/payments.controller.ts:44 | `e.statusCode as 403` cast masks any non-403 code | Use `ContentfulStatusCode` / constrain status union |
| 92 | Low | hardcoded | lib/stripe.ts:6-14 | `apiVersion:'2026-05-27.dahlia'` literal contradicts "LATEST_API_VERSION at install" comment | Reference `Stripe.LATEST_API_VERSION` or fix comment |
| 93 | Medium | smell | subscriptions/subscriptions.service.ts:191,195,198,242,279,307,309,362 | `stripeSubscriptionId!`/`billingCycle!` non-null asserts assume invariants schema allows null → opaque Stripe 500 | Assert non-null after guards, throw `SUBSCRIPTION_INCONSISTENT` |
| 94 | Low | spaghetti | subscriptions/subscriptions.service.ts:259-337 | `downgradeSubscription` ~80 lines, two unrelated flows, free-plan check duplicated | Hoist shared preconditions; split into two private helpers |
| 95 | Low | dead-code | webhooks/moralis-handlers.ts:80-91,444-461 | NFT marketplace fields (floorPrice/rarity/traits…) collected but never sent by Streams | Verify against real payload; drop speculative branches or add fixture |
| 96 | Low | duplication | subscriptions/subscriptions.service.ts:51-65 | `getEffectivePlan` uses a different include than repo + re-derives active rule, bypasses repo layer | Shared predicate; route read through repository |
| 97 | Low | duplication | subscriptions/subscriptions.repository.ts:30-53,66-109,111-136 | 3 fns repeat plan/status `findUniqueOrThrow` seed lookups + copy-pasted comment | Memoized `getPlanId`/`getStatusId` helpers |
| 98 | Low | spaghetti | webhooks/stripe-handlers.ts:289-299,414-427,341-352 | Inconsistent transaction discipline (some handlers wrap, some don't) | Document/standardize per-handler tx boundary policy |
| 99 | Medium | duplication | overview/overview.service.ts:60-127 (and analytics.service.ts:44-72) | `withCache`/`round`/`roundN` byte-for-byte duplicated | Extract to shared lib (cache.ts/round.ts) |
| 100 | Medium | duplication | snapshots.controller.ts:20-41 (and analytics/nfts/assets/transactions) | Auth+Pro-gate+ownership middleware + `parseId` copy-pasted in 5 controllers | `requirePortfolioOwnership` middleware factory + shared `parseId` |
| 101 | Medium | duplication | overview/overview.service.ts:286,369-390 | 24h totals re-fetch `findSnapshotNearDaysAgo(p,1)` that `computeDerived` already read (N extra queries) | Derive totals from `derivedList` (`Σ d.pnl24hValue`) |
| 102 | Low | smell | overview/overview.service.ts:369-379 | Comment claims derive hardcodes `pnl24h=0`; derive actually computes it from snapshots | Fix the comment (or remove the recompute) |
| 103 | Low | smell | overview/overview.service.ts:139,536 | `emptyOverview` returns `pnlAllTime:0` while populated path returns null | Set `pnlAllTime:null` for consistency |
| 104 | Low | dead-code | chains/chains.constants.ts:9-23 | `Chain.logoUrl` hardcoded null for all 15 chains, plumbed to clients but never populated | Populate real logos or remove the field |
| 105 | Low | dead-code | nfts/nfts.dto.ts:16-20,49-53 | `floorPrice/floorPriceUsd/lastSale/lastSaleNote/rarity` always null on read-side holdings; `rarity` not in webhook UPDATE | Document MVP-gap or drop; add `rarity` to UPDATE |
| 106 | Low | dead-code | email/email.service.ts:149-168 | `sendUpgradeEmail` `newPlan` param never used ("Pro" hardcoded) | Remove param or render plan label from it |
| 107 | Low | hardcoded | email/email.service.ts:23 | Resend base URL hardcoded (key/from are config) | Add `RESEND_BASE` config |
| 108 | Info | smell | email/email.service.ts:40-46 | Ops runbook text (`neonfi.live`, dev fallback addr) baked into a runtime error log | Reference config domain; move hint to docs |
| 109 | Low | smell | nfts/nfts.controller.ts:64,98 | `e.statusCode as 404` cast unsound | Constrain `NftError.statusCode` union / narrow before passing |
| 110 | Info | duplication | nfts/nfts.service.ts:51-54,65-68 | Not-found+ownership guard duplicated in `getNftById`/`setNftSpamOverride` | Extract `loadOwnedNft(portfolio, nftId)` |
| 111 | Low | spaghetti | overview/overview.service.ts:246-552 | `buildOverview` ~300 lines, 6+ responsibilities; per-portfolio map mutates 8 accumulators | Split into focused helpers |
| 112 | Low | smell | overview/overview.service.ts:183-244 | `computeTopMovers` scans full token catalog + `mget` ~500 keys per 60s window for top-6 | Restrict candidates by cmc_rank / maintain sorted-set in Redis |
| 113 | Info | hardcoded | snapshots.controller.ts:18 | `MAX_LIMIT = SNAPSHOT_RETENTION_DAYS; // 730` trailing literal can go stale | Drop the `// 730` comment |
| 114 | Info | smell | overview/overview.service.ts:105-109,353,460 | `canonicalAllTime(type:string,...)` stringly-typed + recomputed twice per portfolio | Type as union; compute once and reuse |
| 115 | High | smell | lib/health.ts:46-59 | Coinbase WS folded into `/health` `ok` with same weight as DB/Redis → transient feed flap returns 503 and can restart a healthy container | Compute `ok` from DB+Redis only; keep Coinbase informational |
| 116 | Low | dead-code | lib/config.ts:128 | `COINRANKING_API_KEY` parsed but never read | Remove field or wire its provider |
| 117 | Low | dead-code | lib/config.ts:270 | `isTest` exported, never imported; rest of code uses raw `NODE_ENV!=='test'` | Delete or adopt consistently |
| 118 | Low | duplication | lib/redis-subscriber.ts:11-14 (and redis.ts:19-21, prisma.ts:78-81) | Test-vs-runtime URL ternary copy-pasted in 3 singletons | Extract `resolveRedisUrl()`/`resolveDbUrl()` |
| 119 | Low | hardcoded | lib/index.ts:56-60 | `port = 3000` magic literal; no `PORT` in config schema | Add `PORT: z.coerce.number().int().default(3000)` |
| 120 | Low | spaghetti | index.ts:62-83,312-315 | Two separate `NODE_ENV!=='test'` boot blocks bracketing 220-line shutdown | Consolidate into `startBackgroundWork()` + `registerSignalHandlers()` |
| 121 | Low | duplication | index.ts:220-310 | `shutdown()` repeats `try{X.disconnect()}catch` 11× verbatim | Iterate feed singletons via `safeClose(name, fn)` |
| 122 | Info | dead-code | ws/server.ts:214,230-232 | `channel.startsWith('price:')` re-check unreachable-false (only `price:*` subscribed); `_pattern` unused | Drop the check or comment it's defensive |
| 123 | Medium | smell | ws/server.ts:112-146,54-67 | `authorizeUpgrade` runs Redis/DB/getEffectivePlan with no try/catch → transient error = unhandled rejection, client hangs until TCP timeout | Wrap await in try/catch; write 401/503 + `socket.destroy()` |
| 124 | Low | smell | ws/server.ts:127-133 | Ticket validation `!userId\|\|isNaN` rejects id 0 and is redundant/confusing | Use `Number.isInteger(x) && x>0` |
| 125 | Low | smell | lib/duration.ts:12-20 | Regex accepts `0m`/`0d` → 0ms TTL/maxAge → instantly-expired token, no loud failure | Require `[1-9]\d*` or reject 0; validate expiries at config load |
| 126 | Info | dead-code | app.ts:8,46 | `/_ping` "delete in Stage 2" still wired at retrofit-88+ | Remove endpoint or its stale comment |
| 127 | Info | smell | index.ts:31-34 | Banner claims auth + WS "NOT implemented in Part 1" — both fully implemented | Trim banner to current responsibilities |
| 128 | Low | smell | jobs/snapshot.job.ts:55-56,162 | `drop_chunks` SQL built via interpolation into `$queryRawUnsafe` (constant today, fragile to future edit) | Use parameterized `Prisma.sql`/`make_interval` or assert integer |
| 129 | Low | spaghetti | jobs/snapshot.job.ts:66-218 | `runSnapshotJob` ~150 lines, 4 concerns, two passes over portfolios | Extract `snapshotPortfolios`/`detectMissedSnapshots`/`pruneRetention`/`snapshotTokenPrices` |
| 130 | Info | hardcoded | lib/health.ts:13 | `TIMEOUT_MS=1500` bare literal; can 503 during Neon cold-start | Surface as `HEALTH_TIMEOUT_MS` config |
| 131 | Info | spaghetti | ws/server.ts:180-204 | `broadcastPrice` per-tick `new Date().toISOString()` + parse/stringify; server timestamp loses feed latency | Forward resolver tick timestamp; batch if churn grows |
| 132 | Medium | smell | scripts/backfill-costbasis.ts:55-87,99-106 | Counts connected-portfolio assets as "updated" though recalc no-ops for them → overstated report | Filter to manual portfolios or skip increment for connected |
| 133 | Low | duplication | scripts/backfill-costbasis.ts:111-121 (+4 scripts) | Identical CLI `invokedDirectly` bootstrap copy-pasted in 5 scripts | Extract `src/scripts/lib/cli-main.ts` helper |
| 134 | Low | hardcoded | scripts/seed-catalog.ts:2,8 | `TOKEN_CATALOG_SIZE` read from raw `process.env` (no Zod), default `500` duplicated in comment+code | Register in config schema; read `config.TOKEN_CATALOG_SIZE` |
| 135 | Medium | smell | prisma/seed.ts:42-43 | `Plan.pros/cons` seeded `[]` with launch-blocking TODO; re-seed clobbers any manual fill | Populate from constants or only-set-on-create |
| 136 | Low | smell | scripts/reclassify-nft-spam.ts:75-94 | Omits cache invalidation its sibling reclassify scripts perform | Add invalidation or comment why uncached |
| 137 | Low | hardcoded | wallet-data/nft-spam.ts:55-70 | Hardcoded eth-mainnet spam/legit addresses (dup of #60, reclassify path) | Source from config/DB, chain-qualified |
| 138 | Info | smell | scripts/backfill-snapshots.ts:209-212,150 | `dec8` comment describes a 1e-8 serialization risk `toFixed(8)` already neutralizes | Tighten the comment |
| 139 | Info | hardcoded | prisma/seed.ts:72,92-93 | "30 tokens" literal in comment+log; per-line eslint-disable | Interpolate `TOKENS.length`; eslint override for scripts |
| 140 | Info | spaghetti | scripts/backfill-costbasis.ts:30-32,56-79 | `DryRunRollback` control-by-exception is non-obvious | Add inline note or boolean-returning tx |
| 141 | Medium | duplication | assets/transactions/nfts/analytics/snapshots controllers | Identical `parseId()` positive-int param parser copy-pasted in 5 controllers | Extract `parseId`/`parsePositiveIntParam` into lib |
| 142 | Medium | duplication | assets/transactions/nfts/snapshots/analytics controllers | Portfolio-ownership middleware body duplicated verbatim in 5 controllers | `requirePortfolioOwnership` shared middleware |
| 143 | Medium | duplication | lib/coinbase.ts + binance/kraken/gate/kucoin/okx/bybit | WS reconnect/backoff/heartbeat state machine duplicated across all 7 clients | Base class / `ReconnectingWebSocket` mixin |
| 144 | Low | duplication | wallet-data/providers/moralis.ts:141-145 (and goldrush:614-618) | `num`/`toNum` finite-coercion duplicated (dup of #54) | Shared `toFiniteNumber` |
| 145 | Low | duplication | wallet-data goldrush/alchemy/moralis-handlers | Raw/hex balance decimal-scaling helpers duplicated (`/10**decimals`) | Shared `scaleRawByDecimals` + `hexToRaw` |
| 146 | Medium | duplication | wallet-data providers (8 files) + build-summary + moralis-handlers + canonical-price | Chain-slug→network maps + EVM-slug sets duplicated 8×; **polygon-zkevm native symbol disagrees (ETH vs MATIC)** — a real bug | Derive all maps from chains.constants.ts; reconcile zkEVM symbol |
| 147 | Low | duplication | wallet-data goldrush/zerion/mobula/sync | Daily-series collapse duplicated ×4 (dup of #55) + window math | Shared `collapseDailySeries` + centralized window math |
| 148 | Low | duplication | wallet-data/index.ts:107-119,123-134,216-227,231-243 | First-non-null provider fan-out repeated 5× | Generic `firstNonNull(providers, supports, call)` |
| 149 | Medium | duplication | portfolios/derive.ts; assets/assets.dto.ts; overview.service.ts | Average-cost PnL math implemented 3× (unrealized/costBasis/pct/realized/allTime) | Centralize in `costBasis.ts` |
| 150 | Low | duplication | lib/price-resolver.ts:20; prices.service.ts:17; live-price.ts; usd-value.ts | `PRICE_TTL_S=60` duplicated; price-payload JSON.parse re-implemented ×4 | Export `PRICE_TTL_S`; add `parsePricePayload(raw)` |
| 151 | Low | duplication | webhooks.service.ts:17; moralis-handlers.ts:39 | `REDIS_TTL_30_DAYS=2592000` duplicated (dup of #87) | Shared constant |
| 152 | Low | duplication | assets/portfolios/tokens/payments controllers | Inline raw-json/safeParse body validation repeated instead of `validate()` middleware | Promote `validate()`/`parseBody` to shared lib |
| 153 | Low | duplication | tokens/sync/coinmarketcap-provider.ts:134,180 | CMC logo CDN URL literal duplicated (dup of #46) | Hoist `cmcLogoUrl(id)` |
| 154 | Low | duplication | lib/redis.ts:19-21; redis-subscriber.ts:11-14 | Test-Redis URL selection duplicated (dup of #118) | Export shared `resolveRedisUrl()` |
| 155 | Low | dead-code | users/users.contract.ts:1-43 | Documentation-only orphan module (`export {}`), no importers | Delete; move notes to docs |
| 156 | Info | dead-code | lib/price-symbols.ts:49-52 | `toBinanceBase` test-only trivial wrapper (dup of #73) | Remove and adjust test |
| 157 | Low | duplication | wallet-data moralis/goldrush/ankr/alchemy:getSummary | Dust/spam filter + `buildSummary` call duplicated across 4 providers | Shared `finalizeTokens(rawTokens, name, chainSlug)` |
| 158 | Info | duplication | wallet-data moralis/alchemy/goldrush transfer mappers | In/out `direction` computation duplicated 3+× | Shared `transferDirection(to, wallet)` |

> Note on duplicates: several findings were reported twice across overlapping audit slices and are kept as separate rows for traceability but cross-referenced: #54≈#144, #55≈#147, #46/#153, #87≈#151, #118≈#154, #73≈#156, #60≈#137, #100/#141/#142 (ownership-middleware cluster), #74≈#143 (WS-client cluster). They describe the same underlying code and should be fixed once.

---

## Detailed write-ups — High findings

### H1 (#40) — `fetchPrices` dedups by market-cap only, re-introducing the TON/junk-ticker bug

**File:** `src/modules/tokens/sync/coinmarketcap-provider.ts:206-208`

**What it is.** When CoinMarketCap returns multiple coins sharing a ticker, `fetchPrices` resolves the collision by picking the entry with the highest `market_cap`:

```ts
const entry = entries.reduce((best, cur) =>
  (cur.quote.USD.market_cap ?? 0) > (best.quote.USD.market_cap ?? 0) ? cur : best,
);
```

**Why it matters.** This is the exact defect that retrofit-40 rewrote `fetchMetadata` (lines 118-123) and `fetchTopTokens` (line 173) to fix. Those paths now prefer the **lowest `cmc_rank`** with `market_cap` as a tiebreak, precisely because picking by `market_cap` alone lets a junk coin win whenever the canonical coin's cap is null (the `?? 0` fallback makes a capless real coin lose to any junk coin with a nonzero cap). `fetchPrices` feeds `POST /prices/refresh`, so this path can publish the **wrong coin's price** for a shared ticker (e.g. a rank-3538 "TON") straight onto the canonical `price:<SYM>` key that the whole app reads. The fix was applied to two of three resolution sites and silently skipped here — the most user-visible one.

**Fix.** Extract the same reducer used by `fetchMetadata` into a shared helper and call it from all three sites so the rule can't drift again:

```ts
function pickBestEntry<T extends { cmc_rank?: number | null; quote: { USD: { market_cap?: number | null } } }>(entries: T[]): T {
  return entries.reduce((best, cur) => {
    const br = best.cmc_rank ?? Number.MAX_SAFE_INTEGER;
    const cr = cur.cmc_rank ?? Number.MAX_SAFE_INTEGER;
    if (cr !== br) return cr < br ? cur : best;          // lowest rank wins
    return (cur.quote.USD.market_cap ?? 0) > (best.quote.USD.market_cap ?? 0) ? cur : best; // mcap tiebreak
  });
}
// fetchPrices:
const entry = pickBestEntry(entries);
```

---

### H2 (#90) — `createStream` ignores the address-attach HTTP status, silently producing a stream that watches nothing

**File:** `src/lib/moralis-streams-client.ts:58-68`

**What it is.** `createStream` checks `res.ok` on the stream-creation POST (lines 51-54) but the **follow-up** call that attaches the wallet address does not check status or read an error body:

```ts
const data = await res.json() as { id: string };

// Add wallet address to the stream
await fetch(`${MORALIS_STREAMS_BASE}/${data.id}/address`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': config.MORALIS_API_KEY },
  body: JSON.stringify({ address: opts.address }),
});

return { id: data.id };
```

**Why it matters.** If that second POST fails (4xx/5xx — invalid key scope, rate limit, transient 5xx), `createStream` still returns `{ id }` as success. The portfolio persists a `moralisStreamId`, the connect flow reports success, but **the stream is watching no address** — the connected wallet silently never receives any webhook updates and the user sees a permanently-stale connected portfolio with no error anywhere. This is the same silent-failure class the file's own header documents fixing for the PUT verb in retrofit-58; the unchecked second fetch reintroduces it for address attachment.

**Fix.** Check `res.ok` on the address-add response and throw, consistent with the create/delete calls. The caller already treats a throw as "stream not created" and logs/continues (degraded but honest):

```ts
const addRes = await fetch(`${MORALIS_STREAMS_BASE}/${data.id}/address`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': config.MORALIS_API_KEY },
  body: JSON.stringify({ address: opts.address }),
});
if (!addRes.ok) {
  const body = await addRes.text().catch(() => '');
  throw new Error(`Moralis stream ${data.id} address-add failed: ${addRes.status} ${body}`);
}
return { id: data.id };
```

(Ideally also best-effort `DELETE` the orphaned stream before throwing so a retry doesn't leak streams.)

---

### H3 (#115) — `/health` returns 503 for the whole app when the Coinbase WS feed is transiently down

**File:** `src/lib/health.ts:46-59` (and `app.ts:38-41`)

**What it is.** `checkHealth()` folds Coinbase WS liveness into the overall `ok` flag with the same weight as the database and Redis:

```ts
const ok = db === 'up' && redisStatus === 'up' && coinbaseStatus === 'up';
```

and `app.ts` returns HTTP 503 whenever `health.ok` is false:

```ts
return c.json(err('HEALTH_FAILED', health.failure ?? 'dependency unavailable'), 503);
```

**Why it matters.** A single external WebSocket (Coinbase) reconnecting — which this codebase explicitly treats as recoverable, with watchdog + backoff + reconnect logic in `coinbase.ts` — will make the `/health` probe return 503 even though the API, DB, and Redis are fully healthy. If this endpoint is the Coolify/orchestrator liveness probe, a flapping exchange feed will **restart an otherwise-healthy container**, dropping all in-flight requests and WS connections. Live prices are explicitly a non-critical display overlay (per the retrofit-28 server comments), so they must not gate core liveness. There is already a separate `/ws/health` for feed status.

**Fix.** Keep Coinbase in the response body as informational, but compute `ok` from the truly-critical dependencies only:

```ts
// Coinbase remains reported but does NOT gate liveness.
const ok = db === 'up' && redisStatus === 'up';
return { ok, db, redis: redisStatus, coinbase: coinbaseStatus, failure: ok ? undefined : (db !== 'up' ? 'database' : 'redis') };
```

Consumers that care about feed health can poll `/ws/health` independently.

---

### H4 (#146) — Provider chain maps duplicated 8× with a real native-symbol bug (Polygon zkEVM)

**Files:** `src/modules/wallet-data/build-summary.ts:13-29`, `src/modules/webhooks/moralis-handlers.ts:108-124` (plus goldrush/alchemy/ankr/zerion/mobula/canonical-price)

**What it is.** Every provider keeps its own copy of the chain-slug catalog keyed to that provider's id-space — all derivable from the single source of truth `chains.constants.ts CHAINS`. Two of these maps encode the **same** native-token data and **disagree**:

```ts
// build-summary.ts:25
'polygon-zkevm': 'ETH',
// moralis-handlers.ts:120
'0x44d': 'MATIC',   // Polygon zkEVM
```

**Why it matters.** This is not merely a maintenance smell; the disagreement is a **live bug**. Polygon zkEVM's gas/native token is ETH, so `build-summary` is correct and the webhook map (`CHAIN_NATIVE_SYMBOL`) is wrong — a native transfer ingested on Polygon zkEVM via the Moralis Streams webhook path will be labeled `MATIC` and resolve to the wrong token (wrong price, wrong cost-basis attribution, or skipped as `moralis_unknown_token`). The duplication is exactly what allowed the two copies to drift. Separately, `ZERION_EVM_SLUGS` and `MOBULA_EVM_SLUGS` are an identical 13-element Set, and each provider re-derives its own slug→network map.

**Fix.** Make `chains.constants.ts` the one source of truth by carrying per-provider ids and the native symbol on each chain entry, then build every provider's lookup from that list:

```ts
// chains.constants.ts
export const CHAINS = [
  { slug: 'polygon-zkevm', name: 'Polygon zkEVM', moralisId: '0x44d', nativeSymbol: 'ETH', addressFormat: 'evm', /* ... */ },
  // ...
] as const;

// build native-symbol lookups from the catalog:
export const NATIVE_SYMBOL_BY_SLUG     = Object.fromEntries(CHAINS.map(c => [c.slug, c.nativeSymbol]));
export const NATIVE_SYMBOL_BY_MORALIS  = Object.fromEntries(CHAINS.map(c => [c.moralisId, c.nativeSymbol]));
```

As an immediate hotfix independent of the refactor, correct `moralis-handlers.ts:120` to `'0x44d': 'ETH'`. Also collapse `ZERION_EVM_SLUGS`/`MOBULA_EVM_SLUGS` into one shared EVM-slug set derived from `CHAINS`.


---

## Code Quality — Frontend

This pass examined the SvelteKit frontend across routes, shared `$lib` modules, and reusable components. The dominant themes are pervasive duplication (formatters, palettes, chart/donut math, modal chrome, CSV export), hardcoded design values that bypass the existing CSS token system (especially `#F59E0B` and `rgba(108,99,255,*)`), and accumulated dead code/scaffolding from earlier design iterations. A small number of higher-severity findings concern user-facing correctness: refund flows that silently ignore the selected payment, inconsistent refund-window copy, a transfer modal that discards the chosen destination token, and a still-live `VITE_MOCK_AUTH` auth bypass.

**Severity tally:** Critical: 0 · High: 4 · Medium: 14 · Low: 56 · Info: 24 (total: 98 findings)

| # | Sev | Category | Location (file:lines) | Issue | Recommended fix |
|---|-----|----------|------------------------|-------|-----------------|
| 1 | Low | duplication | dashboard/+page.svelte:72-74 | `RANGE_DAYS` declared but never used in component; verbatim copy of `+page.ts:67` | Delete unused block; hoist one shared `RANGE_DAYS` if needed |
| 2 | Low | duplication | dashboard/+page.ts:69 | 8-color `PALETTE` copy-pasted across dashboard/wallet/performance loaders | Extract shared `PALETTE` + `hexToRgba` into `$lib/palette.ts` |
| 3 | Low | dead-code | dashboard/+page.ts:211 | Tx status always `'neutral'`; `'live'` branch and `as 'live'|'neutral'` cast unreachable | Drop `'live'` concept or actually populate it |
| 4 | Low | dead-code | wallet/[portfolioSlug]/[tokenSlug]/+page.ts:142-172 | Token-detail loader computes ath/atl/change/price/portfolio/pnlAllTime* the component never reads | Remove unused fields (and orphaned helpers) or wire into UI |
| 5 | Info | dead-code | [tokenSlug]/+page.ts:24-26 | `AssetDTO.netDeposit`/`pnlAllTime`/`pnlAllTimeValue` declared/parsed but unused | Trim `AssetDTO` to consumed fields |
| 6 | Info | dead-code | wallet/+page.ts:8-24 | `WalletAsset.alloc`/`avgCost`/`costTracked`/`unrealizedPnl*` populated but never read | Drop unused fields from `WalletAsset`/`toWalletAsset` |
| 7 | Medium | spaghetti | dashboard/+page.svelte:250-262 | Per-portfolio live PnL re-apportions global delta by value-share instead of own holdings | Pass per-portfolio holdings; compute each portfolio's liveDelta from its own holdings |
| 8 | Medium | smell | [tokenSlug]/+page.svelte:81-86 | `priceDaysAgo` returns oldest in-window point, not ~N days ago; skews change24h & PnL | Pick point closest to cutoff (or interpolate) |
| 9 | Low | smell | [tokenSlug]/+page.svelte:96-108 | All-time price-return for cost-unknown uses `history[0]` regardless of period; mislabeled | Label as "since tracking began"; unify with `priceDaysAgo` |
| 10 | Low | smell | (dashboard)/+layout.svelte:13-22,62,71 | User fallback `{name,email}` missing id/avatarUrl contradicts declared Props type | Make fallback match shape or relax Props type; drop unused `id` |
| 11 | Info | dead-code | dashboard/+page.svelte:778-782,1249-1251 | `@media (max-width:1279px)` re-sets `repeat(3,1fr)`, identical to base — dead CSS | Delete redundant media query |
| 12 | Low | hardcoded | wallet/+page.svelte:451-452 | NFT thumb SVG gradient hardcodes `#6C63FF`/`#22D3EE` instead of theme tokens | Reference `var(--primary)`/accent token |
| 13 | Low | duplication | [tokenSlug]/+page.ts:54-59 | `fmtPct`/`signedUsd` reimplemented per-file with divergent null contracts | Add `formatSignedUsd`/`formatSignedPct` to `$lib/format` |
| 14 | Low | duplication | dashboard/+page.ts:88-100 | `txLabel`/`isInflow` direction mapping duplicated across 3 loaders, diverging copies | Centralize a single direction classifier |
| 15 | Info | duplication | dashboard/+page.ts:101-112 | `relativeTime`/`fmtDate`/`fmtTime` duplicated with verbatim option literals | Move into `$lib/format` |
| 16 | Info | smell | dashboard/+page.svelte:711-713 | Two stale TODOs; empty-state CTA → `/onboarding` bounces complete users | Resolve stale TODO; point CTA at real creation flow |
| 17 | Info | hardcoded | dashboard/+page.svelte:1329-1330 | `.empty-icon` uses raw `rgba(108,99,255,...)` instead of `--primary` | Use `color-mix(in srgb, var(--primary) 12%, transparent)` |
| 18 | Low | spaghetti | dashboard/+page.svelte:88-201 | ~110-line inline chart derived chain mixes zoom state into path math; parallels AreaChart | Extract a chart component / extend AreaChart |
| 19 | Info | hardcoded | dashboard/+page.svelte:81-84,224,264-265 | Donut/chart geometry magic numbers scattered & duplicated between two donuts | Group into named config; share `-90` start + full-circle epsilon |
| 20 | Low | smell | dashboard/+page.ts:97-100,210 | `isInflow` only treats buy/in as inflow; transfer legs render as red outflow | Base transfer-leg sign on in/out (or neutral) |
| 21 | High | spaghetti | payments/+page.svelte:68-80,177-191,358-365,376-389,410-415 | Two parallel refund flows hit same endpoint that ignores the selected payment | Consolidate to one entry; send selected paymentId or remove per-row control |
| 22 | High | hardcoded | payments/+page.svelte:90-94,185,315,358,381 | Refund window inconsistent: client 3-day vs "7 days" hint vs server flag | Single source of truth = server `refundAvailable`; derive all copy from one constant |
| 23 | Medium | dead-code | payments/+page.ts:59 | `receiptUrl` always `'#'`; "View"/"View Details" links are dead | Populate from Stripe receipt URL or remove affordances |
| 24 | Low | dead-code | payments/+page.ts:69-71 | `lastPaymentDate`/`lastPaymentAmount`/`status` computed but never consumed | Remove from returned subscription object |
| 25 | Low | dead-code | performance/+page.ts:60,210 | `heroStats.allTimePnlPct` populated but page recomputes live | Drop `allTimePnlPct` from heroStats |
| 26 | Low | duplication | payments/+page.ts:25-27 | `mapStatus` then `txStatusVariant` — two-hop string remap; refunded/failed collapse anyway | Collapse to a single status→variant mapping |
| 27 | Low | duplication | performance/+page.svelte:246-277 | CSV export (`esc` + blob/anchor) duplicated in settings with divergent quoting | Extract `$lib/csv.ts` (`escapeCsv` + `downloadCsv`) |
| 28 | Low | smell | settings/+page.svelte:46,54-57,335 | `accept="image/*"` offers types the JS whitelist rejects | Set `accept` to the exact allowed MIME/ext list |
| 29 | Low | smell | settings/+page.svelte:181-199 | Debounced prefs `$effect` has no cleanup; timer fires after navigation | `return () => clearTimeout(prefsTimer)` |
| 30 | Low | hardcoded | payments/+page.svelte:650-653 | `.cycle-discount` hardcodes `#F59E0B` instead of a token | Introduce `var(--warning)`/`--amber` |
| 31 | Medium | hardcoded | payments/+page.svelte:140,247,277-281 | Plan prices hardcoded & internally inconsistent ($200 vs $204/yr, −15% mismatch) | Source pricing & discount % from one config/backend object |
| 32 | Low | spaghetti | performance/+page.svelte:133-147 | `pcEstIdx` linear scan + re-slice on every live tick over ALL-window arrays | Binary search on sorted dates; precompute boundary per range change |
| 33 | Info | smell | performance/+page.svelte:311,319,338,360 | Duplicate/non-monotonic hardcoded `animation-delay` values | Drive stagger from render index |
| 34 | Low | spaghetti | performance/+page.ts:140-147 | N+1 `/analytics/:id/summary` fan-out per portfolio on every load | Single aggregate endpoint or scope to selected subset |
| 35 | Info | hardcoded | payments/+page.svelte:90-94 | ms-per-day inlined as `(1000*60*60*24)` vs `86_400_000` elsewhere; bare `3` threshold | Define shared `MS_PER_DAY` + refund-window constant |
| 36 | Medium | dead-code | hooks.server.ts:52-73 | `event.locals.session` assembled every load but never read (no server loads exist) | Remove the assignment; keep only `onboardingStatus`, or add `+layout.server.ts` |
| 37 | Low | dead-code | app.d.ts:4-22 | `App.Locals.session` & `App.PageData.session` are unused dead types | Remove `PageData.session`; remove `Locals.session` if hooks block dropped |
| 38 | Low | dead-code | (public)/design-system/+page.svelte:1-1384 | 1384-line style guide ships to prod, publicly reachable, re-declares all tokens | Gate behind `import.meta.env.DEV` or delete from shipped routes |
| 39 | Low | dead-code | onboarding/+page.svelte:121-139 | `CHAINS`/`ALL_TOKENS`/`Token`/`mockPrice` declared but never used | Delete dead scaffolding |
| 40 | Low | hardcoded | (public)/+page.svelte:6-23 | Hardcoded CoinGecko logo URLs scattered & inconsistent, no `onerror` fallback | Centralize logo map (or self-host); add img fallback |
| 41 | Low | hardcoded | (public)/+page.svelte:115-135 | Primary/accent hardcoded as `rgba()` literals & SVG `stop-color` throughout | Shadow/glow tokens or `rgb(from var(--primary) ...)` |
| 42 | Low | duplication | (public)/privacy/+page.svelte:32-70 | privacy & terms duplicate identical layout/style block + hardcoded date | Extract shared `LegalPage` component; one date constant |
| 43 | Low | duplication | forgot-password/+page.svelte:83-170 | forgot/reset/verify-email duplicate ~90 lines of card CSS three times | Extract shared `AuthCard` component |
| 44 | Low | spaghetti | onboarding/+page.svelte:662-735 | Redundant inner `{#if path==='manual'}` inside same-condition block; orphan comment stubs | Remove redundant guard + stubs |
| 45 | Low | spaghetti | onboarding/+page.svelte:293-329 | `submitManual` mixes addAsset loop + CSV POST; nested-ternary cost payload | Extract `toCostPayload`; split into two functions |
| 46 | Medium | smell | hooks.server.ts:24-28 | `VITE_MOCK_AUTH` bypass in 2 places, stale TODO; misconfig exposes gated routes | Remove or guard with `import.meta.env.DEV`; consolidate |
| 47 | Low | hardcoded | (public)/register/+page.svelte:261-279 | `calc(100vh - 64px)` magic header-height repeated; navbar isn't 64px-tall | Define `--header-h`; or use `100dvh` since navbar is fixed |
| 48 | Low | smell | (public)/+page.svelte:26-27 | Newsletter `handleNewsletter` is a no-op (only `preventDefault`) | Wire to real endpoint or remove/mark coming-soon |
| 49 | Low | smell | (public)/register/+page.svelte:78-81 | Google OAuth URL hand-rolled, not in ENDPOINTS; `?? ''` silently navigates relative | Add `ENDPOINTS.auth.google`; fail explicitly if base missing |
| 50 | Low | smell | onboarding/+page.svelte:68-86 | `checkVerifiedAndContinue` uses unchecked deep cast on `/users/me` shape | Reuse shared `MeResponse`/`OnboardingStatus` union; handle unexpected value |
| 51 | Low | duplication | (public)/+page.svelte:225-369 | Pill/arrow SVG CTA markup copy-pasted ≥3x; navbar SVGs re-inlined | Extract `ArrowLink`/`PillButton` component |
| 52 | Low | duplication | reset-password/+page.svelte:22-41 | Password policy duplicated; register enforces weaker rule (length-only) | One shared `validatePassword()` helper |
| 53 | Low | duplication | (public)/register/+page.svelte:241-243 | Spinner SVG + `@keyframes spin` reimplemented 3x | One `Spinner` component |
| 54 | Low | spaghetti | onboarding/+page.svelte:395-419 | Path-card keydown uses comma-operator side effects; only Enter handled | Extract `choosePath(p)`; handle Enter+Space |
| 55 | Low | smell | +layout.ts:1 | `prerender=true` default + 5 copied opt-outs; design-system prerendered | Flip default or group client-rendered routes; exclude design-system |
| 56 | Low | duplication | Sidebar.svelte:83-90; TopBar.svelte:24-31 | `initials()` copy-pasted verbatim in two components | Extract to `$lib/format`; ideally an `<Avatar>` |
| 57 | Low | duplication | StartingAssetsEditor.svelte:19-21; AddTransactionModal.svelte:123 | `nowLocal()` tz-offset datetime helper duplicated | Add `localDatetimeInputValue()` to `$lib/format` |
| 58 | Low | dead-code | StatCard.svelte:8-9,23-27 | `change`/`changeDir` props only used by design-system demo | Delete props+branch or migrate dashboard cards to it |
| 59 | Info | dead-code | Badge.svelte:5,38-41,102-105 | `free` variant is a styling duplicate of `neutral`, unused in app | Drop `free` variant from union+CSS |
| 60 | Info | dead-code | TokenPicker.svelte:18,44 | `TOKEN_LIST_MAX_HEIGHT` exported but no importer; `maxHeight` prop never overridden | Drop the `export` (plain const) |
| 61 | Low | smell | DonutChart.svelte:16,35,100 | Unused `cx/cy/r/sw` props; center label can read 99%/101% from rounded sums | Round/clamp displayed total; drop geometry props if unused |
| 62 | Info | dead-code | AreaChart.svelte:301 vs 175 | `.chart-svg{cursor:crosshair}` overridden by inline grab cursor — dead CSS | Remove `cursor:crosshair` |
| 63 | Info | smell | AreaChart.svelte:179 | `aria-label="Area chart"` is static & non-informative | Accept `ariaLabel`/build summary |
| 64 | Low | hardcoded | Sidebar.svelte:28-61,131-133 | Nav icons via `{@html item.icon}` from stringly-typed SVG table | Replace with icon snippet components / `{#if}` switch |
| 65 | Low | smell | TopBar.svelte:20-21,46-58 | Notification bell only locally hides count; no real source | Wire to real notifications or remove/disable |
| 66 | Low | spaghetti | AreaChart.svelte:1-370 | Over-long multi-responsibility component; imperative `lastLen` reset | Factor pure geometry to helper; split axis child; replace `lastLen` guard |
| 67 | Info | duplication | DonutChart.svelte:66-81,113-126 | Hover handlers copy-pasted between arcs and legend loops | Extract `setHover(i)`/`clearHover()` |
| 68 | Info | hardcoded | ResyncButton.svelte:59 | `3600` auto-unlock ceiling (and `2000`ms) are magic numbers coupling backend policy | Name `MAX_AUTO_UNLOCK_SECS` or have backend signal unlockability |
| 69 | Info | smell | ConnectionBanner.svelte:4,8 | WS banner visibility gated on `VITE_MOCK_AUTH` — auth flag leaks into UX | Use dedicated `VITE_DISABLE_WS`/`VITE_LIVE_PRICES` flag |
| 70 | Info | hardcoded | PortfolioDropdown.svelte:180,189,247,250,252,253 | `rgba(108,99,255,*)` brand tints hardcoded across many components | Alpha-tint tokens or `color-mix` pattern |
| 71 | Info | smell | TokenIcon.svelte:25,28-31,36-37 | `OVERRIDES` key-casing inconsistent (lower vs upper); inline TON CMC URL | One canonical normalization; move overrides to shared config |
| 72 | Info | spaghetti | PortfolioDropdown.svelte:50-62 | Manual `document` mousedown listener instead of shared Backdrop; no Escape | Add Escape / `use:clickOutside` action |
| 73 | High | spaghetti | modals/AddTransactionModal.svelte:138-160,195,218-225,530-559 | Transfer destination token selected & gated but never sent; source symbol reused | Pass destination token to API or remove picker+gate |
| 74 | Info | dead-code | modals/AddTransactionModal.svelte:24 | `TokenOpt.usdVal` declared but never read | Drop the field |
| 75 | Low | smell | modals/AddTransactionModal.svelte:172-178,372-373 | Transfer total uses parsed formatted string price, not live price | Use `$prices.get(sym) ?? parsePrice(...)`; drop "mock price" comment |
| 76 | Medium | duplication | modals/AnalyticsGateModal.svelte:9-12; FeatureGateModal:12-15; LimitReachedModal:12-15 | Three near-identical Pro-upgrade gate modals with copy-pasted `unlock()` | Extract one `UpgradeGateModal` taking props/slot |
| 77 | Medium | duplication | modals/AddAssetModal.svelte:159-291 (+9 modals) | Modal shell/scaleUp/close-btn/select-field/480px sheet duplicated across modals | Move shared chrome into Backdrop or `:global` modal stylesheet |
| 78 | Low | hardcoded | modals/AddAssetModal.svelte:257 (+AddTransactionModal:849, NewPortfolioModal:677) | Data-URI chevron hardcodes `#94A3B8` stroke; won't theme | Shared select component driving color from CSS var |
| 79 | Low | hardcoded | modals/LimitReachedModal.svelte:37-39,54,63 (+FeatureGateModal) | Plan terms ('15 portfolios', '$20/mo', '7-day') hardcoded across modals | Centralize `PLAN.*` config constants |
| 80 | Low | hardcoded | modals/RefundConfirmModal.svelte:93 | `support@neonfi.io` hardcoded in markup | Pull from `PUBLIC_SUPPORT_EMAIL` config |
| 81 | Low | smell | modals/RefundConfirmModal.svelte:20-24 | `clipboard.writeText` not awaited/caught; shows "Copied!" even on failure | Use `.then()/.catch()` + guard `navigator.clipboard` |
| 82 | Info | dead-code | modals/NftDetailModal.svelte:6-27 | `NftItem.id`/`spam` declared but never read in modal | Move shared shape to types module; trim modal contract |
| 83 | Info | dead-code | modals/TxDetailModal.svelte:6-31 | `TxItem.kind/addr/action/img/ts` never rendered in modal | Split list shape from modal subset |
| 84 | Low | smell | modals/TxDetailModal.svelte:141-148 | Explorer link renders even when `tx.scan` empty (manual tx) → `<a href="">` | Wrap in `{#if tx.scan}` |
| 85 | Low | hardcoded | modals/NewPortfolioModal.svelte:751 (+5 modals) | Raw hex (`#F59E0B`, `#DC2626`, gradients) instead of theme tokens | Promote to shared tokens (`--warning`, `--danger-strong`, `--grad-*`) |
| 86 | Medium | duplication | modals/NewPortfolioModal.svelte:145-163,230-236 (vs ImportCsvModal:73-104,120-127) | CSV parse/preview + payload mapper duplicated between two modals | Extract `$lib/csv-import` helpers / shared upload subcomponent |
| 87 | Low | spaghetti | modals/AddTransactionModal.svelte:211-258 | `done()` over-long, mixed-responsibility, branchy payload assembly | Split into typed builder helpers; keep `done()` orchestration-only |
| 88 | Info | dead-code | modals/NewPortfolioModal.svelte:448-450,784-786,862-868 | Orphaned screen comments + empty style-section headers | Delete leftovers |
| 89 | Low | smell | modals/ImportCsvModal.svelte:89-98 | Symbol check `catch{}` swallows all errors; malformed-200 treated as valid | Distinguish unavailable vs error; validate response shape |
| 90 | Low | dead-code | portfolios-api.ts:47-52 | `searchTokens()` exported with zero callers (superseded by `fetchTokensPage`) | Delete or mark currently-unused |
| 91 | Low | dead-code | chart-zoom-pan.ts:38-39,208-227,300 | `mouseDown` exposed publicly but only `dragPan` action used | Make `mouseDown` private; drop from interface |
| 92 | Low | dead-code | endpoints.ts:29,33,54,67,68 | Unused endpoint keys (downgrade, payments.detail, snapshots, analytics.performance/holdings) | Remove or annotate as reserved |
| 93 | Info | dead-code | lib/index.ts:1 | Empty 0-byte orphan barrel; nothing imports bare `$lib` | Delete the file |
| 94 | Low | duplication | intraday.ts:325,345 | Clock-time `toLocaleTimeString` formatter duplicated 3x (+ date+time 2x) | Extract `clockTimeLabel`/`dateTimeLabel` |
| 95 | Medium | hardcoded | app.css:1 | Render-blocking Google Fonts `@import` of remote host; offline/GDPR-fragile | Move to `<link preconnect>`+stylesheet in app.html or self-host |
| 96 | Low | hardcoded | app.html:7 | Favicon data-URI hardcodes brand hex that exist as tokens | Move to static SVG; comment cross-link to tokens |
| 97 | Low | smell | stores/theme.ts:4,11 | Theme cookie via substring `includes('theme=light')` (false-positive); magic max-age; no SameSite | Parse by name; name constant; add `SameSite=Lax` |
| 98 | Medium | smell | csv-import.ts:272-278 | `else if` skips `acquired_date` validation when `cost_per_unit` present; bad date passes | Validate cost & date independently (two `if` blocks) |
| 99 | Low | smell | csv-import.ts:61,174,185-187 | `headerCols` computed but unused; extra-column check is size-only; tx optional fields unvalidated | Use or remove `headerCols`; decide unknown-column policy |
| 100 | Low | hardcoded | csv-import.ts:65,117,125 | `MAX_DECIMAL=1e12` + `NUM_RE` re-implement backend Zod rules with only a comment | Document exact backend rule; cross-link/surface from shared contract |
| 101 | Low | smell | ws.ts:70-97 | WS firehose casts unvalidated server payloads via `as`; control-frame fields trusted | Treat payload as `unknown`; narrow with runtime checks |
| 102 | Low | hardcoded | api.ts:34 | `OWNS_401` auth-path list hardcoded, decoupled from ENDPOINTS | Derive from `ENDPOINTS.auth`; document omissions |
| 103 | Info | hardcoded | intraday.ts:33-40,224 | `RANGE_MS` repeats `86_400_000`/`365`; mixed literal styles; bare `MAX_CHART_POINTS` | Introduce `DAY_MS`/`HOUR_MS`; build `RANGE_MS` from them |
| 104 | Low | spaghetti | intraday.ts:86-178 | `reconstructValueSeries` ~90-line multi-concern function; 7-field cursors | Extract `valueAt(cursor,t)`; split timeline from accumulation |
| 105 | Info | duplication | intraday.ts:63-69 | `fetchIntradaySeries` is a thin back-compat alias of `fetchPriceSeries` | Inline at single caller or note one-caller convenience |
| 106 | Low | smell | chart-zoom-pan.ts:24-25,92,246 | `getEffTotal`/`getDataLen` near-synonymous, undocumented, easy to transpose | Add JSDoc explaining each getter's clamping role |
| 107 | Info | duplication | format.ts:6-8 | `formatUsd` is a pass-through alias of `formatPrice`; `formatMoney` differs — naming hazard | Remove alias post-migration or rename trio for intent |
| 108 | Medium | dead-code | CLEANUP_FLAGGED.md:8-22,49-91 | Stale: documents removed `mockPro` store & non-existent server files; wrong session enum | Delete/rewrite stale items to match real wiring |
| 109 | Medium | duplication | dashboard/+page.ts:69 | Portfolio `PALETTE` duplicated across 4 loaders; settings already drifted to 6 colors | Extract `PORTFOLIO_PALETTE` + `paletteColor(i)` to lib |
| 110 | Medium | duplication | format.ts:6-38 | `signedUsd`/`signedPct`/`fmtPct`/`fmtSignedUsd` reimplemented in 7+ files, divergent | Add null-safe `signedUsd`/`signedPct` to format.ts; pick one money formatter |
| 111 | Medium | duplication | dashboard/+page.svelte:81-243,411-495 | Entire inline SVG line-chart duplicated in dashboard & performance (~200 lines + CSS) | Extend AreaChart / add `PortfolioValueChart.svelte` |
| 112 | Low | duplication | dashboard/+page.svelte:222-276 | `arcPath` donut math reimplemented inline despite DonutChart.svelte | Reuse DonutChart or extract `$lib/svg.ts` `arcPath` |
| 113 | Low | duplication | dashboard/+page.svelte:69-74 | `ChartRange` type & day-window map duplicated 3x despite `$lib/intraday` exports | Import `ChartRange`; export single `RANGE_DAYS` |
| 114 | Low | duplication | performance/+page.svelte:246-277 | CSV download duplicated & inconsistent (esc + line-endings) vs settings | Shared `downloadCsv(filename, rows)` with canonical RFC-4180 esc |
| 115 | Low | dead-code | format.ts:41-52 | `formatCompact` exported but no call site | Remove unless upcoming market-cap view |
| 116 | Low | hardcoded | app.css:18,38 | `--warning` token exists but `#F59E0B` hardcoded in 12 files; won't theme to light | Replace standalone usages with `var(--warning)` |
| 117 | Low | hardcoded | AreaChart.svelte:306-312 | `.grid-line` hardcodes `#1E1E3A`/`#E0DEFF` reimplementing `var(--border)` | Use `stroke: var(--border)`; delete light override |
| 118 | Low | hardcoded | app.css:19-20,39-40 | `rgba(108,99,255,*)` repeated 116× across 30 files for `--primary` | Alpha-primary tokens or `rgb(from var(--primary) ...)` |
| 119 | Low | duplication | wallet/+page.svelte:128 | Portfolio name→slug logic duplicated; not shared with backend slug rules | Extract `portfolioSlug(name)` helper mirroring backend |
| 120 | Low | duplication | chart-markers.ts:49-58 | `isInflow`/`txLabel`/`txKind` duplicated across loaders & chart-markers | Centralize transaction-direction helpers in `$lib/transactions.ts` |
| 121 | Low | duplication | performance/+page.svelte:311-376,645-676 | Performance hero reimplements StatCard markup/CSS instead of component | Render with `<StatCard>` |
| 122 | Low | dead-code | (public)/design-system/+page.svelte:1 | `/design-system` publicly reachable, no guard, crawlable (robots allows all) | Gate/dev-flag the route; add `Disallow: /design-system` |
| 123 | Low | dead-code | hooks.server.ts:24-28 | `VITE_MOCK_AUTH` bypass scattered across 5 files, no central flag, stale TODOs | Centralize flag; build-time assert it's falsy in prod |

> Note: Findings #2 and #109 are the same `PALETTE` duplication observed at two confidence levels (low/medium); #36 and #46/#123 overlap on the `hooks.server.ts` mock-auth/locals concerns; #21/#22 and #80 all touch the payments refund flow; #110 subsumes the per-file formatter findings #13/#15. They are retained as distinct rows because each names a separately-actionable location, except where genuinely identical.

---

### #21 (High) — Two parallel refund flows both call an endpoint that ignores the selected payment

**What it is.** `payments/+page.svelte` ships two independent refund mechanisms. (1) A top-level, subscription-wide "Request Refund" button gated on `data.refundEligible` calls `handleRefund()` → `api.post(ENDPOINTS.subscriptions.refund, {})`. (2) A per-payment-row refund (inline button + kebab item) opens `RefundConfirmModal` with a specific `refundTarget`, showing that row's amount/date/paymentId. But `RefundConfirmModal.handleSubmit` *also* posts to the same `ENDPOINTS.subscriptions.refund`, and its own comment admits "Backend refunds the most recent eligible payment … the displayed paymentId is for the support-email path, not sent in the body."

**Why it matters.** The per-row UI implies granular control ("refund *this* charge") that does not exist — the backend refunds whatever it considers the most recent eligible payment regardless of selection. A user who deliberately picks an older charge will silently have a different charge refunded. This is a correctness/trust bug, not a cosmetic one: money moves against a charge the user did not choose.

**Evidence.**
```js
// RefundConfirmModal.svelte
await api.post(ENDPOINTS.subscriptions.refund, reason.trim() ? { reason: reason.trim() } : {});
// comment: "the displayed paymentId is for the support-email path, not sent in the body."

// payments/+page.svelte handleRefund
await api.post(ENDPOINTS.subscriptions.refund, {});
```

**Fix.** Consolidate to one refund entry point. If the backend genuinely only refunds the most-recent eligible payment, remove the per-row refund affordance entirely (keep only the subscription-wide button). If per-charge refunds are intended, send the selected id:
```js
// RefundConfirmModal handleSubmit
await api.post(ENDPOINTS.subscriptions.refund, {
  paymentId: payment.paymentId,            // make selection load-bearing
  ...(reason.trim() ? { reason: reason.trim() } : {})
});
```
…and have the backend honor `paymentId`. At minimum, change the per-row modal copy to state which payment will actually be refunded so the UI stops lying about granularity.

---

### #22 (High) — Refund eligibility window is inconsistent across three places (3 days vs 7 days vs server flag)

**What it is.** Three different refund-window rules coexist on one page:
- `isEligible()` hardcodes a 3-day window (`diffDays <= 3`) and gates the per-row refund buttons.
- The top-level refund-row hint text says "Eligible within 7 days of payment".
- The policy note says "Refunds are available within 3 days of payment".
- Separately, the loader gates the top-level button on the **server** flag `p.refundAvailable`.

**Why it matters.** The per-row buttons (client 3-day heuristic) and the top-level button (server flag) can disagree about whether a refund is possible, and the on-screen copy contradicts itself (7 vs 3 days). Users get conflicting signals, and the client-side magic number duplicates a decision that rightfully belongs to the server — a near-certain source of "the button said I was eligible but the refund failed" support tickets.

**Evidence.**
```js
// isEligible()
return diffDays <= 3;
// hint
>Eligible within 7 days of payment</span>
// policy
Refunds are available within 3 days of payment.
```

**Fix.** Make the server `refundAvailable` flag the single source of truth for *every* refund affordance (per-row and top-level), and derive all copy from one constant:
```js
const REFUND_WINDOW_DAYS = 3; // mirror backend policy, or better: read from server
// gate all buttons on row.refundAvailable (server), not a client date heuristic
```
Delete `isEligible()`'s 3-day heuristic (or have the server return per-payment `refundAvailable`), and template the hint/policy text from `REFUND_WINDOW_DAYS` so "3" and "7" can never diverge again.

---

### #73 (High) — Portfolio-transfer destination token is selected but never sent to the backend

**What it is.** For an in-app "To Portfolio" transfer, `AddTransactionModal` forces the user through a destination-token picker (`destTokenQuery` / `filteredDestTokens` / `destTokenSym`) and `step2Valid` blocks submit until `destTokenSym !== ''`. But `done()` calls `createTransfer(selectedPortfolioId, { destPortfolioId, symbol, amount, timestamp, notes })` where `symbol = selectedToken.sym` (the **source** token). `destTokenSym` is never passed, and `createTransfer`'s input type (`portfolios-api.ts:244-249`) has no destination-token field at all.

**Why it matters.** The user is compelled to search and select a destination token whose value is silently discarded — the source symbol is used for both legs of the transfer. Either the picker is dead UX wasting the user's time and implying a cross-token capability that doesn't exist, or the cross-token transfer feature is half-wired and will produce incorrect destination-leg records. Both are user-visible defects on a financial action.

**Evidence.**
```js
let destTokenSym = $state('');
// step2Valid: requires destTokenSym !== ''
return destPortoId !== -1 && destTokenSym !== '' && units.trim() !== '' ...;

// done()
const symbol = selectedToken.sym;                 // SOURCE token
await createTransfer(selectedPortfolioId, {
  destPortfolioId: destPortoId, symbol, amount: toDecimalString(units), timestamp: ts, notes
});                                               // destTokenSym never used
```

**Fix.** Decide the feature's intent and make the two ends agree:
- If transfers keep the same symbol on both legs: **remove** the destination-token picker, `destTokenQuery`/`filteredDestTokens`/`destTokenSym`, and the `step2Valid` gate, and document that behavior.
- If cross-token transfers are intended: add a destination field to `createTransfer`'s input type and pass it, e.g.
```js
await createTransfer(selectedPortfolioId, {
  destPortfolioId: destPortoId,
  symbol,                          // source leg
  destSymbol: destTokenSym,        // destination leg
  amount: toDecimalString(units), timestamp: ts, notes
});
```
…with the backend recording the destination leg in `destSymbol`.


---

I'll analyze the findings and write the Documentation Divergence section. Let me note there are some exact duplicates in the JSON (multiple WS price_update payload findings) that I'll merge.

## Documentation Divergence

This section catalogs every point where the deployed implementation diverges from the authoritative specs (architecture.txt / implementation.txt / Build Guide / docs/schema.txt). The vast majority are benign-but-undocumented schema additions and copy mismatches; the load-bearing issues cluster around the WebSocket price-update contract (a deliberate retrofit-28 "firehose" redesign that silently contradicts every authoritative doc and the documented client `subscribe` protocol), the `POST /auth/google` verb, and several altered primary-key / uniqueness / nullability constraints. None of these are runtime bugs in isolation — the frontend and backend generally agree with *each other* — but the written specs were never reconciled, which is exactly the silent-divergence class the Build Guide warns against.

**Severity tally:** Critical: 0 · High: 9 · Medium: 14 · Low: 27 · Info: 8 — **58 findings total** (the three duplicate WebSocket `price_update` payload-shape findings are merged into a single row, F1, with a note; the two duplicate "no subscribe handshake / registry" findings are merged into F2).

| # | Sev | Category | Location (file:lines) | Issue | Recommended fix |
|---|-----|----------|----------------------|-------|-----------------|
| F1 | High | contradiction | src/ws/server.ts:193-197 (+ frontend src/lib/ws.ts:62-93) | `price_update` payload nests `{ prices: [{symbol,price,change24h}] }` instead of the documented flat `payload:{symbol,price,change24h}`; Build Guide §2.7 flags this exact shape as a prior bug. *(Merges 3 duplicate findings; FE ws.ts updated to match the array, so FE/BE agree but both contradict the spec.)* | Update architecture.txt WS section + Build Guide §2.7 to document the `payload.prices[]` batch shape as authoritative, or revert to the flat per-symbol shape. |
| F2 | High | contradiction/missing | src/ws/server.ts:158-204; src/ws/registry.ts:10-13 | Server `psubscribe`s `price:*` and broadcasts every tick to **every** socket; inbound `message` frames ignored; no `symbol→[socketIds]` registry and no reference-counted upstream subscribe/unsubscribe. *(Merges 2 duplicate firehose findings.)* | Document the firehose model in the spec, or restore the per-token registry + `subscribe` protocol. |
| F3 | High | contradiction | prisma/schema.prisma:400,422 | `Transaction.transactionHash` uniqueness changed from spec's GLOBAL `@unique` to per-portfolio composite `@@unique([portfolioId, transactionHash])`. | Update spec to per-portfolio composite uniqueness (impl is deliberate/correct). |
| F4 | High | contradiction | prisma/schema.prisma:197-198 | `Payment.subscriptionId` flipped from required + implicit Restrict to nullable + `onDelete:SetNull` (reverses delete semantics). | Update spec Payment to nullable + SetNull (account-deletion requirement). |
| F5 | High | contradiction | prisma/schema.prisma:563,580 | `BalanceSnapshot` PK changed from `id` to composite `@@id([portfolioId, snapshotDate])` (TimescaleDB TS103 requirement). | Update spec to the composite PK with `id` as non-PK column. |
| F6 | High | mismatch | src/modules/auth/auth.controller.ts:230-274 | Spec defines `POST /auth/google` (3 docs); impl exposes `GET /auth/google` redirect + undocumented `GET /auth/google/callback`. No POST route exists → 404/405 for spec-conformant callers. | Add `POST /auth/google` token-exchange, or update all 3 specs to the GET redirect+callback flow. |
| F7 | Medium | contradiction | src/ws/registry.ts:10-13 | WS registry held in in-process JS Maps, not Redis — contradicts §6.4 horizontal-scaling contract; `plan_downgraded` only targets same-process sockets. | Document single-process MVP decision, or move registry to Redis. |
| F8 | Medium | extra | prisma/schema.prisma:430-436 | Lookup model `TransactionDirection` (buy/sell/transfer) entirely absent from spec; load-bearing for balance recalc. | Add `TransactionDirection` to the spec. |
| F9 | Medium | extra | prisma/schema.prisma:392-393 | `Transaction.directionId` is a required FK not in spec's Transaction model (hard write-shape addition). | Reflect required `directionId` in spec Transaction. |
| F10 | Medium | extra | prisma/schema.prisma:107 | `Session.refreshTokenHash` is a required + unique column absent from spec (contract addition for `/auth/refresh`). | Add required/unique `refreshTokenHash VarChar(64)` to spec Session. |
| F11 | Medium | mismatch | prisma/schema.prisma:241 | `Token.name` widened `VarChar(255)` → `Text`. | Update spec Token.name to Text. |
| F12 | Medium | mismatch | prisma/schema.prisma:242 | `Token.symbol` widened `VarChar(20)` → `VarChar(255)` (@unique preserved). | Update spec Token.symbol length to 255. |
| F13 | Medium | extra | prisma/schema.prisma:458,462,482,486 | Native/Erc20 detail tables add required `usdValue` + nullable `priceAtTime` not in spec (required = write-shape addition). | Add `usdValue` (required) + `priceAtTime` (nullable) to both detail models. |
| F14 | Medium | mismatch | prisma/schema.prisma:474,476,477 | Erc20 detail `symbol`/`tokenSymbol` 20→255, `tokenName` 255→Text vs spec. | Update the three column types in spec Erc20TransactionDetail. |
| F15 | Medium | mismatch | prisma/schema.prisma:451 | `NativeTransactionDetail.symbol` widened `VarChar(20)` → `VarChar(255)`. | Update spec to 255. |
| F16 | Medium | extra | src/index.ts:44-52,80-213 | Price ingestion uses 8 exchanges + resolver (Coinbase deprioritized behind Binance), not the single Coinbase WS the spec names; `/health` + `/ws/health` only probe Coinbase. | Document multi-exchange resolver in spec; reconsider health-check scope. |
| F17 | Medium | mismatch | src/modules/tokens/sync/sync.ts:5,9-13 | Token metadata + manual refresh sourced from CoinMarketCap (+CoinGecko history); spec names Moralis as primary (no Moralis metadata provider exists). | Update spec to name CMC/CoinGecko, or build the Moralis primary path. |
| F18 | Medium | extra | src/modules/wallet-data/index.ts:41-52 | Connected-wallet data comes from a 6-provider REST read layer (Moralis/Zerion/Mobula/GoldRush/Alchemy/Ankr) at connect/resync, not "real-time via Moralis" webhooks only. | Document the provider abstraction + priority/fallback + connect-time REST import. |
| F19 | Medium | mismatch | src/modules/portfolios/derive.ts:36-40 | PnL/value Redis cache TTL hardcoded to 60s; spec mandates 5 minutes in 5 places. | Update spec to 60s, or restore 300s. |
| F20 | Medium | contradiction | src/modules/prices/prices.service.ts:1-5,79-101 | `POST /prices/refresh` calls CMC first on every request; spec describes Redis-first, source-on-miss flow. | Read `price:<SYM>` from Redis first; CMC only on TTL miss, or update spec. |
| F21 | Medium | extra | src/app.ts:44-65 | Large set of routes (overview module, avatar, preferences, password-reset, bulk import, transfer, resync, wallet preview, sync-more, validate-symbols, token history, prices history/debug, NFT PATCH) absent from architecture.txt; NFT PATCH contradicts "read-only" rule. | Document each endpoint (path/verb/auth/plan-gate/shape) in architecture.txt; flag NFT PATCH as intentional. |
| F22 | Medium | missing | src/modules/transactions/transactions.controller.ts:146-182 | Documented `?from=<date>` (and `?to=`) transaction date filter neither honored nor 400-rejected (spec requires 400 on invalid filters). | Implement `from`/`to` date filter, or drop the spec example. |
| F23 | Medium | missing | frontend payments/+page.svelte:29-80 | `POST /subscriptions/downgrade` declared but never called from FE; no UI for pro→free or yearly→monthly downgrade despite documented Payments-page action. | Add a downgrade action calling the endpoint, with period-end copy. |
| F24 | Low | extra | prisma/schema.prisma:283-295 | Extra model `TokenPriceSnapshot` (retrofit-21) not in spec. | Document the table in docs/schema.txt. |
| F25 | Low | extra | prisma/schema.prisma:405,410 | `Transaction.notes` + `transferGroupId` (nullable) not in spec. | Add both to spec Transaction. |
| F26 | Low | extra | prisma/schema.prisma:132-135 | `Subscription.scheduledPlanId`/`scheduledBillingCycleId` (nullable FKs) + back-relations not in spec. | Add scheduled-downgrade fields + back-relations to spec. |
| F27 | Low | mismatch | prisma/schema.prisma:185-186 | Spec writes `user User` (non-optional) with `userId Int?` — invalid Prisma; impl correctly uses `User?`. | Fix spec to `User?` (no behavior change). |
| F28 | Low | extra | prisma/schema.prisma:55-57 | User adds `priceAlertsEnabled`, `pushEnabled`, `baseCurrency` (defaulted) not in spec. | Add the three preference columns to spec User. |
| F29 | Low | extra | prisma/schema.prisma:250,255,260,266,273 | Token adds `change24h`, `contractAddress`(+index), `autoListed`, `priceConfidence` not in spec. | Add the four columns + index to spec Token. |
| F30 | Low | extra | prisma/schema.prisma:314,321-322 | Portfolio adds `moralisStreamId`, `syncCursor`, `externalTxCount` (nullable) not in spec. | Add the three connected-wallet columns to spec Portfolio. |
| F31 | Low | extra | prisma/schema.prisma:364-370 | Asset adds 6 avg-cost/opening-position columns (retrofit-27) not in spec. | Add the columns to spec Asset. |
| F32 | Low | mismatch | prisma/schema.prisma:514 | `Nft.logoUrl` widened `VarChar(2048)` → `Text` (base64 SVG overflow). | Update spec Nft.logoUrl to Text. |
| F33 | Low | extra | prisma/schema.prisma:510,520-526,530,536,541 | Nft adds `description`, 7 marketplace fields, 3 spam flags not in spec. | Add the 11 fields to spec Nft. |
| F34 | Low | extra | prisma/schema.prisma:576 | `BalanceSnapshot.approx` provenance flag (defaulted) not in spec. | Add `approxідBoolean` to spec BalanceSnapshot. |
| F35 | Low | mismatch | src/modules/auth/auth.controller.ts:230,247 | (Duplicate of F6 from a second pass) GET redirect flow vs spec POST; callback undocumented. | See F6. |
| F36 | Low | missing | src/app.ts:44-62 | Admin surface (view all users / platform analytics / RBAC role) entirely absent; no role field. | Implement admin endpoints/RBAC or mark out-of-scope in spec. |
| F37 | Low | missing | src/modules/email/email.service.ts:15-68 | Email send is fire-and-forget — no retry/backoff/queue, no persisted delivery log (spec requires both). | Add retry/outbox + persist delivery attempts, or relax spec. |
| F38 | Low | mismatch | src/modules/prices/prices.controller.ts:12,47-55 | Manual `/prices/refresh` rate limit is 30s; spec/marketing say 5-minute cadence. | Tighten to 5 min, or update spec/UI to 30s. |
| F39 | Low | mismatch | src/lib/coinbase.ts:8-24,99-101,228-236 | Resilience uses heartbeats-channel + 10s liveness watchdog, not spec's 30s ping / 5s pong. | Update spec resilience wording to the watchdog model. |
| F40 | Low | extra | src/app.ts:47-61 | (Backend-pass duplicate-ish of F21) many undocumented routes vs spec entity URL lists. | Add endpoints to spec API definition. |
| F41 | Low | mismatch | src/modules/webhooks/moralis-handlers.ts:244-271 | Connected-tx `direction` (buy/sell) is persisted; spec says "inferred, not stored". | Clarify spec: direction IS persisted; "never stored" refers to display strings. |
| F42 | Low | extra | src/modules/overview/overview.controller.ts:41-79 | `GET /overview` aggregate added despite Build Guide Stage 7 forbidding a separate dashboard-aggregate endpoint. | Document `/overview` as canonical aggregate, or fold into `GET /portfolios`. |
| F43 | Low | mismatch | src/modules/nfts/nfts.service.ts:27-31 | NFT endpoint returns empty 200 for manual portfolios instead of spec'd 403 (connected-only). | Return 403, or document the empty-list behavior. |
| F44 | Low | mismatch | src/lib/config.ts:124-128 | `COINMARKETCAP_API_KEY` required at boot (`z.string().min(1)`) though docs mark CMC "under evaluation"/optional. | Record CMC adoption (close Appendix item 2), or make key optional with Moralis fallback. |
| F45 | Low | mismatch | src/modules/auth/auth.controller.ts:312-317 | `/auth/ws-token` hardcodes `expiresIn:60` separately from the Redis EX TTL (drift risk if TTL changes). | Derive `expiresIn` from the same constant as the EX. |
| F46 | Low | mismatch | src/ws/server.ts:263-284 | WS reconnect payload is unvalidated passthrough (`payload: evt.payload`), not the documented `{retryAfterMs, reason}`. | Validate/normalize to the documented shape, or document passthrough. |
| F47 | Low | extra | src/modules/portfolios/portfolios.controller.ts:32-39 | Error envelope adds non-standard `error.details`, top-level `meta`, and `data` block on errors vs fixed `{error:{code,message}}`. | Document the extensions in §3, or relocate the extra fields. |
| F48 | Low | mismatch | frontend (public)/+page.svelte:418 | Pro token-count copy says "100+"; spec says "250+"; free copy "Up to 5 assets" vs spec "10". | Align all plan-feature copy to spec numbers. |
| F49 | Low | mismatch | frontend modals/LimitReachedModal.svelte:37-54 | Plan-gate modals advertise 15 Pro portfolios; spec + server limit is 10. | Change 15→10 in LimitReachedModal + FeatureGateModal. |
| F50 | Low | extra | frontend modals/FeatureGateModal.svelte:92-96 | Upsell modals promise a 7-day free trial that the billing model does not implement. | Implement trial (+document), or remove trial copy. |
| F51 | Low | mismatch | frontend register/+page.svelte:78-81 | FE does GET full-page redirect to `/auth/google` vs documented POST token flow. | Reconcile with backend (F6); document the chosen flow. |
| F52 | Low | mismatch | frontend verify-email/+page.ts:12-27 | Email-verify link targets a FE route that POSTs `/auth/verify-email`, not a direct backend-link hit as spec describes. | Update spec wording, or point link at a direct backend endpoint. |
| F53 | Low | mismatch | frontend dashboard/+page.ts:153-310; performance/+page.ts:131 | Dashboard/Performance consume `/overview` aggregate instead of documented per-page `/portfolios`+`/analytics/*`+`/snapshots`; performance never calls `/analytics/*/{performance,holdings}`. | Document `/overview` in page definitions; note dropped analytics calls. |
| F54 | Low | contradiction | frontend dashboard/+page.svelte:325-329 | Free refresh cooldown is 60s client / ~30s server, but UI + spec advertise 5 minutes. | Reconcile cadence across code, spec, and all copy. |
| F55 | Low | missing | frontend ConnectionBanner.svelte:8-13 | Only the lost/reconnecting state is surfaced; no "connection restored" indicator (spec requires both). | Add a transient "Live prices restored" toast on reconnect. |
| F56 | Low | extra | frontend hooks.server.ts:24-28; (dashboard)/+layout.ts:28-37 | `VITE_MOCK_AUTH` dev bypass still shipped (disables auth/plan gating if it leaks to prod). | Remove the bypass or hard-guard behind `import.meta.env.DEV`. |
| F57 | Low | missing | frontend wallet/[portfolioSlug]/[tokenSlug]/+page.ts:78-124 | Token-detail analytics route has no client-side Pro gate (fetches `/tokens/{id}/history` for any user) unlike the Performance page. | Add a plan check mirroring the Performance page's gated preview. |
| F58 | Info | mismatch | prisma/schema.prisma:583-586 | Hypertable note: spec SQL uses `'snapshot_date'` but real column is `snapshotDate` (no @map) → literal SQL would fail. | Fix spec SQL string + confirm 001 migration uses `snapshotDate`. |
| F59 | Info | extra | prisma/schema.prisma:152,163 | Plan + BillingCycle gain `scheduledSubscriptions` back-relations not in spec (consequence of F26). | Include the back-relations when adding scheduled fields to spec. |
| F60 | Info | extra | prisma/schema.prisma:71-72,110,140-144,207-209,273,293,333-336,376,423-426,581 | Many `@@index` on FK scalars beyond spec (allowed per Build Guide, but spec declares no indexes). | Optionally note in spec that FK/lookup indexes are added per System Architecture. |
| F61 | Info | mismatch | src/index.ts:216-219 | Stale shutdown comment references `subs:<SYMBOL>` Redis sets removed by the firehose redesign. | Update comment to the `psubscribe price:*` firehose model. |
| F62 | Info | mismatch | src/ws/server.ts:112-145 | Bad-ticket WS upgrade returns HTTP 401/403 (no socket), so close code 4001 is never sent; only 4003 is a real close code. | Optionally clarify spec; no code change. |
| F63 | Info | extra | src/modules/subscriptions/subscriptions.controller.ts:171-192 | Positive confirmation: all 6 subscription endpoints match spec; nuance — verify POST `/subscriptions` doesn't flip Pro synchronously (service-level audit). | No route change; confirm sync-vs-deferred Pro activation in a service audit. |
| F64 | Info | extra | src/app.ts:46 | `/health` + `/ws/health` match spec, but `GET /api/v1/_ping` is an undocumented debug route ("delete in Stage 2"). | Remove `/_ping` or document it. |
| F65 | Info | extra | frontend settings/+page.ts:14-19 | Settings reads `priceAlertsEnabled`/`pushEnabled`/`baseCurrency` + PATCHes undocumented `/users/preferences`. | Document the preferences + endpoint, or remove if out of scope. |
| F66 | Info | extra | frontend endpoints.ts:18-22 | Avatar upload/delete + account-deletion endpoints not in documented Users URL surface. | Add `DELETE /users/me`, `POST/DELETE /users/me/avatar` to spec. |
| F67 | Info | extra | frontend onboarding/+page.svelte:120-139 | Dead `CHAINS` + `ALL_TOKENS` mock arrays with hardcoded prices remain (unreferenced). | Delete the unused mock arrays + `Token` interface. |

> **Note on merges:** F1 consolidates three identical findings about the `price_update` array payload (one backend-side, one with the §2.7 "prior bug" warning, one frontend-side at `src/lib/ws.ts`). F2 consolidates two identical findings about the dropped `subscribe` handshake / missing `symbol→[socketIds]` registry. F35 and F40 are near-duplicate restatements of F6 and F21 respectively from a second audit pass and are retained as distinct rows only because they cite additional evidence lines; they are not independent defects.

---

### F1 — `price_update` payload shape diverges from spec (`prices[]` array vs flat `{symbol, price, change24h}`)

**What it is.** The authoritative WebSocket contract — defined identically in `architecture.txt:726-736` and `Build Guide §2.7` — specifies the server→client price message as:

```json
{ "type": "price_update", "payload": { "symbol": "BTC", "price": 93061.53, "change24h": 1.88 }, "timestamp": "..." }
```

The Build Guide goes further and explicitly names the opposite shape as a regression: *"A flat `{ type, symbol, price }` will silently no-op the frontend (it reads `msg.payload.symbol`). This exact shape was a prior bug; do not reintroduce it."* The implementation instead emits the price fields one level deeper, inside a single-element array:

```js
// src/ws/server.ts:195
msg = JSON.stringify({
  type: 'price_update',
  payload: { prices: [{ symbol, price: data.price, change24h }] },
  timestamp: new Date().toISOString(),
});
```

**Why it matters.** Any consumer written to the *documented* contract reads `msg.payload.symbol` / `msg.payload.price` and receives `undefined` — a silent no-op exactly as the Build Guide warned. The saving grace is that the frontend (`src/lib/ws.ts:79-81`) was updated in lockstep to read the batch array:

```js
const batch = (msg.payload as { prices?: Array<{ symbol: string; price: number; change24h?: number }> }).prices;
```

So FE and BE agree with each other, and live prices flow. But both now contradict every authoritative doc, and per the source-of-truth hierarchy the frontend (rank 4) does *not* override System Architecture (rank 2). This is precisely the silent-divergence class the guide exists to prevent: the next engineer who trusts the spec and writes a new client (or a test) against `payload.symbol` will ship a broken consumer.

**Fix.** Reconcile the spec to the running contract (preferred, since the firehose is the intended retrofit-28 design). In `architecture.txt` WebSocket section and `Build Guide §2.7`, replace the flat envelope with the batch shape and delete the "do not reintroduce the flat shape" warning (it now describes the *old* contract). Concretely the documented envelope should become:

```json
{ "type": "price_update", "payload": { "prices": [ { "symbol": "BTC", "price": 93061.53, "change24h": 1.88 } ] }, "timestamp": "..." }
```

Alternatively, if per-symbol fan-out is to be restored, revert `server.ts:195` to `payload: { symbol, price: data.price, change24h }` and update `ws.ts` to read `payload.symbol` — but that only makes sense together with F2 (restoring the registry).

---

### F2 — WS server is a global broadcast firehose with no per-token subscription registry or `subscribe` protocol

**What it is.** The architecture mandates selective, registry-driven fan-out and a client→server registration handshake (`architecture.txt:700-714, 1174-1175`; `Build Guide §2.7`, Stage 10):

- *"Price updates are fanned out via Redis pub/sub to only the clients subscribed to that token. Token subscription registry is maintained in Redis as a map of symbol → [socketIds]."*
- Client registration message: `{ "type": "subscribe", "payload": { "symbols": ["BTC","ETH","BNB"] } }`, re-sent on reconnect.
- Stage 10 reference-counts upstream Coinbase subscriptions via `subs:<symbol>` sets, subscribing on the first watcher and unsubscribing on the last (*"Omitting the unsubscribe … a slow resource leak"*).

The implementation discards all of it. Inbound frames are drained and ignored, and every tick goes to every open socket:

```js
// src/ws/server.ts:160
ws.on('message', () => { /* ignore — broadcast firehose has no client→server protocol */ });

// src/ws/server.ts:199-203
for (const ws of wsBySocketId.values()) {
  if (ws.readyState === WebSocket.OPEN) { ws.send(msg); }
}
```

`src/ws/registry.ts` keeps only `socketsByUser` and `wsBySocketId` — there is no `symbol → [socketIds]` map and no upstream reference counting.

**Why it matters.** Three documented guarantees are broken: (1) clients receive *all* symbols, not just subscribed ones — wasted bandwidth and a contract violation for any client that filters server-side trust; (2) a client that re-sends `subscribe` on reconnect (which the spec instructs the frontend to do) gets a silent no-op; (3) the "register socket against each token in their portfolios" model simply does not exist, so any future feature relying on per-symbol targeting (e.g. price-alert routing) has no substrate. As with F1, the frontend was already updated to stop sending `subscribe` (`ws.ts:65`), so the two sides match — but the architecture doc describes a protocol the server does not honor, inviting "restore the registry" churn.

**Fix.** This is a deliberate product decision (retrofit-28), so update the docs rather than the code. In `architecture.txt` WebSocket/Price-Module sections and `Build Guide §2.7`/Stage 10:
- Replace the "symbol → [socketIds] registry" and `subscribe`-handshake descriptions with the firehose model: a single `psubscribe price:*`, no client→server protocol, broadcast to all authenticated Pro sockets.
- Remove the `subs:<symbol>` reference-counting pseudocode (and see F61 for the matching stale code comment).
- Note that upstream exchange subscriptions are catalog-wide (not per-connected-client), which is consistent with the multi-exchange resolver in F16.

If instead horizontal scaling and bandwidth efficiency justify the original design, re-implement `ws.on('message')` to parse `{type:'subscribe', payload:{symbols}}`, add a Redis `symbol→[socketIds]` map, and gate `broadcastPrice` to only the sockets registered for `data.symbol` — but this is a larger effort and should be weighed against the firehose's simplicity for the single-instance MVP.

---

### F3 — `Transaction.transactionHash` uniqueness scope reversed (global `@unique` → per-portfolio composite)

**What it is.** The spec declares a **global** unique constraint on the on-chain hash (`docs/schema.txt:229`):

```prisma
transactionHash String? @unique @db.VarChar(255)
```

The implementation removed the field-level `@unique` and replaced it with a composite, per-portfolio constraint:

```prisma
// schema.prisma:400 (field) + :422 (constraint)
transactionHash String? @db.VarChar(255)
@@unique([portfolioId, transactionHash])
```

**Why it matters.** This is a direct reversal of a documented data-integrity contract. Under the spec, a given on-chain hash can exist **at most once in the entire database**. Under the implementation, the same hash may exist **once per portfolio**. The impl behavior is deliberate and correct (retrofit-74): the same wallet can be added to multiple portfolios, or two users can track the same shared wallet, and each legitimately needs its own row for that transaction. A global `@unique` would cause the second import of a shared/re-added wallet to throw a unique-constraint violation. The danger is purely documentary: a reviewer trusting the spec would assume hash dedup is global and might, e.g., write a cross-portfolio "find transaction by hash" expecting a single row.

**Fix.** Update `docs/schema.txt:229` to drop the field-level `@unique` and add the composite key, matching the deployed index:

```prisma
model Transaction {
  // ...
  transactionHash String? @db.VarChar(255)
  // ...
  @@unique([portfolioId, transactionHash])
}
```

Add a one-line rationale ("per-portfolio so a shared/re-added wallet imports cleanly in each portfolio") so the constraint is not "corrected" back to global in a future pass.

---

### F4 — `Payment.subscriptionId` nullability and delete behavior reversed (required + Restrict → optional + SetNull)

**What it is.** The spec declares the relation required with default (Restrict) delete behavior (`docs/schema.txt:115-116`):

```prisma
subscription   Subscription @relation(fields: [subscriptionId], references: [id])
subscriptionId Int
```

The implementation makes it nullable with `SetNull`:

```prisma
// schema.prisma:197-198
subscription   Subscription? @relation(fields: [subscriptionId], references: [id], onDelete: SetNull)
subscriptionId Int?
```

**Why it matters.** Both the *nullability* and the *delete semantics* are inverted. Under the spec, a `Subscription` referenced by any `Payment` cannot be deleted (Restrict) — the FK is mandatory. Under the implementation, deleting a `Subscription` succeeds and nulls the FK on its payments. This was a required change for account deletion (retrofit-5): when a user is deleted, their subscriptions are removed, but the `Payment` rows must survive (for financial/audit history) with a now-null `subscriptionId`. A spec-conformant Restrict would block account deletion entirely. The impl is correct; the spec describes a constraint that would break a shipped feature.

**Fix.** Update the spec `Payment` model to match, and add a note tying it to account deletion:

```prisma
model Payment {
  // ...
  subscription   Subscription? @relation(fields: [subscriptionId], references: [id], onDelete: SetNull) // nullable + SetNull so account deletion can remove subscriptions while preserving payment history
  subscriptionId Int?
}
```

Note this pairs with F27 (the spec's `Payment.user` is written non-optional alongside `userId Int?`, which is itself invalid Prisma) — both should be fixed together so the spec's `Payment` model is valid and matches the deployed schema.

---

### F5 — `BalanceSnapshot` primary key changed from `id` to composite `(portfolioId, snapshotDate)`

**What it is.** The spec uses a surrogate `id` PK plus a unique business key (`docs/schema.txt:310,320`):

```prisma
id Int @id @default(autoincrement())
// ...
@@unique([portfolioId, snapshotDate])
```

The implementation drops the `@id` (so `id` becomes a plain non-PK autoincrement column) and promotes the business key to the primary key (the `@@unique` is subsumed):

```prisma
// schema.prisma:563,580
id Int @default(autoincrement())   // no @id
// ...
@@id([portfolioId, snapshotDate])
```

**Why it matters.** This alters the table's primary key — a fundamental schema contract. It is required by TimescaleDB (TS103: a hypertable's partitioning column must be part of every unique/primary index), and `balance_snapshot` is a hypertable partitioned on `snapshotDate`. With the spec's surrogate `id` PK, `create_hypertable` would fail because `id` alone does not include the partition column. The impl resolution (Option C) is correct and necessary. The risk is that a reviewer applying the spec verbatim would generate a schema whose hypertable creation fails — and would not understand why, since the spec's `@@unique` *looks* sufficient but a unique constraint is not a primary key.

**Fix.** Update `docs/schema.txt` to the composite PK and document the TimescaleDB rationale:

```prisma
model BalanceSnapshot {
  id           Int      @default(autoincrement())   // non-PK surrogate; kept for ordering/FKs
  // ...
  @@id([portfolioId, snapshotDate])                  // composite PK — TimescaleDB requires the partition column (snapshotDate) in the PK (TS103)
}
```

This also relates to F58: the hypertable example SQL must reference the real camelCase column `snapshotDate`, not `snapshot_date`, since there is no `@map` to produce snake_case.

---

### F6 — `POST /auth/google` documented but implemented as `GET /auth/google` (verb mismatch + split into two routes)

**What it is.** The OAuth endpoint is documented as `POST /auth/google` in at least three authoritative places — USER entity URLs (`architecture.txt:235`), the SESSION note (*"Sessions are created server-side on successful login (POST /auth/login) or Google OAuth (POST /auth/google)"*, `architecture.txt:274`), and the onboarding-state convention (`architecture.txt:395`) — plus `Build Guide` Stage 1 and frontend page defs (`implementation.txt:386,413`). The implementation instead exposes a server-redirect OAuth 2.0 flow over GET, with no POST route at all:

```js
// src/modules/auth/auth.controller.ts:230
router.get('/google', async (c) => { /* redirect to Google consent */ });
// :247
router.get('/google/callback', async (c) => { /* exchange code, create session */ });
```

The `/google/callback` route is entirely undocumented.

**Why it matters.** This is a documented HTTP contract — verb *and* path — that the code contradicts. Any frontend, test, or third-party integration calling `POST /api/v1/auth/google` (the documented shape) receives a 404/405. The frontend itself already diverged to match the GET redirect (`register/+page.svelte:80`, see F51), so FE and BE agree, but the spec, Build Guide, and `implementation.txt` all still promise the POST token-exchange flow. The redirect-based flow is arguably the better design (the Google token never transits the SPA), so the right move is to fix the docs, not the code — but it must be reconciled, because the divergence currently spans four documents.

**Fix.** Choose the redirect flow as canonical (recommended) and update the spec everywhere it names the endpoint:
- `architecture.txt:235` USER entity URLs: change `POST /auth/google` to `GET /auth/google` and add `GET /auth/google/callback`.
- `architecture.txt:274` SESSION note and `:395` onboarding note: reword "Google OAuth (POST /auth/google)" to describe the redirect entry + callback that creates the session.
- `Build Guide` Stage 1 and `implementation.txt:386,413`: update the Google sign-in dependency from a POST-token call to a GET redirect to `/auth/google` (the frontend already does `window.location.href = ${VITE_API_URL}/auth/google`).

If the documented POST flow must stand instead, add a `router.post('/google', ...)` that accepts a Google ID token, validates it server-side, and issues a session — but then the frontend (F51) must also be reverted to obtain and POST the token, so the redirect routes can be removed. Resolving in the docs is the lower-risk path since the running system already works end-to-end.

---

## Appendix A — Methodology & Coverage

The audit was run as a deterministic multi-agent workflow (`neonfi-deep-audit`). Coverage:

- **Recon (1 agent):** full backend HTTP + WebSocket route inventory (see Appendix B).
- **Quality (18 agents):** 10 backend clusters + 6 frontend clusters, each reading every file in its cluster in full, plus 2 cross-cutting sweeps (backend duplication/dead-code; frontend duplication/dead-code/hardcoded-style).
- **Performance (6 agents):** backend DB efficiency, Redis/caching, external-API fan-out, hot-path compute/WS, frontend rendering/reactivity, frontend network/data-loading.
- **Security (8 agents):** authN/authZ & IDOR, input-validation/injection, secrets/leakage, webhook signatures, SSRF/upload, rate-limit/brute-force/enumeration, frontend security, payments/financial integrity.
- **Docs (5 agents):** schema, architecture, implementation/build-guide, API contract, and frontend — each comparing the canonical specs in `Neonfi/docs/` (`schema.txt`, `architecture.txt`, `implementation.txt`, `Neonfi_Backend_Build_Guide.md`) against the actual code.
- **Synthesis (5 agents):** one per dimension, writing the sections above from the structured findings.

Every finding is backed by a structured record (severity, category, exact `file:line`, code evidence, recommendation, confidence). Each per-dimension section opens with its own severity tally and a complete table of **every** finding in that dimension (not just the high-severity ones shown in the executive summary), followed by detailed write-ups for the Critical/High items.

**Security severity breakdown:**

| Severity | Security findings |
|---|---|
| Critical | 1 |
| High | 3 |
| Medium | 11 |
| Low | 25 |
| Info | 11 |

## Appendix B — Backend API & WebSocket Inventory

Captured by the recon agent (used to ground the security and docs-divergence passes):

```text
I have the complete inventory. All routes are confirmed. Note the `prices/refresh` and `prices/history` and `prices/debug` are auth but no `requirePlan` — refresh has an inline free-only plan check (returns 403 for pro). The `transactions/sync-more` is the only nested route with `requirePlan(['pro'])` inline. NFTs, snapshots, analytics are pro-gated via `requirePlan(['pro'])` in `.use('*')`.

Here is the complete inventory.

GET /health | auth:public | plan:none | handler:app.ts:createApp (inline)
GET /api/v1/_ping | auth:public | plan:none | handler:app.ts:createApp (inline)
GET /ws/health | auth:public | plan:none | handler:ws/health.ts:wsHealthHandler

POST /api/v1/auth/register | auth:public | plan:none | handler:auth.controller.ts:POST /register
POST /api/v1/auth/login | auth:public | plan:none | handler:auth.controller.ts:POST /login
POST /api/v1/auth/logout | auth:public | plan:none | handler:auth.controller.ts:POST /logout (reads session cookie, idempotent)
POST /api/v1/auth/verify-email | auth:public | plan:none | handler:auth.controller.ts:POST /verify-email
POST /api/v1/auth/resend-verification | auth:public | plan:none | handler:auth.controller.ts:POST /resend-verification
POST /api/v1/auth/password-reset | auth:public | plan:none | handler:auth.controller.ts:POST /password-reset
POST /api/v1/auth/password-reset/confirm | auth:public | plan:none | handler:auth.controller.ts:POST /password-reset/confirm
POST /api/v1/auth/refresh | auth:public | plan:none | handler:auth.controller.ts:POST /refresh (reads refresh cookie)
GET /api/v1/auth/google | auth:public | plan:none | handler:auth.controller.ts:GET /google
GET /api/v1/auth/google/callback | auth:public | plan:none | handler:auth.controller.ts:GET /google/callback
GET /api/v1/auth/sessions | auth:requireAuth | plan:none | handler:auth.controller.ts:GET /sessions
DELETE /api/v1/auth/sessions/:id | auth:requireAuth | plan:none | handler:auth.controller.ts:DELETE /sessions/:id
GET /api/v1/auth/ws-token | auth:requireAuth | plan:none | handler:auth.controller.ts:GET /ws-token

GET /api/v1/users/me | auth:requireAuth | plan:none | handler:users.controller.ts:GET /me
PATCH /api/v1/users/me | auth:requireAuth | plan:none | handler:users.controller.ts:PATCH /me
DELETE /api/v1/users/me | auth:requireAuth | plan:none | handler:users.controller.ts:DELETE /me
POST /api/v1/users/me/avatar | auth:requireAuth | plan:none | handler:users.controller.ts:POST /me/avatar (multipart, 503 if R2 unconfigured)
DELETE /api/v1/users/me/avatar | auth:requireAuth | plan:none | handler:users.controller.ts:DELETE /me/avatar
PATCH /api/v1/users/preferences | auth:requireAuth | plan:none | handler:users.controller.ts:PATCH /preferences

POST /api/v1/subscriptions | auth:requireAuth | plan:none | handler:subscriptions.controller.ts:POST '' (activateSubscription)
GET /api/v1/subscriptions/me | auth:requireAuth | plan:none | handler:subscriptions.controller.ts:GET /me
POST /api/v1/subscriptions/upgrade | auth:requireAuth | plan:none | handler:subscriptions.controller.ts:POST /upgrade
POST /api/v1/subscriptions/downgrade | auth:requireAuth | plan:none | handler:subscriptions.controller.ts:POST /downgrade
POST /api/v1/subscriptions/cancel | auth:requireAuth | plan:none | handler:subscriptions.controller.ts:POST /cancel
POST /api/v1/subscriptions/refund | auth:requireAuth | plan:none | handler:subscriptions.controller.ts:POST /refund

POST /api/v1/webhooks/stripe | auth:public | plan:none | handler:webhooks.controller.ts:POST /stripe (signature-verified via stripe-signature header)
POST /api/v1/webhooks/moralis | auth:public | plan:none | handler:webhooks.controller.ts:POST /moralis → moralis-handlers.ts:handleMoralisWebhook (Keccak sig-verified)

GET /api/v1/payments | auth:requireAuth | plan:none | handler:payments.controller.ts:GET ''
GET /api/v1/payments/:id | auth:requireAuth | plan:none | handler:payments.controller.ts:GET /:id

GET /api/v1/chains | auth:requireAuth | plan:none | handler:chains.controller.ts:GET ''

POST /api/v1/tokens/validate-symbols | auth:requireAuth | plan:none | handler:tokens.controller.ts:POST /validate-symbols
GET /api/v1/tokens | auth:requireAuth | plan:none | handler:tokens.controller.ts:GET '' (plan-filtered list internally, no requirePlan)
GET /api/v1/tokens/:id/history | auth:requireAuth | plan:none | handler:tokens.controller.ts:GET /:id/history
GET /api/v1/tokens/:id | auth:requireAuth | plan:none | handler:tokens.controller.ts:GET /:id

POST /api/v1/portfolios | auth:requireAuth | plan:none | handler:portfolios.controller.ts:POST ''
POST /api/v1/portfolios/wallet/preview | auth:requireAuth | plan:none | handler:portfolios.controller.ts:POST /wallet/preview
GET /api/v1/portfolios | auth:requireAuth | plan:none | handler:portfolios.controller.ts:GET ''
GET /api/v1/portfolios/:id | auth:requireAuth | plan:none | handler:portfolios.controller.ts:GET /:id
PATCH /api/v1/portfolios/:id | auth:requireAuth | plan:none | handler:portfolios.controller.ts:PATCH /:id
POST /api/v1/portfolios/:id/resync | auth:requireAuth | plan:none | handler:portfolios.controller.ts:POST /:id/resync (connected-only; 429 cooldown free 24h/pro 5min in service)
DELETE /api/v1/portfolios/:id | auth:requireAuth | plan:none | handler:portfolios.controller.ts:DELETE /:id

(assets router mounted at /api/v1/portfolios/:portfolioId/assets; requireAuth + ownership via router.use('*'))
POST /api/v1/portfolios/:portfolioId/assets | auth:requireAuth | plan:none | handler:assets.controller.ts:POST ''
POST /api/v1/portfolios/:portfolioId/assets/bulk | auth:requireAuth | plan:none | handler:assets.controller.ts:POST /bulk
GET /api/v1/portfolios/:portfolioId/assets | auth:requireAuth | plan:none | handler:assets.controller.ts:GET ''
GET /api/v1/portfolios/:portfolioId/assets/:id | auth:requireAuth | plan:none | handler:assets.controller.ts:GET /:id
PATCH /api/v1/portfolios/:portfolioId/assets/:id | auth:requireAuth | plan:none | handler:assets.controller.ts:PATCH /:id
DELETE /api/v1/portfolios/:portfolioId/assets/:id | auth:requireAuth | plan:none | handler:assets.controller.ts:DELETE /:id

(transactions router mounted at /api/v1/portfolios/:portfolioId/transactions; requireAuth + ownership via router.use('*'))
POST /api/v1/portfolios/:portfolioId/transactions | auth:requireAuth | plan:none | handler:transactions.controller.ts:POST ''
POST /api/v1/portfolios/:portfolioId/transactions/bulk | auth:requireAuth | plan:none | handler:transactions.controller.ts:POST /bulk
POST /api/v1/portfolios/:portfolioId/transactions/transfer | auth:requireAuth | plan:none | handler:transactions.controller.ts:POST /transfer (cross-portfolio)
GET /api/v1/portfolios/:portfolioId/transactions | auth:requireAuth | plan:none | handler:transactions.controller.ts:GET ''
GET /api/v1/portfolios/:portfolioId/transactions/sync-more | auth:requireAuth | plan:pro | handler:transactions.controller.ts:GET /sync-more (requirePlan(['pro']) inline)
GET /api/v1/portfolios/:portfolioId/transactions/:id | auth:requireAuth | plan:none | handler:transactions.controller.ts:GET /:id
PATCH /api/v1/portfolios/:portfolioId/transactions/:id | auth:requireAuth | plan:none | handler:transactions.controller.ts:PATCH /:id
DELETE /api/v1/portfolios/:portfolioId/transactions/:id | auth:requireAuth | plan:none | handler:transactions.controller.ts:DELETE /:id

(nfts router mounted at /api/v1/portfolios/:portfolioId/nfts; requireAuth + requirePlan(['pro']) + ownership via router.use('*'))
GET /api/v1/portfolios/:portfolioId/nfts | auth:requireAuth | plan:pro | handler:nfts.controller.ts:GET '' (?includeSpam=true)
GET /api/v1/portfolios/:portfolioId/nfts/:id | auth:requireAuth | plan:pro | handler:nfts.controller.ts:GET /:id
PATCH /api/v1/portfolios/:portfolioId/nfts/:id | auth:requireAuth | plan:pro | handler:nfts.controller.ts:PATCH /:id (spamOverride)

(snapshots router mounted at /api/v1/portfolios/:portfolioId/snapshots; requireAuth + requirePlan(['pro']) + ownership via router.use('*'))
GET /api/v1/portfolios/:portfolioId/snapshots | auth:requireAuth | plan:pro | handler:snapshots.controller.ts:GET ''

POST /api/v1/prices/refresh | auth:requireAuth | plan:none* | handler:prices.controller.ts:POST /refresh (*inline FREE-ONLY gate: pro users get 403 PRO_USES_WEBSOCKET; 30s/user rate-limit → 429)
GET /api/v1/prices/history | auth:requireAuth | plan:none | handler:prices.controller.ts:GET /history (?symbols=&range=1H|1D|1W|1M|1Y|ALL)
GET /api/v1/prices/debug | auth:requireAuth | plan:none | handler:prices.controller.ts:GET /debug (?symbol=)

(analytics router mounted at /api/v1/analytics; requireAuth + requirePlan(['pro']) on '*', ownership on '/:portfolioId/*')
GET /api/v1/analytics/:portfolioId/summary | auth:requireAuth | plan:pro | handler:analytics.controller.ts:GET /:portfolioId/summary
GET /api/v1/analytics/:portfolioId/performance | auth:requireAuth | plan:pro | handler:analytics.controller.ts:GET /:portfolioId/performance
GET /api/v1/analytics/:portfolioId/holdings | auth:requireAuth | plan:pro | handler:analytics.controller.ts:GET /:portfolioId/holdings

(overview router mounted at /api/v1/overview; requireAuth on '*', plan-agnostic by design)
GET /api/v1/overview | auth:requireAuth | plan:none | handler:overview.controller.ts:GET '/' (?days=&txLimit=&portfolioIds=csv; all clamped, never 400)
GET /api/v1/overview/transactions | auth:requireAuth | plan:none | handler:overview.controller.ts:GET /transactions (?limit=)

Fallbacks (app.ts):
* 404 → app.notFound → err('NOT_FOUND') 404
* uncaught → app.onError → err('INTERNAL_ERROR') 500

WS:

Endpoint: GET wss://.../ws?token=<ticket> (HTTP upgrade handled in ws/server.ts:startWsServer; only req.url path '/ws' is upgraded, all other paths ignored).

Ticket-auth flow (single-use, Pro-only):
1. Client calls GET /api/v1/auth/ws-token (requireAuth, no plan check) → auth.controller.ts:GET /ws-token → auth.service.ts:issueWsTicket sets Redis `ws_ticket:<token>` = "<userId>:<sessionId>" with EX 60 (auth.service.ts:586). Response: { token, expiresIn: 60 }.
2. Client opens WS to /ws?token=<token>. ws/server.ts:authorizeUpgrade:
   - No token query param → HTTP 401 Unauthorized (no handshake).
   - redis.getdel('ws_ticket:'+token) atomically reads + deletes (single-use). Null (absent/expired/already-consumed) → HTTP 401.
   - Parses "userId:sessionId"; invalid/NaN → HTTP 401.
   - findSessionById(sessionId); if missing, revokedAt!==null, or expired → HTTP 401.
   - getEffectivePlan(userId); if 'free' → HTTP 403 Forbidden (Pro-only WS).
   - Success → handleUpgrade, emit 'connection' with AuthContext { userId, sessionId }.
   (Build Guide note in header: documented close code 4001 = consumed/invalid ticket, but at upgrade time this is realized as HTTP 401/403 since no socket exists yet; 4003 used post-connection on downgrade.)

Inbound (client → server) messages:
- NONE. Per retrofit-28 broadcast firehose, the server registers ws.on('message', () => {}) and ignores/drains all inbound frames — there is no client→server protocol (no subscribe/unsubscribe). server.ts:160-162.

Outbound (server → client) messages:
- type:"price_update" — payload { prices: [{ symbol, price, change24h }] }, timestamp ISO. One symbol per frame, broadcast to every open socket immediately on each Redis `price:*` pmessage (firehose; resolver change-dedupes upstream). server.ts:broadcastPrice (193-204). change24h defaults to 0 if missing/non-finite; non-finite price is dropped.
- type:"plan_downgraded" — payload { message:"Your Pro subscription has expired" }, timestamp ISO. Sent to all of a user's sockets when a Redis `user_events` message {type:"plan_changed", userId} resolves to plan 'free'; immediately followed by ws.close(4003, "Plan downgraded"). server.ts:handleUserEvent (235-261).
- type:"reconnect" — payload = passthrough of the `client_events` {type:"reconnect", payload} message, timestamp ISO. Broadcast to all open sockets (server-initiated reconnect signal). server.ts:handleClientEvent (263-284).

Server-side Redis pub/sub channels driving WS (server.ts:startRedisSubscriptions 210-233):
- subscribe 'user_events' → handleUserEvent (plan_changed → plan_downgraded + close 4003)
- subscribe 'client_events' → handleClientEvent (reconnect broadcast)
- psubscribe 'price:*' → broadcastPrice (price_update firehose)

Lifecycle: handleConnection assigns socketId=randomUUID(), registerSocket(socketId,userId,ws); on 'close' → unregisterSocket; on 'error' → log only. stopWsServer terminates all sockets, clears registry, best-effort (non-awaited) unsubscribe/punsubscribe + disconnect of the subscriber, then closes the WSS.

WS close codes observed: 4001 (documented for consumed/invalid ticket, realized as HTTP 401 at upgrade), 4003 (plan downgraded, used at runtime). HTTP-level upgrade rejections: 401 Unauthorized (missing/invalid/consumed ticket, bad session), 403 Forbidden (free plan).
```

## Appendix C — Notes on duplicate / clustered findings

- The **WebSocket-contract divergence** (firehose `payload.prices[]` batch + dropped `subscribe` handshake vs. the spec's per-symbol model) is reported as ~6 separate high-severity rows by the architecture, API-contract, implementation, and frontend doc-checkers. It is **one** reconciliation decision: either update `architecture.txt` + Build-Guide §2.7 to document the retrofit-28 firehose as the contract, or restore the documented handshake.
- The **`/overview` double-fetch** appears twice in the performance section (from the DB agent and the compute agent) — same root cause, one fix.
- The JWT algorithm-pinning and per-email lockout items appear at multiple severities across security sub-agents; the security section retains them as distinct rows but consolidates the write-ups.

_End of report._
