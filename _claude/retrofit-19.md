# retrofit-19: refresh must also bust the per-user /overview RESPONSE cache

## Why (gap left by retrofit-18 Part 2)
retrofit-18 made `POST /prices/refresh` delete the caller's **derived** caches
(`portfolio_pnl:<id>`, `analytics_*:<id>`). But `getOverview` (overview.service.ts) wraps the whole
payload in its OWN cache:

```
withCache(`overview:<userId>:<days>:<txLimit>`, () => buildOverview(...))   // 60s
```

So after a refresh, `GET /overview` returns that **cached response** (built with the pre-refresh
prices) until its 60s TTL lapses — the refresh still looks like it did nothing within the window.
Busting only the derived caches isn't enough; the response cache sits in front of them.

(Normal page loads keeping a 60s overview cache is fine/desirable on the slow DB — this is only
about making the *explicit Refresh action* take effect immediately.)

## Fix
In `src/modules/prices/prices.service.ts`, extend the refresh invalidation (the
`invalidateUserDerivedCaches` added in retrofit-18) to ALSO delete the user's overview response
cache keys. Keep the derived-cache deletion (buildOverview's `computeDerived` still reads
`portfolio_pnl`, so both layers must go).

```ts
// after deleting portfolioDerivedCacheKeys for each portfolio:
const overviewKeys = await redis.keys(`overview:${userId}:*`);
if (overviewKeys.length > 0) await redis.del(...overviewKeys);
```
- `overview:<userId>:*` covers every (days, txLimit) variant for that user.
- `redis.keys` is O(n) but fine at MVP scale (the test helpers already use it); if you prefer, use
  `scanStream` — optional.
- Keep the whole thing inside the existing `.catch`-guarded best-effort block (a Redis failure must
  never fail the refresh — retrofit-18's test 389 already covers that path; make sure the added
  `keys`/`del` are under the same guard).
- Consider renaming `invalidateUserDerivedCaches` → `invalidateUserReadCaches` (it now clears both
  derived + response caches). Optional.

## Gate (extend tests/prices.test.ts)
Extend the retrofit-18 cache-bust test (or add one): prime BOTH a derived key
(`portfolio_pnl:<id>`) AND an `overview:<userId>:<days>:<txLimit>` key, call `POST /prices/refresh`,
assert BOTH are deleted afterwards. Redis-down path still returns 200 (already covered).

## Commit (explicit add, no -A)
```bash
git add src/modules/prices/prices.service.ts tests/prices.test.ts _claude/retrofit-19.md
git commit -m "fix(prices): refresh also busts the per-user /overview response cache so it updates immediately (retrofit-19)"
```
Report SHA + confirm both the derived and `overview:<userId>:*` caches are evicted on refresh.
