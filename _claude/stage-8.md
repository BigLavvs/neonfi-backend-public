# Neonfi backend — Stage 8: Assets module

This file is the source-of-truth intent for Stage 8. Build from this; report back to Idowu when done.

Working directory: `C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: whatever Stage 7 landed at (check `git log --oneline -1`).

## 0. Read first

In this order:

1. `_claude/stage-1a.md` through `_claude/stage-7.md` (this repo). Stage 8 reuses every prior pattern including the Stage 7 `derive.ts` shape (which Stage 8 extends to actually sum values), the empty-string Hono sub-router root-route convention, the plan-resolution via `getEffectivePlan`, the FK-safe test cleanup order, and the per-test email mock boilerplate.
2. `Neonfi_Backend_Build_Guide.md` (frontend repo `docs/`) — **Stage 8 in §3 in full**, especially the Divergence Watch ("wallet-connected assets are read-only; balance on manual portfolios is derived from transactions"), **§0.4** (derived values never stored), **§2.5 Caching** (price from Redis 60s TTL — but Stage 10 builds the price cache; Stage 8 reads `Token.currentPrice` directly from the DB row).
3. `Neonfi System Architecture.docx` — **ASSET** entity (URLs, resource rep, privacy rules), **Asset Module** rules.
4. `prisma/schema.prisma` — `Asset` model. The schema is unchanged for Stage 8; no delta. Note `@@unique([portfolioId, tokenId])` — one asset per (portfolio, token).
5. The frontend code that consumes these endpoints:
   - `src/lib/components/modals/AddAssetModal.svelte` line 132 — calls `POST /portfolios/{portfolioId}/assets`.
   - `src/lib/components/modals/DeleteAssetModal.svelte` line 21 — calls `DELETE /portfolios/{portfolioId}/assets/{id}`.
   - `src/routes/(dashboard)/wallet/[portfolioSlug]/[tokenSlug]/+page.ts` — calls `GET /portfolios/{portfolioId}/assets?slug=<tokenSlug>` and `GET /portfolios/{portfolioId}/assets/{id}`.

When in doubt: docs win over Build Guide; frontend wins over docs on consumed shapes. STOP and ask, never silently diverge.

## 1. Architecture decisions

### 1.1 Connected portfolios are READ-ONLY for assets [LOCKED]

Per Build Guide §Stage 8 Divergence Watch: "wallet-connected assets are read-only (synced via Moralis); reject mutations with the right error."

`POST`, `PATCH`, `DELETE` on assets in a connected portfolio → `403 CONNECTED_PORTFOLIO_READ_ONLY`. The check happens after the portfolio-ownership middleware loads the portfolio — read `portfolio.type.name === 'connected'` and reject before the service logic runs.

`GET` (list + detail) works on both manual and connected portfolios — reading is allowed everywhere.

When Stage 11 (Moralis webhook) lands, the webhook handler will write assets into connected portfolios via the asset repository directly (bypassing the controller). Stage 8 does NOT build any Moralis integration; just the mutation-rejection check.

### 1.2 Balance is derived from transactions; POST takes only `{ tokenId }` [LOCKED]

Per Build Guide §Stage 8 Divergence Watch: "balance on manual portfolios is derived from transactions (Stage 9), not set directly."

`POST /portfolios/{portfolioId}/assets` body (Zod, `.strict()`):
```json
{ "tokenId": <positive int> }
```

Nothing else. The created Asset row has `balance: 0`, `netDeposit: 0` (schema defaults). Stage 9 will populate balance + netDeposit when transactions are logged for this asset.

The frontend's `AddAssetModal.svelte` currently sends `{ tokenId, balance, priceAtAcq, ... }` (mock TODO comments). Under `.strict()` this 400s. Add to the doc-fix pile: "frontend AddAssetModal:132 sends extra fields (balance, priceAtAcq) on asset creation — the API rejects them; update to chain POST /assets + POST /transactions after Stage 9, or simplify the modal to only collect tokenId in Stage 8-only flow."

### 1.3 PATCH limited to `netDeposit` only [LOCKED]

`PATCH /portfolios/{portfolioId}/assets/{id}` body (Zod, `.strict()`):
```json
{ "netDeposit"?: "<decimal string>" }
```

`netDeposit` is the user's cost-basis adjustment. It's NOT derived from transactions in MVP — it's a user-settable per-asset "I paid X total for this position" override. Accept as Decimal string, store via Prisma.

Empty body `{}` → 200 no-op, returns current asset DTO.

Why not allow updating `balance`? Per §1.2 it's derived from transactions. Allowing PATCH to override balance would create drift between the asset row and its transactions. Stage 9's recalculation would then overwrite the user's PATCH, creating confusing UX. Reject any `balance` field in the PATCH body.

Same connected-portfolio read-only rule: PATCH on a connected portfolio's asset → 403.

### 1.4 Plan-gated token: rank ≤ 10 for free users on POST [LOCKED]

Per Build Guide §Stage 6: free users see top-10-ranked tokens in `GET /tokens`. Per §Stage 8: "token-count enforcement (10 free / 250+ pro) on asset creation."

Interpretation: free users can only ADD a token whose `rank <= 10` to their portfolio. The detail endpoint (`GET /tokens/{id}`) has no plan gate (Stage 6), but the WRITE path (asset creation) is plan-gated to prevent the workaround "I knew the ID from somewhere → I can use it."

On `POST /portfolios/{portfolioId}/assets`:
1. Resolve `tokenId` → token row. Not found: `400 INVALID_TOKEN`.
2. Determine effective plan via `getEffectivePlan(userId)`.
3. If `effectivePlan === 'free'` AND (token.rank IS NULL OR token.rank > 10): `403 PLAN_LIMIT_REACHED` with `meta: { tokenSymbol: token.symbol, plan: 'free', requiredRank: 10 }`.
4. Pro users: no token-rank check.

### 1.5 Asset DTO with derived fields [LOCKED]

Per architecture rep:
```ts
interface AssetDTO {
  id: number;
  portfolioId: number;
  tokenId: number;
  name: string;           // from joined Token
  symbol: string;         // from joined Token
  logoUrl: string | null; // from joined Token
  balance: number;        // from Asset.balance, serialized as number
  price: number;          // derived: Token.currentPrice (Stage 10 will replace with Redis)
  value: number;          // derived: balance × price
  portfolioPercentage: number;  // derived: value / portfolio.totalValue × 100, or 0 if totalValue=0
  netDeposit: number;     // from Asset.netDeposit, serialized as number
  pnlAllTime: number;     // derived: ((value - netDeposit) / netDeposit) × 100, or 0 if netDeposit=0
  pnlAllTimeValue: number; // derived: value - netDeposit
  createdAt: Date;
  updatedAt: Date;
}
```

`price` reads from `Token.currentPrice` for now. Stage 10 will swap this to Redis-cached prices with DB fallback. The signature of the derivation function stays stable.

`portfolioPercentage` requires knowing the portfolio's `totalValue` (sum of all asset values). For list responses (`GET /portfolios/{id}/assets`), compute totalValue once for the whole list. For detail (`GET /portfolios/{id}/assets/{id}`), load all assets for the portfolio to compute the total — necessary cost for getting the percentage right.

Avoid an N+1: load assets in one query, then map.

### 1.6 Stage 7's `derive.ts` extension — sum totalValue from assets [LOCKED]

Stage 7's `computeDerived(portfolio)` returns 0 for everything. Stage 8 extends it to actually compute `totalValue` and `netDeposit` (the portfolio-level sum, not the column) from the portfolio's assets:

```ts
// derive.ts (Stage 8 update)
export async function computeDerived(portfolio: Portfolio): Promise<DerivedFields> {
  const assets = await prisma.asset.findMany({
    where: { portfolioId: portfolio.id },
    include: { token: true },
  });

  let totalValue = 0;
  let totalNetDeposit = 0;
  for (const a of assets) {
    const balance = Number(a.balance.toString());
    const price = Number(a.token.currentPrice.toString());
    totalValue += balance * price;
    totalNetDeposit += Number(a.netDeposit.toString());
  }

  return {
    totalValue,
    netDeposit: totalNetDeposit,  // portfolio-level rollup; Portfolio.netDeposit column is per-portfolio additive baseline (manual portfolios set it via startingBalance; connected = 0)
    // PnL fields still 0 until Stage 13
    pnlAllTime: 0,
    pnlAllTimeValue: 0,
    pnl24h: 0, pnl24hValue: 0,
    pnl7d: 0, pnl7dValue: 0,
    pnl30d: 0, pnl30dValue: 0,
  };
}
```

Wait — there's a tension. Portfolio.netDeposit is a stored column (Stage 7 reads it directly via `portfolio.netDeposit.toString()`). If Stage 8 also sums asset.netDeposit values into a portfolio-level derived netDeposit, we have two competing definitions. Which wins?

Resolution: **Portfolio.netDeposit (stored column) wins for the Portfolio DTO.** It tracks the portfolio's overall starting baseline. Asset.netDeposit (per-asset) is the user's per-token cost basis. They're conceptually different. Stage 8 does NOT roll up asset.netDeposit into Portfolio.netDeposit — keep Portfolio.netDeposit as the stored column read directly.

Update §1.6 above:
```ts
return {
  totalValue,
  // netDeposit removed from DerivedFields; stays on Portfolio DTO as stored-column read
  pnlAllTime: 0,
  // ... rest stays 0
};
```

Adjust Stage 7's `derive.ts` accordingly — remove `netDeposit` from `DerivedFields`. Portfolio DTO reads `Portfolio.netDeposit` directly. Asset DTO reads `Asset.netDeposit` directly. No rollup confusion.

If Stage 7's tests asserted `netDeposit` in the derived fields, they need updating to read from the row instead. Likely they already do — Stage 7's prompt said "netDeposit is read from the column (NOT derived), serializes as number."

So Stage 8's only change to `derive.ts` is the `totalValue` computation. PnL fields stay 0; netDeposit stays out of derived; everything else unchanged.

### 1.7 Nested router pattern [LOCKED]

Assets routes are nested under `/portfolios/{portfolioId}/assets/...`. Use Hono's parameter binding:

```ts
// In assets.controller.ts:
const router = new Hono<AuthEnv & { Variables: { portfolio: PortfolioWithRelations } }>();

router.use('*', requireAuth);

// Portfolio ownership middleware — runs on ALL asset routes
router.use('*', async (c, next) => {
  const user = c.get('user');
  const portfolioIdRaw = c.req.param('portfolioId');
  const portfolioId = parseInt(portfolioIdRaw, 10);
  if (!Number.isInteger(portfolioId) || portfolioId <= 0) {
    return c.json(err('VALIDATION_ERROR', 'Invalid portfolio ID'), 400);
  }
  const portfolio = await findPortfolioById(portfolioId);
  if (!portfolio || portfolio.userId !== user.id) {
    return c.json(err('FORBIDDEN', 'Portfolio not found or access denied'), 403);
  }
  c.set('portfolio', portfolio);
  await next();
});

router.post('', createAssetHandler);
router.get('', listAssetsHandler);
router.get('/:id', getAssetHandler);
router.patch('/:id', updateAssetHandler);
router.delete('/:id', deleteAssetHandler);

// In app.ts:
api.route('/portfolios/:portfolioId/assets', assetsRouter);
```

The middleware loads the portfolio once and attaches to context. Connected/manual rejection happens in the per-handler service code (not middleware) because GET allows both.

Sub-router root paths use empty-string convention (`router.post('', ...)`, `router.get('', ...)`).

### 1.8 Search by token slug in list endpoint

Per §0.3 mock-seam inventory: "Wallet token-detail load → `GET /portfolios/{portfolioId}/assets?slug=<tokenSlug>`." So the list endpoint accepts a `slug` query param to find a specific asset by its token's slug.

Add `?slug` as an optional query param. If provided, filter to assets whose `token.symbol.toLowerCase() === slug`. Symbol is the natural slug for tokens (lowercase symbol = slug). If not provided, return all assets.

For tokens, the "slug" is `symbol.toLowerCase()` (e.g., 'btc', 'eth'). This is simpler than computing slugs from names for tokens since symbols are short and unique.

When slug filter is used, the response still has the same shape but typically returns 0 or 1 asset.

## 2. Module scope

```
src/modules/assets/assets.controller.ts     # NEW — mounts at /api/v1/portfolios/:portfolioId/assets
src/modules/assets/assets.service.ts        # NEW — orchestration
src/modules/assets/assets.repository.ts     # NEW — Prisma queries
src/modules/assets/assets.schemas.ts        # NEW — Zod
src/modules/assets/assets.dto.ts            # NEW — toAssetDTO with derivation
src/modules/portfolios/derive.ts            # EDIT — actually sum totalValue from assets per §1.6
src/app.ts                                  # EDIT — mount /api/v1/portfolios/:portfolioId/assets
tests/assets.test.ts                        # NEW — ~18 tests
tests/portfolios.test.ts                    # NO EDIT — but verify existing portfolio tests still pass (totalValue=0 for empty portfolios, possibly non-zero for portfolios with assets)
```

Do NOT touch any other module directory.

## 3. Endpoints

### 3.1 `POST /portfolios/{portfolioId}/assets` — add token to portfolio

**`requireAuth` middleware + portfolio-ownership middleware required.** Body: `{ tokenId: positive int }` (Zod `.strict()`).

**Flow:**
1. Read `portfolio` from context. If `portfolio.type.name === 'connected'`: `403 CONNECTED_PORTFOLIO_READ_ONLY`.
2. Resolve `tokenId` → token row. Not found: `400 INVALID_TOKEN`.
3. Plan-rank check per §1.4. Free user adding rank > 10 → `403 PLAN_LIMIT_REACHED`.
4. Duplicate check: `prisma.asset.findUnique({ where: { portfolioId_tokenId: { portfolioId, tokenId } } })`. If exists: `409 ASSET_ALREADY_EXISTS`.
5. Insert Asset with `balance: 0`, `netDeposit: 0` (defaults).
6. Map through `toAssetDTO()`.
7. Respond: `201 { data: { asset: <AssetDTO> } }`.

### 3.2 `GET /portfolios/{portfolioId}/assets` — list assets

**`requireAuth` + portfolio-ownership middleware required.** Query: optional `?slug=<tokenSlug>`.

**Flow:**
1. Load all assets for the portfolio: `prisma.asset.findMany({ where: { portfolioId, ...(slug ? { token: { symbol: { equals: slug, mode: 'insensitive' } } } : {}) }, include: { token: true }, orderBy: { id: 'asc' } })`.
2. Compute portfolio totalValue (sum of value across ALL assets, not just filtered) for percentage calculations. Actually — load ALL assets unfiltered for the totalValue, then filter the response. Or accept that with slug filter, portfolioPercentage is shown relative to the FULL portfolio (not the filtered subset). The latter is correct UX.
3. Map each through `toAssetDTO(asset, portfolioTotalValue)`.
4. Respond: `200 { data: { assets: [...] } }`. No pagination (per-portfolio asset count is capped at 10/250+; the frontend can handle it).

### 3.3 `GET /portfolios/{portfolioId}/assets/{id}` — asset detail

**`requireAuth` + portfolio-ownership middleware required.**

**Flow:**
1. Load asset by id: `prisma.asset.findUnique({ where: { id }, include: { token: true } })`.
2. If not found OR `asset.portfolioId !== portfolio.id`: `404 ASSET_NOT_FOUND`. (Unlike the cross-user 403 pattern, this is intra-user — the user owns the portfolio; the asset just doesn't belong to it. 404 is correct here, no enumeration concern.)
3. Compute portfolio totalValue for percentage.
4. Map through `toAssetDTO(asset, portfolioTotalValue)`.
5. Respond: `200 { data: { asset: <AssetDTO> } }`.

### 3.4 `PATCH /portfolios/{portfolioId}/assets/{id}` — update netDeposit (manual only)

**`requireAuth` + portfolio-ownership middleware required.** Body per §1.3 (`netDeposit?` only).

**Flow:**
1. Read portfolio. If connected: `403 CONNECTED_PORTFOLIO_READ_ONLY`.
2. Validate body. Unknown field (including `balance`): `400 VALIDATION_ERROR`.
3. Load asset; if not found or wrong portfolio: `404 ASSET_NOT_FOUND`.
4. If body is empty: return current asset DTO with 200.
5. Otherwise: `prisma.asset.update({ where: { id }, data: { netDeposit } })`.
6. Compute portfolio totalValue, map through toAssetDTO.
7. Respond: `200 { data: { asset: <AssetDTO> } }`.

### 3.5 `DELETE /portfolios/{portfolioId}/assets/{id}` — remove asset (manual only)

**`requireAuth` + portfolio-ownership middleware required.**

**Flow:**
1. Read portfolio. If connected: `403 CONNECTED_PORTFOLIO_READ_ONLY`.
2. Load asset; if not found or wrong portfolio: `404 ASSET_NOT_FOUND`.
3. `prisma.asset.delete({ where: { id } })`. Schema cascades to NativeTransactionDetail / Erc20TransactionDetail / etc. via Transaction.portfolioId — but those don't exist yet (Stage 9). Empty cascade for now.
4. Respond: `200 { data: { ok: true } }`.

## 4. Cross-cutting wiring

### 4.1 Mount the nested assets router

In `src/app.ts`:
```ts
import { assetsRouter } from './modules/assets/assets.controller.js';
api.route('/portfolios/:portfolioId/assets', assetsRouter);
```

The order matters less than for top-level mounts since the path is distinct. Put it after `api.route('/portfolios', portfoliosRouter)` for readability.

### 4.2 Extend Stage 7's `derive.ts`

Per §1.6. Make `computeDerived(portfolio)` actually sum asset values. Remove `netDeposit` from `DerivedFields` if it was there (Stage 7 prompt said netDeposit is read from the column directly — verify this is already correct and adjust if not).

After the change: portfolios with no assets still return `totalValue: 0`; portfolios with assets return the actual sum. Stage 7's portfolio tests should still pass for empty portfolios.

### 4.3 Verify no Stage 7 test regressions

After the derive.ts extension, run the full suite. Stage 7's 35 portfolio tests should all still pass — most of them create empty portfolios where totalValue=0 still holds. If any test fails because it asserted totalValue=0 on a portfolio that now has assets attached, the test needs updating (or the test was creating a portfolio incidentally with assets — investigate).

### 4.4 The well-established patterns

- Sub-router root routes use empty-string (`router.post('', ...)`, not `'/'`).
- Per-test cleanup: `payment → subscription → asset → portfolio → session → user` (add `asset.deleteMany()` before portfolio in beforeEach).
- Email mock at the top of `tests/assets.test.ts` (same boilerplate as other tests).
- For Prisma transactions in handlers: lookups outside, `{ timeout: 15000 }`. Stage 8 doesn't need transactions but the pattern stays if it ever does.

## 5. Tests (Vitest, integration — new file `tests/assets.test.ts`)

Test numbering continues from Stage 7's final count (172 if Stage 7 landed there; check the actual count).

**Setup helpers**:
- `seedPortfolio(type, userId, opts)` — creates a manual or connected portfolio for the user.
- `addAssetDirectly(portfolioId, tokenId, opts)` — bypasses the API to seed assets with arbitrary balance/netDeposit (for testing derivation).

### POST /assets — 7 tests

173. **POST manual portfolio happy path** → 201; asset row created with balance=0, netDeposit=0; DTO has full derived shape.
174. **POST connected portfolio** → 403 `CONNECTED_PORTFOLIO_READ_ONLY`; no asset created.
175. **POST non-existent tokenId** → 400 `INVALID_TOKEN`.
176. **POST same tokenId twice** → 201 + 409 `ASSET_ALREADY_EXISTS`.
177. **POST as free user with rank-1 token (BTC)** → 201.
178. **POST as free user with rank-15 token (MATIC)** → 403 `PLAN_LIMIT_REACHED`; meta.tokenSymbol='MATIC', meta.requiredRank=10.
179. **POST as pro user with rank-30 token (MKR)** → 201 (no plan gate on Pro).
180. **POST with extra `balance` field** → 400 `VALIDATION_ERROR` (strict).

### GET list — 4 tests

181. **GET empty portfolio** → 200; assets=[].
182. **GET portfolio with 3 assets** → 200; 3 assets returned; portfolioPercentage sums to 100 (within rounding).
183. **GET with `?slug=btc` filter** → 200; only the BTC asset (or empty if not present); portfolioPercentage is relative to full portfolio, not filtered.
184. **GET connected portfolio's assets** → 200 (read allowed); same DTO shape.

### GET detail — 3 tests

185. **GET own asset by id** → 200; full AssetDTO with derived fields.
186. **GET asset that belongs to a different portfolio (wrong portfolioId in path)** → 404 `ASSET_NOT_FOUND`.
187. **GET non-existent asset id** → 404 `ASSET_NOT_FOUND`.

### PATCH — 3 tests

188. **PATCH manual portfolio asset netDeposit** → 200; netDeposit updated; pnlAllTimeValue recomputes.
189. **PATCH connected portfolio asset** → 403 `CONNECTED_PORTFOLIO_READ_ONLY`.
190. **PATCH with `balance` field** → 400 `VALIDATION_ERROR` (strict rejects balance).
191. **PATCH empty body** → 200 with current asset DTO; no DB write.

### DELETE — 2 tests

192. **DELETE manual portfolio asset** → 200; asset gone from DB.
193. **DELETE connected portfolio asset** → 403 `CONNECTED_PORTFOLIO_READ_ONLY`.

### Auth/portfolio-ownership — 3 tests

194. **All asset endpoints without auth** → 401.
195. **POST /assets on another user's portfolio** → 403 `FORBIDDEN`.
196. **GET /assets on non-existent portfolio** → 403 `FORBIDDEN`.

### derive.ts cascade — 1 test

197. **Portfolio totalValue reflects asset sum** → seed a manual portfolio with 2 assets (BTC balance 0.5, ETH balance 2.0); GET /portfolios/{id} returns totalValue = 0.5×93000 + 2.0×3200 = 52900 (using seeded prices).

That's 25 new tests. Total after Stage 8: 172 + 25 = **197 tests** (give or take depending on splits).

## 6. STOP-AND-ASK gates

1. **If the frontend's `AddAssetModal.svelte:132`** sends `{ tokenId, balance, priceAtAcq, ... }` and you find that strict-rejection breaks frontend integration tests (if any exist), STOP. The fix is on the frontend side (simplify to `{ tokenId }` only), but surface it before continuing.
2. **If `Token.currentPrice` returns null or zero for any seeded token**, STOP — the derived `value` would be 0 incorrectly. The 30-token seed should have currentPrice set for all; verify.
3. **If extending `derive.ts` regresses any of Stage 7's 35 portfolio tests**, STOP and investigate. Most of Stage 7's tests create empty portfolios; totalValue=0 should still hold. If a test fails because the portfolio incidentally has assets, the test needs updating.
4. **If `@@unique([portfolioId, tokenId])` doesn't catch the duplicate POST case** (test 176), check the Prisma query — it should be using `where: { portfolioId_tokenId: { portfolioId, tokenId } }` (the composite unique key access syntax).

## 7. What NOT to do

- **No `balance` setting via POST or PATCH.** Stage 9 transactions are the only legitimate balance source.
- **No price reading from Redis.** Stage 10 builds the price cache; Stage 8 reads `Token.currentPrice` directly.
- **No Moralis integration.** Stage 11 handles connected-portfolio sync.
- **No transaction creation from any asset endpoint.** Stage 9 has the transaction endpoints.
- **No new schema columns.** Asset schema is complete.
- **No new env vars.**
- **No `meta` field on the assets list response.** No pagination (small per-portfolio counts).
- **No cross-user data exposure.** Portfolio-ownership middleware blocks before service logic runs.
- **No `Asset.netDeposit` rollup into `Portfolio.netDeposit`.** They're conceptually different (per-asset cost basis vs portfolio baseline). Keep them independent.
- **No `npm audit fix`.**
- **No editing `docs/*.docx`.**

## 8. Commit and report

```bash
git add -A
git commit -m "feat(assets): Stage 8 — asset CRUD + connected read-only + token-rank plan gate + derive.ts extension for totalValue"
git log --oneline -5
```

Report:
- New commit SHA.
- One curl per endpoint (POST/GET/GET-detail/PATCH/DELETE), plus the connected-portfolio rejection path.
- Vitest output: all tests passing (count expected ~197+).
- Confirmation `derive.ts` now sums asset values into `totalValue` and that Stage 7's portfolio tests still pass.
- Confirmation `balance` is rejected in both POST and PATCH bodies.
- Confirmation connected portfolios reject POST/PATCH/DELETE but allow GET.
- Doc-fix pile items added in Stage 8:
  - Frontend `AddAssetModal.svelte:132` sends extra fields on asset creation (`balance`, `priceAtAcq`) — API rejects them; needs simplification or chained POST /transactions (Stage 9).
  - `Neonfi System Architecture.docx` Asset resource rep: clarify `balance` is derived from transactions, not stored mutable. Add note that POST body only accepts `tokenId`.
- Anything unexpected.

If blocked: output the question, stop, wait. Do not invent.
