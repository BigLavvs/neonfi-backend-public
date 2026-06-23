# retrofit-49 — Connected wallets: real transfer history import (replaces the opening-seed)

## Why

retrofit-47 seeds ONE synthetic "opening" transaction per token at sync time, so every connected
transaction shows the sync date, no hash/from/to/gas, and a placeholder amount/value. That's wrong —
connected portfolios should show the wallet's REAL transfers. This retrofit replaces the opening-seed
with a real history import:

1. Pull the wallet's actual transfers (native + ERC-20 + NFT) from the provider with their real
   timestamp, tx hash, from/to, gas, amount, and USD value. (#3, #4)
2. Import current NFT holdings AND NFT transfer history. (#2)
3. Page size ~100 per type; expose a cursor "load more" endpoint for the next 100. (#5)
4. Capture provider token logos for auto-listed tokens and surface them on transactions. (#6)
5. Trim every wallet amount to a valid Decimal(20,8) string before storing — 8 dp, no overflow. (#7)
6. The overview "transactions" stat shows the wallet's REAL total count, not the imported page. (#8)
7. Keep a reconciling opening lot = the residual (starting balance) so the displayed balance still
   equals the on-chain balance exactly, and so value history can be computed from
   starting-balance + every transaction. (#9)

Depends on retrofit-47 (wallet-data providers, `sync.ts`) and retrofit-48 (`Token.contractAddress`,
`Token.autoListed`). Do retrofit-48 first.

DO NOT touch the Moralis stream registration, the webhook handler, or the manual-portfolio path.

---

## 1. Provider history capability

Add to `WalletDataProvider` (types.ts) an optional history method (implement for **Moralis** —
primary + richest; the other providers may return `null` = unsupported, and the orchestrator falls
back to Moralis for history):

```ts
export interface WalletTransfer {
  type: 'native' | 'erc20' | 'nft';
  direction: 'in' | 'out';        // relative to the wallet
  hash: string | null;
  from: string | null;
  to: string | null;
  symbol: string | null;          // null for nft
  name: string | null;
  contractAddress: string | null;
  amount: number | null;          // token qty (nft: 1)
  usdValue: number | null;        // historical USD at tx time when the provider gives it
  gasFee: number | null;
  timestamp: string;              // ISO, the REAL block time
  logoUrl: string | null;
  // nft only:
  nftTokenId: string | null;
  collectionName: string | null;
}

export interface TransferPage {
  transfers: WalletTransfer[];
  nextCursor: string | null;      // null when no more
  totalCount: number | null;      // provider's total tx count for the wallet, when available (#8)
}

// on WalletDataProvider:
getTransferHistory?(address: string, chainSlug: string, opts: { cursor?: string | null; limit?: number }): Promise<TransferPage | null>;
```

**Moralis impl** (`providers/moralis.ts`): use the wallet history endpoint
`GET {MORALIS_DEEP_INDEX_BASE}/wallets/{address}/history?chain={hex}&order=DESC&limit=100&cursor=...`
which returns native + ERC-20 + NFT transfers per tx with `block_timestamp`, `hash`, `from_address`,
`to_address`, `value`/`erc20_transfers[]`/`nft_transfers[]`, and a `cursor`. Map each into
`WalletTransfer` (direction = to===wallet ? 'in' : 'out'; usdValue from the transfer's `value_usd`
when present; logoUrl from the token metadata). For Solana use the solana-gateway swaps/transfers
endpoints; if unavailable, return `null` (history unsupported for Solana → opening-lot only).
`totalCount`: Moralis doesn't always give a cheap total — if the response exposes one use it, else
leave null (the count then falls back to the imported row count, see §4).

Orchestrator (`index.ts`): add `fetchTransferPage(address, chain, opts)` that calls the first
provider whose `getTransferHistory` returns non-null (Moralis first).

---

## 2. Rework the initial sync (`wallet-data/sync.ts`)

Replace the per-token opening-seed with:

1. **Import the first page** (`limit: 100`) of transfers via `fetchTransferPage`. For each transfer
   (oldest→newest so balances build forward):
   - Resolve/auto-list the token by contract→symbol (retrofit-48 rules), storing `logoUrl`.
   - Create a real transaction row with the REAL `timestamp`, `hash`, `from`, `to`, `gasFee`, and
     `usdValue`. Reuse the webhook path (`createTransactionFromWebhook`) but pass the full metadata
     (extend its body type if needed to carry hash/from/to/gas/timestamp/usdValue — it already takes
     most of these). direction: in→buy, out→sell. **Trim `amount`/`gasFee` to Decimal(20,8) strings**
     via a shared `toDecimalString`-style helper (see §5) before persisting. Dedupe on `hash` (the
     existing unique constraint handles re-runs).
   - NFT transfers → create `nft`-type transactions AND upsert/delete the `Nft` row (mirror
     `moralis-handlers.ts` processNftTransfers for the holdings side).
2. **Import current NFT holdings** that may predate the transfer window: call Moralis
   `GET /wallets/{address}/nfts?chain={hex}` and upsert each into `Nft` (same shape the webhook uses).
3. **Reconcile balances (starting lot, #9 + #7):** after importing, for each held token compute
   `residual = providerCurrentBalance − netImported`. If `residual > a dust epsilon`, seed ONE opening
   lot for `residual` (reuse `seedAcquisitionInTx`) dated just before the earliest imported transfer
   (or now if none). This is the "starting balance" the chart reconstruction needs, and guarantees the
   stored balance equals the wallet's current balance.
4. **Persist sync cursor + total:** store `nextCursor` and the provider `totalCount` on the Portfolio
   (new columns, §3). Best-effort throughout — per-item failures log & continue; the whole sync is
   wrapped so a failure still leaves the portfolio created.

---

## 3. Schema (Portfolio)

```prisma
syncCursor      String?   // provider pagination cursor for "load more" (null = no more / done)
externalTxCount Int?      // provider-reported total tx count for the wallet (#8); null if unknown
```
Migration: `npx prisma migrate dev --name portfolio_sync_cursor` + `generate`.

---

## 4. Overview transaction count (#8)

`overview.service.ts` — `transactionCount` currently = `countUserTransactions(userId)` (DB rows).
Change to: `Σ` over the user's portfolios of `connected && externalTxCount != null ? externalTxCount
: <DB tx count for that portfolio>`. So connected wallets show their real on-chain total even though
only ~100 rows are imported; manual + connected-without-a-total fall back to the DB count. (Add a
per-portfolio count helper or compute from a grouped count query.)

---

## 5. Amount trimming (#7)

Add a backend `toDecimalString(value)` helper (mirror the frontend one): no scientific notation, max
8 dp, trailing zeros trimmed, and CLAMP to the Decimal(20,8) range (≤ 12 integer digits) — if a meme
token balance overflows precision 20, store the clamped max and log once. Use it for every amount,
gasFee, and the opening-lot residual the sync writes.

---

## 6. Load-more endpoint (#5)

`GET /portfolios/:id/transactions/sync-more` (authed, ownership-gated like the other portfolio
routes): reads the portfolio's `syncCursor`, calls `fetchTransferPage` with it (limit 100), imports
the page exactly like §2 step 1 (same resolution/trim/dedupe), updates `syncCursor`, and returns
`{ imported: <n>, nextCursor: <string|null> }`. When `syncCursor` is null → `{ imported: 0,
nextCursor: null }`. The frontend's "Load more" calls this, then re-loads the tx list.

Add `logoUrl` to `TransactionListDTO`/`toTransactionListDTO` (#6): resolve from the token's stored
`logoUrl` so connected (and manual) transactions can render the token image.

---

## 7. Validate

- `npm run typecheck` + `node scripts/check-singletons.mjs` clean.
- Mock the provider history in tests (mirror `wallet-preview.test.ts`):
  - Sync a wallet with N transfers → N real transaction rows with the REAL timestamps/hashes/from/to/
    values; amounts are 8-dp strings; balance == provider current balance (residual opening lot seeded).
  - NFT transfer → an `nft` transaction + an `Nft` row; current NFT holdings imported.
  - `sync-more` imports the next page and advances/ô clears the cursor.
  - Overview `transactionCount` uses `externalTxCount` for connected portfolios.
- Regression: portfolios / transactions / assets / overview suites green; retrofit-47/48 suites green.

## Out of scope (do NOT touch)
- Moralis stream registration, webhook handler, signature verification, manual-portfolio path.
- Frontend (load-more button, tx images, amount display) — handled separately against this contract.
