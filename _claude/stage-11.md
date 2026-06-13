# Neonfi backend — Stage 11: Moralis webhook (connected-portfolio sync)

This file is the source-of-truth intent for Stage 11. Build from this; report back to Idowu when done.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: 4aef174 (Stage 10B).

## 0. Read first

In this order:

1. `_claude/stage-4a.md` (Stripe webhook handler — Stage 11 is its sibling for blockchain events; reuse the same dispatch/idempotency/signature-verification patterns), `_claude/stage-7.md` (connected portfolio creation — Stage 11 is the actual data sync for those portfolios), `_claude/stage-8.md` (Asset module — Stage 11 auto-creates assets when needed), `_claude/stage-9a.md` (Transaction module + recalc rule — Stage 11 writes through this).
2. `Neonfi_Backend_Build_Guide.md` (frontend repo `docs/`) — **Stage 11 in §3 in full**, **§2.6 Idempotency Rules** (Moralis webhook is on the mandatory-idempotency list alongside Stripe webhook), **§2.8 Webhooks** (x-signature verification requirements), **§4.4 Connected portfolio → Moralis sync** (the full flow we're implementing).
3. `Neonfi System Architecture.docx` — **MORALIS WEBHOOK** entity (URLs, privacy rules — Moralis = 200 with verified signature, all others = 401), **Moralis Webhook Module** rules.
4. Past research on Moralis signature format (we already established it back when getting the webhook secret): `sha3(JSON.stringify(body) + MORALIS_WEBHOOK_SECRET)`. The signature arrives in the `x-signature` header.

When in doubt: docs win over Build Guide; frontend wins over docs on consumed shapes. STOP and ask, never silently diverge.

## 1. Architecture decisions

### 1.1 Signature verification — Keccak-256, NOT SHA3-256 [LOCKED, CRITICAL DETAIL]

Moralis uses **Keccak-256** (Ethereum-flavored), NOT the NIST SHA3-256 that ships with Node's `crypto`. They produce different hashes for the same input. Node's `crypto.createHash('sha3-256')` is wrong here.

Use the **`js-sha3`** library (~6KB, no native deps, has `keccak256` export). Install as runtime dep:

```bash
npm install js-sha3
```

Signature computation:
```ts
import { keccak256 } from 'js-sha3';

function computeMoralisSignature(rawBody: string, secret: string): string {
  return keccak256(rawBody + secret);
}
```

The verification flow:
1. Read raw body via `c.req.text()` BEFORE any JSON parsing (same as Stage 4A's Stripe handler).
2. Read `x-signature` header. Missing → `401 INVALID_SIGNATURE`.
3. Compute `keccak256(rawBody + MORALIS_WEBHOOK_SECRET)`.
4. Constant-time compare with the header. Use `crypto.timingSafeEqual` after both are converted to equal-length Buffers. Mismatch → `401 INVALID_SIGNATURE`.

**Important detail**: Moralis signs the body BEFORE network transit. We get bytes back from `c.req.text()`. Don't `JSON.parse` then `JSON.stringify` — that re-orders keys and changes whitespace. The raw body string from `c.req.text()` IS what Moralis signed, byte-for-byte. Sign that.

### 1.2 Idempotency — Redis 30-day TTL on event ID [LOCKED, mirrors Stage 4A]

Moralis includes a `streamId` and `confirmed` flag, but the unique event identifier varies by event type. Use the body's `streamId + chainId + tag` combo OR fall back to a hash of the body for events without a clear ID. Pragmatically: most Moralis Streams payloads include a `tag` or transaction-hash-derived ID at the top level.

Redis key: `moralis_event:<eventId>` with TTL `30 * 24 * 60 * 60 = 2592000` seconds.

After signature verification + idempotency check passes, before dispatch:
```ts
const seen = await redis.get('moralis_event:' + eventId);
if (seen) return c.json(ok({ received: true, duplicate: true }), 200);
// ... dispatch ...
await redis.set('moralis_event:' + eventId, '1', 'EX', 2592000);
return c.json(ok({ received: true }), 200);
```

Same race-window trade-off as Stage 4A: if dispatch succeeds but the Redis SET fails (Stripe retries, second processes again). Stage 9A's `Transaction.transactionHash @unique` is the secondary safety net for native/erc20 transactions — duplicate inserts get rejected at the DB level, which the handler catches as "already processed."

### 1.3 Event types and dispatch [LOCKED]

Moralis Streams sends one of several event shapes. We explicitly handle three:

| Event shape | Source | Handler does |
|---|---|---|
| Native transfer (block-confirmed) | `txs[]` array in payload, plain ETH/BNB-style transfers | Insert Transaction (type='native') via Stage 9A's repository, recalc Asset.balance |
| ERC-20 transfer | `erc20Transfers[]` array | Insert Transaction (type='erc20') with Erc20TransactionDetail, recalc balance |
| NFT transfer (ERC-721/1155) | `nftTransfers[]` array | **Stage 11: log + skip (no-op).** Stage 12 will handle by writing to the Nft table. |

Other Moralis fields (internal txs, logs, etc.) are ignored at MVP. Future stages can extend.

A single Moralis payload may contain MULTIPLE transfer events (a block can have many transactions involving the user's wallet). Process them in payload order. Each is processed inside its own try/catch — one failure doesn't block the others.

### 1.4 Connected-portfolio identification — match by walletAddress + chainId [LOCKED]

Moralis Streams are configured per-wallet (the backend creates a stream when a connected portfolio is created — but Stage 11 doesn't build that yet; the placeholder Moralis stream API call is deferred to a future stage). For now, assume streams are manually configured in Moralis dashboard pointing at user wallets, OR that Stage 11's webhook handler is the consumer-side and a future stage builds the producer-side stream registration.

Each Moralis event includes the wallet address that triggered it. Stage 11 handler:
```ts
const portfolio = await prisma.portfolio.findFirst({
  where: { walletAddress: addr.toLowerCase(), chainId },
  include: { type: true },
});
if (!portfolio) {
  // log + return 200 (graceful no-op — wallet we don't track anymore)
  return;
}
if (portfolio.type.name !== 'connected') {
  // edge case: shouldn't happen since manual portfolios don't have wallet addresses, but be defensive
  return;
}
```

Chain identification: Moralis includes `chainId` (hex like `'0x1'` for Ethereum). Map to our `Chain` table via `Chain.moralisId`.

If no matching portfolio: log, return 200, don't error. Reasonable end states: user deleted the portfolio, user changed wallet address, etc.

### 1.5 Transaction creation bypass — new repository entrypoint [LOCKED, small Stage 9A delta]

Stage 9A's `createTransaction` service rejects connected-portfolio writes with `403 CONNECTED_PORTFOLIO_READ_ONLY`. Webhook-driven writes need to bypass that check.

Add a new service function in `src/modules/transactions/transactions.service.ts`:
```ts
export async function createTransactionFromWebhook(params: {
  portfolio: PortfolioWithRelations;
  body: CreateTransactionBody;  // same shape as user-facing POST body
}): Promise<TransactionDetailDTO> {
  // Same logic as createTransaction but skips the CONNECTED_PORTFOLIO_READ_ONLY check.
  // Skips the ASSET_NOT_IN_PORTFOLIO check too — auto-creates the asset (see §1.7).
  // Still runs balance recalc.
}
```

This is the canonical bypass. Stage 11's webhook handler calls this; Stage 9A's controller still calls the strict `createTransaction`. Document the asymmetry in code comments referencing this prompt.

### 1.6 Direction mapping — IN/OUT → buy/sell for connected portfolios [LOCKED]

Stage 9A established `direction: 'buy' | 'sell' | 'transfer'` with `transfer = no-op for balance` (manual portfolios' simplification). For connected portfolios, the wallet IS the truth — every IN transfer affects balance, every OUT transfer affects balance. Therefore:

- Moralis transfer with `to === portfolio.walletAddress`: `direction='buy'` (received → balance += amount)
- Moralis transfer with `from === portfolio.walletAddress`: `direction='sell'` (sent → balance -= amount)
- Neither matches (shouldn't happen for our portfolio's events, but defensively): log warning, skip

This is the "real on-chain truth" interpretation. Stage 9A's manual-portfolio "transfer = no-op" simplification doesn't apply here because connected portfolios reflect actual blockchain activity, not user-logged simplifications.

Document this divergence in the webhook handler with a code comment.

### 1.7 Asset auto-creation [LOCKED]

For connected portfolios, the user didn't manually add tokens — Moralis tells us what tokens exist via transfer events. Stage 8's `ASSET_NOT_IN_PORTFOLIO` strict-mode rejection doesn't apply.

In `createTransactionFromWebhook`:
1. Resolve symbol → tokenId via Token table.
2. Check if Asset(portfolioId, tokenId) exists.
3. If not: create it with `balance: 0`, `netDeposit: 0` (defaults). Same shape as Stage 8's POST /assets creates.
4. Proceed with transaction insertion.
5. Recalc Asset.balance from full transaction history.

The auto-create skips the plan-rank check from Stage 8 — connected portfolios show whatever tokens the user actually holds, regardless of free-tier rank limits. This is a deliberate divergence: the rank cap is "what tokens can you ADD as a free user," not "what tokens can you HOLD." Connected portfolios are passive observers; they show everything.

### 1.8 Token resolution by symbol — skip unknown [LOCKED]

Moralis sends ERC-20 transfers with contract address, name, symbol. For our handler:
1. Try to find Token by symbol (case-insensitive). Found → use that tokenId.
2. Not found → log warning (`{ event: 'moralis_unknown_token', symbol, contract }`), skip the transfer. Don't fail the whole webhook.

We don't auto-create Token rows from webhook data. Token catalog is owned by Stage 9B's CMC sync; auto-creating from Moralis events would put unverified tokens in the catalog (could be spam tokens, scam coins).

Future: Stage 11 could publish "unknown token observed" events for a separate review queue. Out of scope for now.

### 1.9 NFT events deferred to Stage 12 [LOCKED]

Stage 11 detects `nftTransfers[]` in the payload but doesn't write to the Nft table. Log structured event:
```json
{ "event": "moralis_nft_event_deferred", "stage": 12, "transferCount": <n>, "portfolioId": <id> }
```

Return 200 from the webhook regardless — we don't want Moralis retrying NFT events forever waiting for Stage 12. The events get logged for audit; Stage 12's first job will be to backfill (or accept that historical NFT events between Stage 11 and Stage 12 are lost — acceptable for MVP).

### 1.10 No new env vars [LOCKED]

`MORALIS_WEBHOOK_SECRET` already exists in `.env`. We established it equals `MORALIS_API_KEY` per Moralis's unified-key pattern (architecturally noted in our earlier research; doc-fix item still pending).

## 2. Module scope

```
src/modules/webhooks/moralis-handlers.ts         # NEW — per-event-type handlers
src/modules/webhooks/webhooks.controller.ts      # EDIT — add POST /webhooks/moralis route
src/modules/webhooks/webhooks.service.ts         # NO EDIT — Stripe-specific logic stays untouched
src/modules/transactions/transactions.service.ts # EDIT — add createTransactionFromWebhook bypass
src/modules/transactions/recalc.ts               # NO EDIT — reused as-is
src/lib/moralis-signature.ts                     # NEW — keccak256 signature helper
package.json                                     # EDIT — add js-sha3
tests/moralis-webhook.test.ts                    # NEW — ~12 tests
```

Do NOT touch any other module directory.

## 3. Endpoint

### 3.1 `POST /webhooks/moralis` — receive verified Moralis Streams events

**No auth middleware.** Moralis is the caller; signature verification per §1.1.

**Flow:**

1. Read raw body via `c.req.text()`. Bind to `rawBody` (string).
2. Read `x-signature` header. Missing → `401 INVALID_SIGNATURE`.
3. Compute expected signature: `keccak256(rawBody + MORALIS_WEBHOOK_SECRET)`. Constant-time compare. Mismatch → `401 INVALID_SIGNATURE`. Don't include the underlying error in the response.
4. Parse JSON. Malformed → `400 MALFORMED_PAYLOAD`.
5. Extract event ID per §1.2. If event ID resolves to null (no extractable identifier), use `keccak256(rawBody)` as the fallback ID.
6. Check Redis idempotency. Already seen → `200 { received: true, duplicate: true }`.
7. Dispatch:
   - Extract `chainId` from payload. Resolve to local Chain via `Chain.moralisId`.
   - Find matching connected Portfolio per §1.4. None → log + return 200.
   - For each transfer in `txs`, `erc20Transfers`, `nftTransfers`:
     - try/catch around each — one failure shouldn't kill the rest.
     - native/erc20: call `createTransactionFromWebhook` per §1.5 + §1.6.
     - nft: log "deferred to Stage 12" per §1.9.
8. After all transfers processed: set Redis idempotency key.
9. Respond `200 { received: true, processed: <n>, skipped: <n>, deferred: <n> }`.

On any unrecoverable error mid-processing (DB connection lost, etc.): log full error, respond `500 { error: { code: 'WEBHOOK_HANDLER_ERROR' } }`. Moralis retries. Don't set the idempotency key — we want the retry to actually re-process.

## 4. Cross-cutting wiring

### 4.1 Install js-sha3

```bash
npm install js-sha3
```

No `@types/js-sha3` needed — the package ships its own types.

### 4.2 Signature helper

```ts
// src/lib/moralis-signature.ts
import { keccak256 } from 'js-sha3';
import { timingSafeEqual } from 'node:crypto';

export function verifyMoralisSignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = keccak256(rawBody + secret);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}
```

Constant-time compare matters even though signature verification is single-step; small habit, real defense against timing attacks.

### 4.3 Transactions service bypass entrypoint

Per §1.5. Reuse the same in-transaction logic as `createTransaction` but skip:
- The `portfolio.type.name === 'connected'` check (we KNOW it's connected; that's the point)
- The `ASSET_NOT_IN_PORTFOLIO` check (auto-create instead)

Inside the `$transaction`, before the existing flow:
```ts
const asset = await tx.asset.findUnique({
  where: { portfolioId_tokenId: { portfolioId: portfolio.id, tokenId } },
});
if (!asset) {
  await tx.asset.create({
    data: { portfolioId: portfolio.id, tokenId, balance: '0', netDeposit: '0' },
  });
}
```

Then proceed with the standard Transaction + child detail insert + recalcAssetBalance.

### 4.4 Webhook controller route

Add `POST /moralis` to the existing `webhooksRouter`:

```ts
// src/modules/webhooks/webhooks.controller.ts (existing)
import { handleMoralisWebhook } from './moralis-handlers.js';
webhooksRouter.post('/moralis', async (c) => handleMoralisWebhook(c));
```

The Stripe webhook (`/webhooks/stripe`) stays untouched.

## 5. Tests (Vitest, integration — new file `tests/moralis-webhook.test.ts`)

Test numbering continues from Stage 10B (~268).

**Setup**: real DB + real Redis. Construct properly-signed Moralis-like payloads per test (use `keccak256(JSON.stringify(payload) + SECRET)` to compute the expected signature, set the `x-signature` header to match).

### Signature & idempotency — 4 tests

269. **Valid signature happy-path** → 200 `{ received: true }`.
270. **Invalid signature** → 401 `INVALID_SIGNATURE`. No DB writes.
271. **Missing `x-signature` header** → 401 `INVALID_SIGNATURE`.
272. **Duplicate event ID** → first call 200; second call returns `{ duplicate: true }`; only one Transaction row created.

### Transfer handling — 5 tests

273. **Native transfer IN (to=walletAddr) for unknown chain** → 200 with `skipped` count; no DB writes (chain lookup failed gracefully).
274. **Native transfer IN for known portfolio + known token** → 201 (no — webhooks return 200); Asset.balance increases; Transaction row inserted with direction='buy'.
275. **Native transfer OUT (from=walletAddr)** → 200; Asset.balance decreases; Transaction row inserted with direction='sell'.
276. **ERC-20 transfer for unknown token (symbol not in our Token table)** → 200 with `skipped` count; no DB writes; log line emitted.
277. **ERC-20 transfer for known token but Asset doesn't exist yet** → 200; Asset auto-created with balance=0; Transaction inserted; balance recalc'd; final balance = transfer amount.

### NFT deferral — 1 test

278. **NFT transfer event** → 200 with `deferred: 1`; no Transaction/Asset writes; structured log line emitted.

### Edge cases — 2 tests

279. **Wallet address doesn't match any portfolio** → 200 with all zero counts; no DB writes.
280. **Multiple transfers in single payload (mix of native + erc20)** → 200; counts reflect all of them; each Transaction inserted; idempotency key set once after all.

Total new tests: 12. After Stage 11: ~280.

## 6. STOP-AND-ASK gates

1. **If `js-sha3` doesn't export `keccak256` as named export** in the installed version, check the package's actual exports and adapt. Some versions use `sha3.keccak256` or similar. Don't switch hash algorithms.
2. **If Moralis Streams' real payload shape differs significantly from §1.3's assumed `txs[] / erc20Transfers[] / nftTransfers[]` structure**, surface and adapt. The test payloads should reflect Moralis's actual webhook format. If you don't have a reference example, use a placeholder shape and document the assumption.
3. **If the constant-time signature compare doesn't match Buffer lengths**, the issue is usually hex-encoding mismatch (signature header might be `0x...` prefixed). Strip the `0x` if present before comparing.
4. **If `createTransactionFromWebhook` breaks existing Stage 9A user-facing tests**, STOP — the bypass should be additive, not replace any logic in the user-facing path.

## 7. What NOT to do

- **No JSON.parse + JSON.stringify before signature verification.** Raw body string only.
- **No SHA3-256 from `crypto.createHash`.** Keccak-256 via js-sha3 only — different algorithms.
- **No exposing the signing secret in any log.** Hash the raw body, never log it.
- **No writing to the Nft table from Stage 11.** Stage 12 owns that.
- **No auto-creating Token rows from Moralis events.** Stage 9B's CMC sync owns the catalog.
- **No applying the manual-portfolio "transfer = no-op" rule.** Connected portfolios use IN→buy/OUT→sell per §1.6.
- **No retrying inside the handler.** Moralis retries on non-2xx.
- **No new env vars.** MORALIS_WEBHOOK_SECRET already exists.
- **No editing `docs/*.docx`.**
- **No `npm audit fix`.**

## 8. Commit and report

```bash
git add -A
git commit -m "feat(moralis-webhook): Stage 11 — Moralis Streams ingress + native/erc20 transfer sync + asset auto-create + NFT deferral"
git log --oneline -5
```

Report:
- New commit SHA.
- Confirmation `js-sha3` was added as a runtime dep.
- A sample verified webhook curl (with `x-signature` header computed from a test secret).
- One curl/test capture of each behavior: native buy, native sell, erc20 with auto-asset-create, NFT deferred, signature reject, idempotent duplicate.
- Vitest output: all tests passing (~280).
- Confirmation Stage 9A's user-facing tests still pass after the `createTransactionFromWebhook` addition (no regressions).
- Confirmation no Nft table writes happen during NFT events (verify with a count query).
- Doc-fix pile items added in Stage 11:
  - `Neonfi System Architecture.docx` Moralis Webhook Module: clarify the IN→buy / OUT→sell direction mapping for connected portfolios, contrasting with Stage 9A's manual-portfolio transfer=no-op simplification.
  - `Neonfi System Architecture.docx` Asset module: clarify that webhook-driven asset creation (Stage 11) bypasses the plan-rank check and the ASSET_NOT_IN_PORTFOLIO rule; user-facing creation (Stage 8) still applies both.
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
