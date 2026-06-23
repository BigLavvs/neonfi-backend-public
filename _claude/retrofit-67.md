# retrofit-67 — Trim leading-$0 points from connected value history (stop the June-2025 flat tail)

A freshly-synced connected wallet's value chart runs back ~1 year (to ~June 2025) as a flat $0 line before
the real data. Cause: `buildConnectedValueHistory` (sync.ts) fills the window back to `Date.now() - days`
using the bounded Moralis sampler (`sampleMoralisValueHistory`). For dates before the wallet held anything,
`wallets/:addr/tokens?to_block=…` returns no rows → `value: 0`. Those leading zeros get persisted as
`BalanceSnapshot` rows and then charted. (A GoldRush full-window series with leading zeros would do the same.)

A wallet with $0 value has no chartable history — the line should begin at the first day it actually held
value. Fix at BOTH the write path (don't persist the leading zeros going forward) and the read path (so
already-persisted zero snapshots stop showing without forcing a fresh full resync).

## Backend

### 1. Write path — `src/modules/wallet-data/sync.ts`, `buildConnectedValueHistory(...)`
Just before `return`, drop the leading run of `value === 0` points (the period before the wallet was first
funded). Keep interior zeros (a wallet drained mid-history is real) and the pinned `today` point. If every
point is 0 (genuinely empty wallet) return `[]` — the caller already writes nothing in that case.

```ts
// trim the leading run of $0 points — the wallet held nothing yet (pre-funding); charting them dates
// the line back to the window start. Interior zeros are kept.
const sorted = [...byDate.entries()]
  .filter(([d]) => d <= today)
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([date, value]) => ({ date, value }));
const firstNonZero = sorted.findIndex((p) => p.value > 0);
return firstNonZero <= 0 ? sorted : sorted.slice(firstNonZero);
```
(Replace the existing `return [...byDate.entries()]…` tail with the above.)

Optional efficiency (nice-to-have, not required): in `sampleMoralisValueHistory`, skip pushing samples whose
computed `value` is 0 — avoids persisting zero rows in the first place. The read-path trim below is what
actually fixes existing data, so this is just to keep the table clean.

### 2. Read path — `src/modules/overview/overview.service.ts`, `buildValueHistory(...)`
This builds BOTH `valueHistory` and `connectedValueHistory` from `BalanceSnapshot`, so existing persisted
zero rows still surface. Trim the leading-$0 run from its returned series:

```ts
// (after keptDates.map(...) produces the points array, before returning)
const firstNonZero = points.findIndex((p) => p.value > 0);
return firstNonZero <= 0 ? points : points.slice(firstNonZero);
```
Leading zeros on the aggregate `valueHistory` only occur before ANY selected portfolio had value, so this is
correct there too; interior zeros are preserved; an all-zero series returns `[]`.

## Validate
- Fresh wallet (funded ~recently), full sync → `connectedValueHistory[0].date` ≈ first funding day, NOT ~365
  days ago. No leading flat-$0 stretch.
- A wallet with genuine year-old value → unchanged (its early points are > 0, nothing trimmed).
- Wallet drained to $0 mid-history then refunded → interior $0 day preserved.
- Overview suite green; add an assertion that a snapshot list with leading zeros comes back trimmed.

## Interaction
Complements retrofit-66 (frontend clamps the MANUAL reconstruction to portfolio inception). With both run,
an "All portfolios" chart for a just-added manual + fresh connected wallet starts at the real recent
inception instead of June 2025. The frontend also trims leading zeros defensively (intraday.ts
`trimLeadingZeros`), but the backend trim is what fixes existing connected data and the per-portfolio API.

## Out of scope
Deduping/cleaning the already-written zero `BalanceSnapshot` rows (the read-path trim hides them; a one-off
cleanup isn't necessary).
