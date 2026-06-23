# retrofit-61 — Serve the multi-year value history (raise the /overview day clamp)

retrofit-60 made connected sync **write** up to 3 years of `BalanceSnapshot` rows (the
Zerion/Mobula one-call series + capped Moralis tail). But `/overview` still **serves** at most a year,
so the ALL chart can't show 2024 yet — the data is in the DB, the endpoint caps it.

## The cap
`src/modules/overview/overview.controller.ts:33`:
```ts
days: z.coerce.number().int().catch(90).transform(clampTo(1, 365)),
```
`buildValueHistory` then slices to `days`, so 365 is the hard ceiling regardless of how many snapshots
exist.

## The fix
Raise the ceiling so the ALL range can pull the multi-year window:
```ts
days: z.coerce.number().int().catch(90).transform(clampTo(1, 1095)), // retrofit-61: allow ~3yr (ALL)
```
- The frontend already sends `days` per range (1Y → 365, ALL → 3650), so ALL now resolves to 1095 and
  shorter ranges are unaffected. No other backend change — `buildValueHistory` / `connectedValueHistory`
  already slice to `days`.
- **Manual portfolios are unaffected in practice:** their series is reconstructed on the frontend from
  price history (~1yr available), so a wider window just means the manual portion contributes from
  wherever its data starts — the connected portion is what now reaches 3 years.

## Validate
- `GET /overview?days=1095` returns `connectedValueHistory` spanning up to ~3 years for the test wallet
  (after a resync has run retrofit-60's backfill); `?days=365` still returns a year; `?days=99999`
  clamps to 1095 (no 400).
- Manual-only overview unchanged. Suites green (overview).

## Frontend (Cowork — I handle after this lands)
- ALL already requests the wide window; once the clamp is raised the connected ALL line reaches 2024.
- Optional polish: adaptive bucketing/axis labels for the long range so ~1095 daily points read cleanly
  (daily ≤90d, ~weekly to a year, ~monthly beyond). The line renders without it; this is readability.

## Out of scope
Manual reconstruction depth (bounded by price-history availability — the held retrofit-58 Part 5b /
historical-price work); Part D feed fallback.
