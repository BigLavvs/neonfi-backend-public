# retrofit-87 — CSV bulk import: decisions + shipped surface

Endpoints shipped (all authed; owner-gated by the existing portfolio middleware):
- `POST /tokens/validate-symbols` — `{ symbols[] }` → `{ unknown: string[] }` (read-only preview check).
- `POST /portfolios/:id/transactions/bulk` — `{ mode, rows[] }` → `{ imported, skipped, errors[] }`.
- `POST /portfolios/:id/assets/bulk` — `{ mode, rows[] }` → `{ imported, skipped, errors[] }`.

## Where the code lives
- `src/lib/bulk-import.ts` — shared pure helpers (number/date cell validators with the spec's
  human messages, `ymdToIso`, `normalizeSymbol`, `cellStr`, `BulkError`, `BULK_ROW_CAP=500`).
  Mirrors the FE `Neonfi/src/lib/csv-import.ts` wording so server errors line up with the cells
  the preview already flagged.
- `transactions.bulk.ts` / `assets.bulk.ts` — the bulk services. The controllers add only the
  `/bulk` route + error mapping; nothing in the single-create path changed.
- `tokens.{repository,service,controller,schemas}.ts` — `findExistingTokenSymbols` + `validateSymbols`.

## Parity is enforced two ways (the spec's "can NEVER accept what single-create rejects")
1. **Same Zod.** Each prepared row is rebuilt into the exact single-create body and re-parsed —
   transactions through `CreateTransactionBodySchema` (as a `native` tx: CSV `type`→direction,
   `price`→priceAtTime, `date`→timestamp), assets through `CreateAssetBodySchema` (after deriving
   the cost union). A human validator runs first for the nice column+message; the Zod parse is the
   backstop for anything it misses.
2. **Same write primitives.** Imports go through `createTransactionRow`/`createNativeDetail`/
   `computeUsdValue`/`recalc*` (txns) and `asset.create`+`recalc*` (assets) — so an imported row is
   identical to one entered one-at-a-time (verified: balance/netDeposit/avgCost/usdValue reconcile).
   recalc runs once per touched token + once for the portfolio at the end of the batch.

## Decisions

**1. Symbol resolution normalizes to upper-case; the stored detail symbol is the catalog's.**
`validate-symbols` and both bulk endpoints `trim().toUpperCase()` each symbol before resolving
against the unique `Token.symbol` (the catalog is upper-case; the FE already upper-cases). The
written native-detail uses `token.symbol` (not the raw input) so `recalcAssetBalance` — which
matches details by `token.symbol` — always finds them. `validate-symbols` returns unknowns
upper-cased, so the FE preview and the real import agree on "unknown".

**2. Business-rule parity uses a running balance, not just the per-row schema.**
Beyond the schema, the single-create txn path also auto-creates the asset on a buy (plan-rank
gated), rejects a sell of an unheld token (ASSET_NOT_IN_PORTFOLIO), and rejects an oversell
(INSUFFICIENT_BALANCE). The bulk path applies the SAME guards against a per-token running balance
seeded from the live assets and advanced in **request (CSV) order** — so a buy earlier in the file
legitimately funds a later sell, and only an accepted row advances the balance. CSV order is the
honest analog of "the user added them one at a time"; recalc re-sorts by timestamp for the final
state regardless, so balances don't depend on the chosen ordering.

**3. Dedup differs by entity, per spec.** A txn whose `transactionHash` already exists (in the DB
or earlier in the same file) is **skipped** (counted in `skipped`, never an error) — so a duplicate
never trips the all_or_nothing 400. An asset opening for a symbol already held (DB or earlier in the
file) is a **row error** (`DUPLICATE_OPENING`), never a silent overwrite.

**4. No Pro gate on import itself (default = same as manual create).** Manual create isn't
Pro-gated, so bulk isn't either. The per-token free-tier rank cap (top-10) IS still enforced
per row, exactly like `addAsset` / the auto-create buy — bulk can't be used to bypass plan limits.

**5. all_or_nothing failure → 400 carrying BOTH a standard error and the per-row list.**
The spec wants "400 + return all errors", but the response shape is `{ data: { imported, skipped,
errors } }`. The FE's `api.post` throws on any non-2xx and only reads `error.message`. So on an
all_or_nothing validation failure the controller returns **400** with
`{ error: { code: 'BULK_VALIDATION_FAILED', message }, data: { imported:0, skipped:0, errors } }`
— the `error` gives the FE a clean message (the client preview already shows the per-cell detail),
and `data.errors` satisfies "return all errors" for any client that reads the body. Structural
rejections (`NOT_MANUAL`, `TOO_MANY_ROWS`, malformed body) use the plain `err()` envelope. Success
and skip_invalid always return 200 `{ data: { imported, skipped, errors } }`.

**6. P2002 inside the batch tx is not caught.** We pre-dedupe hashes/openings against the DB +
within-batch, so the only residual P2002 is a concurrent-insert race; catching it mid-transaction
would poison the aborted Postgres tx, so we let it surface (correct all_or_nothing behaviour;
vanishingly rare for skip_invalid).

## Validate (all green)
- `tests/validate-symbols.test.ts` (5), `tests/transactions-bulk.test.ts` (10),
  `tests/assets-bulk.test.ts` (8) — happy path, every error type with row+column, atomic rollback
  (all_or_nothing writes nothing), skip_invalid skip list, NOT_MANUAL, TOO_MANY_ROWS, cost-mode
  derivation (avg/historical/none), single-create parity, hash dedup, oversell/unheld sell, 403.
- Existing `transactions` / `assets` / `tokens` suites: 109/109 still green. `npm run typecheck` clean.
