# retrofit-28: live-price firehose (broadcast WS) + raw position data on /overview

## Architecture (Idowu's decision — supersedes the per-symbol subscribe model)
Realtime prices are a **client-side display overlay**. The server must NOT recompute values/PnL per
tick or per request — the only authoritative recompute is the **daily snapshot job**. Concretely:
- The WS server **broadcasts every price to every connected (Pro) client** — one firehose. No
  `subscribe` message, no `subs:<SYMBOL>` sets, no per-socket symbol tracking, no
  subscribe-on-first-subscriber. Server cost is flat regardless of how many symbols/holdings.
- `/overview` returns the **raw position data** (per-portfolio holdings + cost basis) so the
  **frontend** can recompute every displayed figure from the firehose, falling back to the daily
  DB price when a symbol has no live tick.

This fixes the "not updating / 30s-delay" regression too: a broadcast has no handshake to fail.

## Part 1 — WS server → broadcast firehose
Files: `src/ws/server.ts`, `src/ws/registry.ts`.

- Keep the upgrade auth exactly as-is: GETDEL `ws_ticket:<token>`, session check, **Pro gate (403 free)**.
- On `connection`: register `socketId → ws` only. **Remove** `symbolsBySocket`, the `subs:<SYMBOL>`
  SADD/SREM/SCARD logic, `coinbase.subscribeToSymbol/unsubscribeFromSymbol`, and the whole
  `subscribe` message handler (clients send nothing now — ignore inbound frames). The exchange feeds
  are already subscribed to the full coverage at boot (`index.ts` `startPriceFeeds`), so prices are
  already flowing into Redis `price:<SYMBOL>`.
- At startup, `redisSubscriber.psubscribe('price:*')` ONCE. On each `pmessage`, parse
  `{ price, change24h }` and stash it in an in-memory `Map<symbol, {price, change24h}>` (latest wins).
- A single `setInterval(~1000ms)`: if the map has entries, send ONE batched frame to every OPEN
  socket and clear the map:
  ```json
  { "type": "price_update",
    "payload": { "prices": [{ "symbol": "BTC", "price": 65476.8, "change24h": -3.1 }, ...] },
    "timestamp": "<iso>" }
  ```
  Batching = one client update/sec (smooth, low churn) instead of per-tick spam. Clear the interval in
  `stopWsServer`.
- Keep `user_events` (plan_downgraded → close 4003) and `client_events` (reconnect) handling.
- `registry.ts`: keep `socketsByUser` + `wsBySocketId`; delete `symbolsBySocket` and the subs helpers.

## Part 2 — /overview: raw per-portfolio holdings (for client recompute)
Files: `src/modules/overview/overview.{dto,service}.ts`.

- Add to EACH `portfolios[]` row: `holdings: Array<{ symbol: string; balance: number; avgCost: number | null; costBasis: number; realizedPnl: number }>` — full-precision `balance`; `avgCost/costBasis/realizedPnl` straight off the Asset (already maintained by recalc — **no new computation**). Exclude `balance <= 0`.
- Also add `avgCost`/`costBasis`/`realizedPnl` to the existing top-level aggregate `holdings[]` (per symbol, summed across portfolios) so the dashboard can do aggregate live PnL without re-summing portfolio rows. (`avgCost` aggregate = Σcost/Σqty across portfolios for that symbol.)
- Keep totals/allocation/per-portfolio daily PnL fields as the **daily fallback**.
- **Server-resource cleanup (do it):** drop the per-request live-price overlay (`getLivePriceMap`) from the `/overview` read path so totals/allocation/holdings return the **daily/stored** values — the client now owns the live overlay. If removing it breaks existing overview tests in a way that's more than a fixture tweak, leave the overlay in (it's harmless) and just note that. Report which you did.

## Part 3 — daily authoritative recompute
No change — `snapshot.job.ts` stays the single daily source of persisted/derived values. Confirm it still runs.

## Tests + commit
- WS server: update/representative test for broadcast (a price publish → all connected sockets receive the batched frame; no subscribe needed). Overview: assert each portfolio row carries `holdings[]` with the new fields. Run the `ws` + `overview` suites green (DATABASE_URL_TEST set, dev stopped).
- Commit named files (no -A). Report SHA + the exact frame shape (`payload.prices[]`) and the new `holdings` field shapes so I can wire the frontend.

## Frontend follow-up (FE-C, after this lands — Idowu/Claude, not CC)
- `ws.ts`: handle the batched `payload.prices[]` (loop → `prices.set`); delete `subscribeSymbols` (firehose delivers everything).
- Remove all `subscribeSymbols(...)` calls (wallet, token-detail, Add-Asset/Add-Transaction pickers, dashboard) and the dashboard 30s `invalidateAll` refetch.
- Recompute every displayed figure from `$prices` × balance/avgCost with daily fallback: dashboard total + per-portfolio PnL + allocation; performance holdings + hero. Wallet + token-detail already recompute (just stop subscribing).
