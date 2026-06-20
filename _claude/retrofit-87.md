# retrofit-87 — CSV bulk import for MANUAL portfolios (transactions + starting assets)

Adds bulk import so a user can upload a CSV of transactions or starting assets into a MANUAL
portfolio instead of entering them one at a time. The frontend parses + validates client-side and
shows a per-cell error preview (download templates already live at
`/templates/transactions-template.csv` and `/templates/starting-assets-template.csv`); these endpoints
are the authoritative server-side validation + the actual writes.

**Scope: MANUAL portfolios only.** Connected portfolios are provider-synced — reject with 400
`NOT_MANUAL`. Reuse the existing per-row create paths and Zod rules (transactions.schemas /
assets.schemas) so bulk import can NEVER accept something the single-create path would reject.

## CSV shape the rows arrive as (already stripped of the `******` notice lines + header by the FE)
- Transactions: `type(buy|sell)`, `symbol`, `amount`, `price`, `date`, `notes?`, `from?`, `to?`,
  `transaction_hash?`, `gas_fee?`. CSV `type` → `direction`; backend tx `type` is always `native`;
  `price` → `priceAtTime`; `date` → `timestamp` (parse `YYYY-MM-DD` → ISO, default 00:00:00Z).
- Starting assets: `symbol`, `quantity`(→balance), `cost_per_unit?`, `acquired_date?`. Cost mode is
  DERIVED (mirror the FE + StartingAssetsEditor):
  - `cost_per_unit` present → `{ mode: 'avg', avgCost: cost_per_unit }` (acquired_date ignored)
  - else `acquired_date` present → `{ mode: 'historical', date }`
  - else → `{ mode: 'none' }`

## Endpoints

### 1. `POST /tokens/validate-symbols` (pre-import check, read-only)
Lets the FE flag unknown symbols in the preview WITHOUT shipping the whole catalog to the client.
Body `{ symbols: string[] }` (dedup, cap 1000). Resolves each with the SAME resolver the single
transaction/asset create uses. Returns `{ data: { unknown: string[] } }` (the symbols that don't
resolve, upper-cased). Auth required; no rate-limit beyond the global.

### 2. `POST /portfolios/:id/transactions/bulk`
Body:
```
{ mode: 'all_or_nothing' | 'skip_invalid',
  rows: [ { type, symbol, amount, price, date, notes?, from?, to?, transactionHash?, gasFee? } ] }
```
- Cap `rows` at 500 (400 `TOO_MANY_ROWS` otherwise).
- Validate EACH row with the existing native-transaction Zod schema (+ symbol resolves, + date not
  future). Collect failures as `{ row, column, message }` (`row` = 1-based index within `rows`).
- `all_or_nothing`: if ANY row fails → 400, write nothing, return all errors. Else insert all inside
  ONE Prisma transaction; recalc cost basis once at the end (reuse the single-create recalc).
- `skip_invalid`: insert the valid rows (in a transaction), return `{ imported, skipped, errors }`.
- Dedup on `transactionHash` when present (existing unique constraint → duplicates count as skipped,
  not errors).

### 3. `POST /portfolios/:id/assets/bulk`
Body `{ mode, rows: [ { symbol, quantity, costPerUnit?, acquiredDate? } ] }`. Same mode semantics +
500 cap. Validate each via the existing `CreateAssetBodySchema` after deriving the cost union + symbol
resolution; `historical` rows 400 if no price snapshot on/before the date (same as single create).
Creating an opening for a symbol that already has one in the portfolio → that row errors
(`DUPLICATE_OPENING`) rather than silently overwriting.

## Response shape (both bulk endpoints)
```
{ data: {
    imported: number,
    skipped: number,
    errors: [ { row: number, column: string|null, message: string } ]
} }
```
`column` is the offending CSV column name (e.g. `amount`, `symbol`, `date`) or null for row-level
issues. Messages must be human + specific: `"expected a number, got 'abc'"`, `"'XYZ' is not a
recognized token"`, `"must be buy or sell, got 'purchase'"`, `"date must be YYYY-MM-DD and not in the
future"`.

## Validation parity (authoritative — the FE mirror is for UX only)
type ∈ {buy,sell} → direction · symbol resolves · amount/price/quantity/cost_per_unit/gas_fee are
numbers in (0, 1e12) (amount/price/quantity strictly > 0; gas_fee ≥ 0) · date/acquired_date are valid
`YYYY-MM-DD`, not future. NEVER auto-create Token rows from a CSV (same rule as the webhook path).

## Gating
Same as the single-create manual paths (owner + manual). If CSV import should be Pro-only, gate it
like the other Pro manual features (confirm with product); default = same as manual create.

## Validate
- Mixed-validity file in `all_or_nothing` → nothing written, every bad cell reported with row+column.
- Same file in `skip_invalid` → valid rows imported, skipped list matches the bad rows.
- Connected portfolio → 400 `NOT_MANUAL`. >500 rows → 400 `TOO_MANY_ROWS`.
- Cost mode derivation correct (avg / historical / none) from the column combo.
- Imported transactions/openings are identical to what the single-create path would produce (cost
  basis, value history, markers all reconcile).
- `transactions` / `assets` suites green; add bulk happy-path + per-error-type + atomic-rollback cases.

## FE integration (built separately — for reference)
`lib/csv-import.ts` does structural + number + date + type + cost-mode validation purely and returns
`{ rows, errors }`; it calls `validate-symbols` to flag unknown tokens in the preview; on Import it
posts to the bulk endpoint with the user-chosen `mode`, then merges any server `errors[]` back into the
same per-row preview. No silent failures in either mode.
