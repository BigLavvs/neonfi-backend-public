# retrofit-65 — Rate-limit resync (free: once/day, Pro: short cooldown) + retryAfter

The resync endpoint (`POST /portfolios/:id/resync`) has no rate-limit. Add a per-portfolio cooldown so
neither plan can hammer the external providers:

- **Free** → one resync per **24h** (free users also have only one portfolio, so this is "one resync a
  day" overall).
- **Pro** → a short **5-minute** cooldown per portfolio (reasonable anti-abuse, effectively unlimited for
  normal use — NOT truly unlimited anymore).

The 429 must carry a plan-specific human message AND `retryAfter` (seconds) so the frontend can show the
reason on hover and auto-unlock when a short cooldown elapses.

## Backend
`src/modules/portfolios/portfolios.service.ts`, `resyncPortfolio(userId, id)` (already imports
`getEffectivePlan`). Order matters: **ownership + connected checks first** (a manual portfolio must still
400 `NOT_CONNECTED` before any cooldown logic), THEN the cooldown:

- `const plan = await getEffectivePlan(userId)`.
- Key is **per portfolio**: `const key = ` + "`resync_cooldown:${id}`" + ` `. (Per-portfolio so a Pro user
  with several wallets gets independent cooldowns; free users have one portfolio so it's equivalent to
  per-user for them.)
- Check the cooldown:
  - `const ttl = await redis.ttl(key)` (wrap in try/catch — see fail-open below).
  - If `ttl > 0` → throw `PortfolioError(429, 'RESYNC_RATE_LIMITED', <message>, { retryAfter: ttl })` where
    `<message>` is:
    - free: `'Free plan allows one resync per day. Upgrade to Pro for unlimited resyncs.'`
    - pro: `'You can resync each wallet every 5 minutes — try again shortly.'`
- Else proceed, and **after** a successful `resyncConnectedHoldings`, set the key with the plan TTL:
  `await redis.set(key, '1', 'EX', plan === 'free' ? 86400 : 300)`.
- **Redis-down → fail-open**: a Redis error on the `ttl` read must not block the resync (log + proceed);
  a failure on the `set` is likewise non-fatal (the resync already succeeded).

### Error envelope MUST surface retryAfter
`PortfolioError`'s 4th arg is the details object. Confirm the JSON error response includes the value where
the frontend reads it — it accepts **either** `error.retryAfter` **or** `error.details.retryAfter`. Make
sure one of those is populated (e.g. spread `retryAfter` onto `error`, or nest it under `error.details`).
The controller (`portfolios.controller.ts` `/:id/resync`) already maps `PortfolioError.status` → HTTP
status, so the 429 + code flow through; just verify `retryAfter` rides along.

## Validate
- Free user: 1st resync 200; 2nd within 24h → 429 `RESYNC_RATE_LIMITED`, body has `retryAfter` ≈ 86400,
  message mentions "once per day"; no second sync runs.
- Pro user: 1st resync 200; immediate 2nd on the SAME portfolio → 429, `retryAfter` ≈ 300, message mentions
  "every 5 minutes"; a DIFFERENT portfolio still 200 (independent per-portfolio keys).
- Manual portfolio → still 400 `NOT_CONNECTED` (checked before cooldown).
- Redis unreachable → resync still succeeds (fail-open), no 429.
- Suites green (portfolios / wallet-preview resync tests). Add: free 2nd → 429; pro 2nd same id → 429; pro
  2nd other id → 200.

## Frontend (Cowork — done)
`api.ts` `ApiError` now carries `retryAfter`. `ResyncButton.svelte` catches `RESYNC_RATE_LIMITED`, locks the
button (disabled + `cursor: not-allowed`), shows the backend message as a hover tooltip (on a wrapper so it
shows while disabled), and auto-unlocks after `retryAfter` for short (≤1h) cooldowns. A batch where some
wallets still synced is treated as success (only an all-rate-limited batch locks the control).
