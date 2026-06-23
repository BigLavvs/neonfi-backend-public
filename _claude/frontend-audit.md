# Neonfi — Frontend ⇄ Backend contract audit (complete)

Full sweep of every frontend consumer against the built backend (post-`b933283`) and the
canonical docs. Each row cites **frontend file:line ↔ backend file:line / schema**. Resolution
column is a *recommendation* for triage — per Build Guide §0.1, the architecture/schema win on
contract shape, so most renames fall on the frontend; genuine product gaps are marked for a call.

Legend: **[FE]** frontend moves to match the contract · **[BE]** backend gap to build · **[?]** product decision.

## 0. Files read

**Frontend consumers:** `lib/endpoints.ts`, `lib/api.ts`, `lib/ws.ts`, `hooks.server.ts`,
`routes/(dashboard)/{dashboard,performance,payments,settings,wallet}` loads + `wallet/[portfolioSlug]/[tokenSlug]/+page.ts`,
`routes/(onboarding)/onboarding/+page.{ts,svelte}`, `routes/(public)/register/+page.svelte`,
modals `{AddAsset,AddTransaction,NewPortfolio,RefundConfirm,LogoutConfirm,ManagePortfolios,DeleteAsset,TxDetail,NftDetail}.svelte`.

**Backend:** `app.ts:34-61` (route tree), `{portfolios,assets,transactions,auth,users,payments,prices,tokens}.schemas.ts`,
`users.repository.ts:60-68` (+ `users.contract.ts` Gates C/D), `subscriptions.service.ts:383-416`,
`payments.dto.ts`, `nfts.dto.ts`, `prisma/schema.prisma`.

## 1. Wire-shape mismatches

| # | Area | Frontend sends/expects | Backend contract | Fix |
|---|---|---|---|---|
| 1 | `POST /portfolios` connected | `{type, name, address, chainId}` — onboarding `+page.svelte:112` (NewPortfolioModal local var is already `walletAddress`, :56) | `{type, name, walletAddress, chainId}` `.strict()` — portfolios.schemas.ts:3-8 | **[FE]** `address`→`walletAddress` |
| 2 | `POST /portfolios` manual | `{type, name, assets[]}` — onboarding `+page.svelte:204`, NewPortfolioModal `addedAssets` :82-89 | `{type, name, startingBalance?}` `.strict()` — portfolios.schemas.ts:10-14 (assets added separately) | **[?]** atomic `assets[]` vs N+1 (see §3.7) |
| 3 | `PATCH /users/me` | `{name, displayName}` — settings `+page.svelte:65` | `{fullName?, displayName?, avatarUrl?, newsletterSubscribed?}` — users.schemas.ts:17 | **[FE]** `name`→`fullName` |
| 4 | `POST /auth/register` | `{name, email, password}` — register `+page.svelte:12,170` | `{email, password, fullName, displayName?}` — auth.schemas.ts:16-21 (fullName required) | **[FE]** `name`→`fullName` |
| 5 | `POST /portfolios/:id/assets` | `{amount, price, date, notes}` — AddAssetModal :105-108 | `{tokenId}` `.strict()` — assets.schemas.ts:3-5 (balance derived from txns) | **[FE]** + **[?]** notes/date/price (§3.4) |
| 6 | `POST /portfolios/:id/transactions` | `txType: buy/sell/transfer` + `priceAtTime` + `notes`; no `type`, no erc20 contract fields — AddTransactionModal :62,124,128 | requires `type: native/erc20/nft` **and** `direction` **and** erc20 `{tokenContractAddress,tokenName,tokenSymbol}`, `.strict()` — transactions.schemas.ts:16-52 | **[FE]** collect `type`+contract fields; **[?]** notes/priceAtTime (§3.5) |
| 7 | Payment `amount` | dollars — RefundConfirmModal `.toFixed(2)` :54, payments `+page.ts:13,21` | integer **cents** (Int) — payments.dto.ts:32, schema.prisma:181 | **[FE]** divide by 100 for display |
| 8 | NFT detail | `collection`, `blockchain`, `owner` — NftDetailModal :7,12,? | `collectionName`, `chain`, **no owner** — nfts.dto.ts:9,11; schema.prisma Nft has no owner | **[FE]** rename; **[?]** `owner` (§3.6) |

## 2. Phantom endpoints (frontend names them; backend has no route — app.ts:34-61)

| Frontend ref | Reality | Fix |
|---|---|---|
| `POST /subscriptions/checkout` — onboarding :51, payments :48, endpoints.ts:20 | Real flow is `POST /subscriptions` (Free activates; Pro returns Stripe URL) + `/upgrade` — architecture Stage 3 | **[FE]** use real endpoints |
| `POST /assets` (top-level) — AddAssetModal :132, endpoints.ts:18 | Nested `POST /portfolios/:id/assets` exists | **[FE]** use nested |
| `POST /transactions` (top-level) — AddTransactionModal :200, endpoints.ts:19 | Nested `POST /portfolios/:id/transactions` exists | **[FE]** use nested |
| `POST /auth/password-reset` — settings :81, endpoints.ts:6 | Not built; not in architecture's auth endpoint set | **[?]** build vs defer (§3.2) |
| `DELETE /users/me` — settings :99 | Not built; "delete account" *is* in Build Guide Stage 2 scope | **[?]** build vs defer (§3.1) |
| `PATCH /users/preferences` — settings :126, endpoints.ts:9 | Not built; only `newsletterSubscribed` has a column | **[?]** scope to newsletter vs build (§3.3) |

## 3. Product decisions (need your call)

- **3.1 Account deletion** (`DELETE /users/me`). In Build Guide Stage 2 scope; no endpoint. Build (cascade-delete user; Payment.userId already `SetNull` to preserve history) or defer + hide the Danger Zone?
- **3.2 Password reset** (`POST /auth/password-reset`, email users). Not in the architecture auth set (register/login/logout/verify/resend/refresh). Build (token + email template + reset endpoint) or defer + hide?
- **3.3 Notification prefs.** Only `newsletterSubscribed` is a column; `priceAlerts`/`push`/base-currency have none. Scope `PATCH /users/me { newsletterSubscribed }` for the newsletter toggle and treat the rest as client-only/post-MVP, or add columns + a prefs endpoint (schema change)?
- **3.4 Asset acquisition fields** (`notes`, `date`, `price-at-acquisition`). No Asset columns; balance is derived from transactions. Drop from the UI (manual assets are seeded by a txn), or add columns (schema change, diverges from the Asset rep)?
- **3.5 Transaction `notes` + historical `priceAtTime`.** No `notes` column; `usdValue` uses current price at write-time (locked Option a). Add a `notes` column? Keep `priceAtTime` as post-MVP (current-price stands)?
- **3.6 NFT `owner`.** Frontend detail shows an owner; Nft has no owner column (it's the connected wallet by definition). Drop the field, or derive it from the portfolio's `walletAddress`?
- **3.7 Atomic manual portfolio + assets.** Backend manual create is `{type,name}`; assets are separate POSTs. Accept an optional `assets[]` on `POST /portfolios` (one transaction), or have the frontend create the portfolio then POST each asset (N+1)?
- **3.8 Cross-portfolio transfer** (AddTransactionModal `destPortoId` :137,194). No backend concept — `direction:'transfer'` only recalcs one portfolio. Drop the "transfer to another portfolio" sub-mode (keep address transfer), or build paired-transaction support (larger)?

## 4. `ENDPOINTS` const cleanup (endpoints.ts)

- **Phantom entries to remove/repoint:** `auth.passwordReset`, `users.preferences`, `assets:'/assets'`, `transactions:'/transactions'`, `subscriptions.checkout`.
- **Missing real endpoints to add:** `auth.login`, `auth.verifyEmail`, `subscriptions.upgrade`, `subscriptions.downgrade`, `portfolios.snapshots(id)`, `analytics.performance(id)`, `analytics.holdings(id)`.
- **Hardcoded data to replace with live calls:** `NewPortfolioModal:13` chains `['ETH','BTC','SOL','BNB','MATIC','ARB','OP']` (BTC isn't a chain; names ≠ backend slugs) → `GET /chains`; 10-token mock lists in `NewPortfolioModal:20`, `AddAssetModal:45`, `AddTransactionModal:47` → `GET /tokens`.

## 5. Confirmed matches (NOT issues — for the record)

- `POST /subscriptions/refund` **accepts `{reason}`** — subscriptions.service.ts:414-416 ↔ RefundConfirmModal:23. ✓
- `PATCH /portfolios/:id` accepts `{name}` — portfolios.schemas.ts:30 ↔ ManagePortfolios:41 / settings:146. ✓
- `GET /users/me` returns `fullName`/`displayName`/`authProvider`/`plan`/`emailVerified` — users.repository.ts:60-68; the `name??displayName` fallback (hooks.server.ts:61) is the intended Gate C behavior. ✓
- Endpoints `auth.logout`, `subscriptions.{me,cancel,refund}`, `GET /payments` all exist — those TODOs are just unwired, not mismatches. ✓
- WS `price_update.payload{symbol,price,change24h}` ↔ ws.ts:51-52. ✓

## 6. Proposed commits (after triage)

1. **Frontend renames** (no backend change): #1,3,4,7,8 + §2 nested/real endpoints + §4 const cleanup + live chains/tokens.
2. **Backend gaps** (only the ones you greenlight in §3): e.g. `DELETE /users/me`, `POST /auth/password-reset`, newsletter via `PATCH /users/me`.
3. **Atomic create / tx-shape** (#2,#6): backend `assets[]` option + frontend tx `type`/contract capture, if chosen.
4. **Schema-touching product features** (§3.4/3.5 notes/date/price), only if you want them in MVP.
