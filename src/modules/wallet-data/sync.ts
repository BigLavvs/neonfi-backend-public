// Neonfi backend — connected-portfolio history import (retrofit-47/48, reworked retrofit-49).
//
// Runs ONCE at connect time (createPortfolio, connected branch), best-effort. retrofit-47
// seeded a single synthetic "opening" buy per held token, so every connected transaction
// showed the sync date with no hash/from/to/gas and a placeholder value. retrofit-49 replaces
// that with the wallet's REAL transfers:
//
//   1. Import the first page (~100) of real transfers (native + ERC-20 + NFT) with their REAL
//      block time, hash, from/to, gas, amount, and historical USD value (#3, #4) — these are
//      the activity FEED only; they no longer drive the balance.
//   2. Import current NFT holdings (which may predate the transfer window) AND NFT transfer
//      history (#2).
//   3. retrofit-58: set each Asset.balance DIRECTLY from the provider summary — the provider
//      already returns the wallet's correct current balances, so we trust them outright instead
//      of reconstructing from a windowed transfer set. Held tokens get their exact provider
//      balance; any existing asset absent from the summary is zeroed (sold out). This replaces
//      the retrofit-49 residual opening-lot reconcile, which left sold tokens NEGATIVE (never
//      seeded) and over-imported held tokens INFLATED (residual never trimmed) — see
//      retrofit-57. Cost-basis fields are cleared too: a windowed import can't yield a
//      trustworthy avgCost/netDeposit for a connected wallet, so connected PnL is computed
//      from recorded BalanceSnapshot deltas instead (retrofit-58 Part 2, derive.ts).
//   4. Persist the provider pagination cursor + total tx count for the "load more" endpoint
//      (#5, #8).
//
// The Moralis stream keeps the portfolio updated AFTER creation; this seeds the past. Every
// step is per-item best-effort — one bad token/transfer logs and continues, and the whole sync
// is wrapped by the caller so a failure still leaves the portfolio created.
//
// retrofit-48: token resolution is contract-first (the on-chain identity) with a symbol
// fallback; auto-listed rows carry `contractAddress` + `autoListed: true` so the
// connected-reprice job can refresh their (off-firehose) price by contract.

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../lib/config.js';
import { toDecimalString } from '../../lib/decimal.js';
import {
  invalidatePnlCache,
  createTransactionFromWebhook,
  createNftTransactionFromWebhook,
  TransactionError,
} from '../transactions/transactions.service.js';
import type { CreateTransactionBody } from '../transactions/transactions.schemas.js';
import { findPortfolioById } from '../portfolios/portfolios.repository.js';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import {
  fetchWalletSummary,
  fetchTransferPage,
  fetchNftHoldings,
  fetchSpamContracts,
  fetchWalletSpamContracts,
  fetchTransactionCount,
  fetchValueHistory,
  fetchWalletPnl,
} from './index.js';
import { classifyNftSpam } from './nft-spam.js';
import type { WalletNftHolding, WalletPnl, WalletTransfer } from './types.js';

// How many transfers to pull per page (initial sync + resync + each "load more").
// retrofit-74 (§2): 50 (was 100) — the initial sync seeds the latest 50 and each Pro "load more"
// pulls the next 50 via the stored cursor.
import { PAGE_LIMIT, importTransfers, importNftHoldings, resolveExternalTxCount, backfillConnectedSnapshots, rebuildConnectedHistory, resolveOrCreateToken, sumHistoricalTokenValue, type HistoricalTokenRow } from './sync.private.js';
export { rebuildConnectedHistory } from './sync.private.js';
export { sumHistoricalTokenValue, type HistoricalTokenRow } from './sync.private.js';

export type ConnectedCostMap = Map<number, { avgCost: number | null; realized: number }>;

const MAX_DECIMAL_20_8 = 999999999999.99999999;

// Signed Decimal(20,8) string — unlike toDecimalString (which clamps negatives to 0 for
// magnitudes), realizedPnl can be a real loss, so the sign must survive.
function signedDec8(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const clamped = Math.max(-MAX_DECIMAL_20_8, Math.min(MAX_DECIMAL_20_8, n));
  let s = clamped.toFixed(8);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

// retrofit-79 (§1): resolve the provider PnL list to a tokenId → cost-basis map for THIS
// portfolio. The PnL items are keyed by on-chain token_address, so we resolve each to a catalog
// tokenId via, in order: (1) a HELD token's summary (on-chain) contract — covers catalog rows
// whose stored contract drifted (e.g. a symbol-resolved auto-list); (2) an EXISTING portfolio
// asset's token contract — covers tokens already imported then sold out; (3) the catalog by
// contract — covers majors sold before the import window. A token that resolves to none (a
// non-catalog token fully exited before the window — we have no symbol to auto-list it, since
// the metadata subquery is too slow) is skipped. Items with neither a cost basis nor a non-zero
// realized PnL carry no information and are skipped. Returns null when there's nothing usable.
async function buildConnectedCostMap(
  portfolioId: number,
  held: HeldToken[],
  pnl: WalletPnl,
): Promise<ConnectedCostMap | null> {
  // tier 1: held by on-chain contract.
  const heldByContract = new Map<string, number>();
  for (const h of held) if (h.contractAddress) heldByContract.set(h.contractAddress, h.tokenId);

  // tier 2: existing portfolio assets by their catalog token contract.
  const existing = await prisma.asset.findMany({
    where: { portfolioId },
    select: { tokenId: true, token: { select: { contractAddress: true } } },
  });
  const existingByContract = new Map<string, number>();
  for (const a of existing) {
    if (a.token.contractAddress) existingByContract.set(a.token.contractAddress.toLowerCase(), a.tokenId);
  }

  const map: ConnectedCostMap = new Map();
  // First pass: resolve tier 1/2 in memory; defer contracts that still need the catalog lookup.
  const pending: Array<{ contract: string; avgCost: number | null; realized: number }> = [];
  for (const t of pnl.tokens) {
    const contract = t.contractAddress;
    if (!contract) continue;
    const hasInfo = t.avgCost != null || (t.realizedPnlUsd != null && Math.abs(t.realizedPnlUsd) > 1e-9);
    if (!hasInfo) continue;
    const tokenId = heldByContract.get(contract) ?? existingByContract.get(contract);
    const entry = { avgCost: t.avgCost, realized: t.realizedPnlUsd ?? 0 };
    if (tokenId != null) map.set(tokenId, entry);
    else pending.push({ contract, ...entry });
  }

  // tier 3 (perf #27/#39): ONE findMany for every still-unresolved contract instead of a
  // findFirst per token inside the loop. Catalog EVM contracts are stored lower-cased (same
  // assumption tier 2 above keys on), so match against a lower-cased `in` set.
  if (pending.length > 0) {
    const lowered = [...new Set(pending.map((p) => p.contract.toLowerCase()))];
    const rows = await prisma.token.findMany({
      where: { contractAddress: { in: lowered } },
      select: { id: true, contractAddress: true },
    });
    const idByContract = new Map<string, number>();
    for (const r of rows) if (r.contractAddress) idByContract.set(r.contractAddress.toLowerCase(), r.id);
    for (const p of pending) {
      const tokenId = idByContract.get(p.contract.toLowerCase());
      if (tokenId != null) map.set(tokenId, { avgCost: p.avgCost, realized: p.realized });
    }
  }
  return map.size > 0 ? map : null;
}

// retrofit-79 (§1): await the in-flight provider PnL fetch and resolve it to a cost map for this
// portfolio. undefined when no provider returned PnL (the portfolio stays cost-unknown → "—").
// Never throws — a PnL miss must not fail the sync.
async function resolveConnectedCostMap(
  portfolioId: number,
  held: HeldToken[],
  pnlPromise: Promise<WalletPnl | null>,
): Promise<ConnectedCostMap | undefined> {
  try {
    const pnl = await pnlPromise;
    if (!pnl) return undefined;
    return (await buildConnectedCostMap(portfolioId, held, pnl)) ?? undefined;
  } catch (e) {
    console.error('[wallet-sync] cost-map build failed', (e as Error).message);
    return undefined;
  }
}

// retrofit-58/79: set connected balances DIRECTLY from the provider summary — the authoritative
// current state. Each held token's Asset.balance becomes the provider's EXACT balance; any
// existing asset NOT in the summary (and not carrying provider PnL) is zeroed (sold out). This
// replaces the residual opening-lot reconcile, killing both failure modes retrofit-57 traced:
//   - NEGATIVE: a sold token (absent from the summary) is set to 0, never left negative.
//   - INFLATED: an over-imported held token is set to the provider balance, not the windowed sum.
//
// retrofit-79 (§1): `cost` carries the provider's per-token cost basis (GoldRush → Moralis).
//   - cost PRESENT: write avgCost/costBasis/realizedPnl per token (cost-unknown → null/0); a
//     cost-map token that isn't currently held becomes a balance-0 row carrying its realized PnL
//     (so the portfolio's all-time realized is honest). This REPLACES retrofit-58's blanket
//     clearing — connected PnL now uses the real cost-basis path (derive.ts), not snapshot deltas.
//   - cost ABSENT (webhook balance refresh / provider PnL miss): PRESERVE the existing cost fields
//     (only the balance is touched) so a frequent balance refresh can't wipe the cost basis a
//     prior sync wrote. netDeposit stays out of connected all-time, so it's left at 0.
// Idempotent. Returns the number of held tokens set (the resync "reconciled" count). Per-token
// best-effort — one failed upsert logs and continues.
export async function setConnectedBalancesFromSummary(
  portfolioId: number,
  held: HeldToken[],
  cost?: ConnectedCostMap,
): Promise<number> {
  const heldById = new Map(held.map((h) => [h.tokenId, h]));
  const ids = new Set<number>(heldById.keys());
  if (cost) for (const id of cost.keys()) ids.add(id);

  for (const tokenId of ids) {
    const h = heldById.get(tokenId);
    const balance = h ? h.balance : 0;
    try {
      if (cost) {
        const c = cost.get(tokenId);
        // avgCost only values currently-held units; a balance-0 (sold-out) row keeps null.
        const avgCost = c?.avgCost != null && balance > 0 ? c.avgCost : null;
        const costBasis = avgCost != null ? avgCost * balance : 0;
        const realized = c?.realized ?? 0;
        await prisma.asset.upsert({
          where: { portfolioId_tokenId: { portfolioId, tokenId } },
          update: {
            balance: toDecimalString(balance),
            avgCost: avgCost != null ? toDecimalString(avgCost) : null,
            costBasis: toDecimalString(costBasis),
            realizedPnl: signedDec8(realized),
            netDeposit: '0',
          },
          create: {
            portfolioId,
            tokenId,
            balance: toDecimalString(balance),
            avgCost: avgCost != null ? toDecimalString(avgCost) : null,
            costBasis: toDecimalString(costBasis),
            realizedPnl: signedDec8(realized),
          },
        });
      } else {
        // Balance-only refresh — preserve cost fields.
        await prisma.asset.upsert({
          where: { portfolioId_tokenId: { portfolioId, tokenId } },
          update: { balance: toDecimalString(balance) },
          create: { portfolioId, tokenId, balance: toDecimalString(balance) },
        });
      }
    } catch (e) {
      console.error('[wallet-sync] set-balance failed', { tokenId }, (e as Error).message);
    }
  }

  // Zero any existing asset the wallet no longer holds AND that carries no provider PnL.
  const existing = await prisma.asset.findMany({ where: { portfolioId }, select: { tokenId: true } });
  const toZero = existing.filter((a) => !ids.has(a.tokenId)).map((a) => a.tokenId);
  if (toZero.length > 0) {
    // With a cost map we own the cost fields → clear the sold-out row outright. Without one
    // (webhook), preserve cost fields and only zero the balance.
    await prisma.asset.updateMany({
      where: { portfolioId, tokenId: { in: toZero } },
      data: cost
        ? { balance: '0', avgCost: null, costBasis: '0', realizedPnl: '0', netDeposit: '0' }
        : { balance: '0' },
    });
  }

  return held.length;
}

// retrofit-59 §2: re-derive a connected portfolio's balances from the provider summary — a
// "balances-only mini-resync" the webhook calls AFTER appending an on-chain transfer to the
// feed. Live updates then reflect the REAL on-chain balance instead of recalc's windowed sum
// (which retrofit-59 §1 now skips for connected). Best-effort: any provider failure is logged
// and swallowed so the webhook's feed write stands and the balance refresh just defers to the
// next sync/resync. No-op for non-connected / address-less portfolios.
//
// PERF NOTE (per the plan): this fetches the FULL provider summary per balance-affecting
// webhook. Webhooks are infrequent, so that's fine for now; if it ever gets heavy, narrow it to
// the affected token's current balance. Not pre-optimized.
export async function refreshConnectedBalancesFromProvider(
  portfolio: PortfolioWithRelations,
): Promise<void> {
  if (portfolio.type.name !== 'connected' || !portfolio.walletAddress || !portfolio.chain) return;
  try {
    const summary = await fetchWalletSummary(portfolio.walletAddress, { slug: portfolio.chain.slug });
    const held = await resolveHeldTokens(summary);
    await setConnectedBalancesFromSummary(portfolio.id, held);
    await invalidatePnlCache(portfolio.id);
  } catch (e) {
    console.error(
      '[wallet-sync] webhook balance refresh failed',
      { portfolioId: portfolio.id },
      (e as Error).message,
    );
  }
}

interface HeldToken {
  tokenId: number;
  symbol: string;
  balance: number;
  usdPrice: number | null;
  // retrofit-79 (§1): the SUMMARY (on-chain) contract, lowercased — used to match provider
  // PnL items (keyed by on-chain token_address) back to this held token's catalog row, even
  // when the catalog row's stored contract has drifted (e.g. a symbol-resolved auto-list).
  contractAddress: string | null;
}

// Resolve/auto-list every held token from the provider summary (creating catalog rows with
// price/contract/logo) and return the held list. Done BEFORE importing transfers so a transfer
// for an auto-listed token resolves to a row that already carries the right price. Per-token
// best-effort — a token that can't be resolved (e.g. an over-long symbol) is logged & skipped.
export async function resolveHeldTokens(
  summary: Awaited<ReturnType<typeof fetchWalletSummary>>,
): Promise<HeldToken[]> {
  const held: HeldToken[] = [];
  for (const t of summary?.tokens ?? []) {
    if (!(t.balance > 0) || !t.symbol) continue;
    try {
      const token = await resolveOrCreateToken({
        symbol: t.symbol,
        name: t.name,
        contractAddress: t.contractAddress,
        usdPrice: t.usdPrice,
      });
      held.push({
        tokenId: token.id,
        symbol: token.symbol,
        balance: t.balance,
        usdPrice: t.usdPrice,
        contractAddress: t.contractAddress ? t.contractAddress.toLowerCase() : null,
      });
    } catch (e) {
      console.error('[wallet-sync] token resolve failed', { symbol: t.symbol }, (e as Error).message);
    }
  }
  return held;
}

export async function syncConnectedHoldings(
  portfolioId: number,
  address: string,
  chain: { slug: string },
): Promise<void> {
  // Need the full portfolio (type + chain) for the webhook-style transaction writes.
  const portfolio = await findPortfolioById(portfolioId);
  if (!portfolio) return;

  // retrofit-79 (§1): kick off the (slow, server-side-computed) provider PnL fetch up front so
  // it overlaps the transfer/NFT imports below instead of serializing before them. Best-effort —
  // a miss leaves the portfolio cost-unknown ("—"), never failing the sync.
  const pnlPromise = fetchWalletPnl(address, chain).catch(() => null);

  // Current balances (for reconciliation) + the first page of real history, in parallel.
  const [summary, page] = await Promise.all([
    fetchWalletSummary(address, chain),
    fetchTransferPage(address, chain, { limit: PAGE_LIMIT }),
  ]);

  // Pass 1: pre-resolve held tokens (so prices/contract/logo exist before import).
  const held = await resolveHeldTokens(summary);

  // Pass 2: import the real transfer history (native + erc20 + nft transactions + Nft rows).
  // These are the activity FEED — they no longer set the balance (Pass 4 does that).
  const transfers = page?.transfers ?? [];
  await importTransfers(portfolio, transfers);

  // Pass 3: import the wallet's current NFT holdings (may predate the transfer window).
  const nftHoldings = await fetchNftHoldings(address, chain);
  if (nftHoldings && nftHoldings.length > 0) await importNftHoldings(portfolio, nftHoldings);

  // Pass 4 (retrofit-58/79): set balances DIRECTLY from the provider summary, and write the
  // provider's per-token cost basis (so derive.ts uses the real cost-basis PnL path, not snapshot
  // deltas). Runs AFTER import so it overrides any balance the imported transactions left behind.
  const cost = await resolveConnectedCostMap(portfolioId, held, pnlPromise);
  await setConnectedBalancesFromSummary(portfolioId, held, cost);

  // Pass 5 (retrofit-56): the REAL on-chain tx count (the fixed total the overview consumes)
  // + a daily value-history backfill into BalanceSnapshot (the connected portion of the chart).
  // Both best-effort; a provider failure leaves the rest of the sync intact.
  const realTxCount = await resolveExternalTxCount(address, chain);
  await backfillConnectedSnapshots(portfolio, address, chain);

  // Pass 6: persist the cursor + the fixed real total for the "load more" endpoint (#5/#8).
  // externalTxCount prefers the real on-chain total, then the page total, else null.
  await prisma.portfolio.update({
    where: { id: portfolioId },
    data: {
      syncCursor: page?.nextCursor ?? null,
      externalTxCount: realTxCount ?? page?.totalCount ?? null,
    },
  });

  // Flush the derived PnL/analytics caches once after the whole sync.
  await invalidatePnlCache(portfolioId);
}

// retrofit-50: idempotent RESYNC for a connected portfolio (POST /portfolios/:id/resync).
// Catches transfers a missed/late webhook never delivered and re-sets the balance to on-chain
// truth. Reuses the retrofit-49 import path but every step is idempotent:
//   - Re-import the latest transfer page — dedupe on tx hash (the unique constraint makes
//     already-recorded transfers no-ops; only genuinely missed ones insert).
//   - Re-import current NFT holdings (upsert); the page's in/out NFT transfers also replay.
//   - retrofit-58: re-set each balance straight from the provider summary (Part 1), so running
//     resync twice in a row changes nothing AND the balance can never drift from on-chain.
// Best-effort throughout; returns { importedTransfers, reconciled } (reconciled = held tokens
// set from the summary). The "load more" cursor is intentionally left untouched (resync
// re-reads the newest page; older pages stay deduped).
export async function resyncConnectedHoldings(
  portfolioId: number,
  address: string | null,
  chain: { slug: string } | null,
): Promise<{ importedTransfers: number; reconciled: number }> {
  const portfolio = await findPortfolioById(portfolioId);
  if (!portfolio || !address || !chain) return { importedTransfers: 0, reconciled: 0 };

  // retrofit-79 (§1): resync is a deliberate user action → force a FRESH provider PnL fetch
  // (bypass the cache) so the cost basis reflects any new trades. Overlaps the imports below.
  const pnlPromise = fetchWalletPnl(address, chain, { bypassCache: true }).catch(() => null);

  const [summary, page] = await Promise.all([
    fetchWalletSummary(address, chain),
    fetchTransferPage(address, chain, { limit: PAGE_LIMIT }),
  ]);

  // Resolve held tokens (refreshes prices/contract/logo + the held list).
  const held = await resolveHeldTokens(summary);

  // Re-import the latest transfer page (missed transfers insert; recorded ones are no-ops).
  const transfers = page?.transfers ?? [];
  const importedTransfers = await importTransfers(portfolio, transfers);

  // Re-import current NFT holdings (upsert).
  const nftHoldings = await fetchNftHoldings(address, chain);
  if (nftHoldings && nftHoldings.length > 0) await importNftHoldings(portfolio, nftHoldings);

  // retrofit-58/79: re-set balances + provider cost basis (idempotent, never drifts).
  const cost = await resolveConnectedCostMap(portfolioId, held, pnlPromise);
  const reconciled = await setConnectedBalancesFromSummary(portfolioId, held, cost);

  // retrofit-56: refresh the REAL on-chain tx count. retrofit-60 C2: resync is INCREMENTAL —
  // only top up today's snapshot (the corrected current balance), never re-pull the multi-year
  // series or reset what the user already loaded.
  const realTxCount = await resolveExternalTxCount(address, chain);
  await backfillConnectedSnapshots(portfolio, address, chain, { fullHistory: false });

  // Refresh the provider total (keeps the overview count fresh); leave syncCursor alone.
  // Prefer the real on-chain total, then the page total.
  const externalTxCount = realTxCount ?? page?.totalCount ?? null;
  if (externalTxCount != null) {
    await prisma.portfolio.update({
      where: { id: portfolioId },
      data: { externalTxCount },
    });
  }

  await invalidatePnlCache(portfolioId);
  return { importedTransfers, reconciled };
}

// retrofit-49 §6: import the NEXT page of transfers for a connected portfolio (the frontend's
// "Load more"). Reads the stored cursor, imports the page exactly like the initial sync's
// transfer pass (same resolution/trim/dedupe), advances the cursor, and returns the count +
// the next cursor. A manual portfolio, a missing wallet, or a null cursor (no more / done) →
// { imported: 0, nextCursor: null }. NOTE: this does NOT re-reconcile the opening lot — older
// transfers are already folded into the residual seeded at connect time, so they appear in the
// activity feed without re-deriving the starting balance (a full re-reconcile is future work).
export async function importMoreTransfers(
  portfolioId: number,
): Promise<{ imported: number; nextCursor: string | null }> {
  const portfolio = await findPortfolioById(portfolioId);
  if (
    !portfolio ||
    portfolio.type.name !== 'connected' ||
    !portfolio.walletAddress ||
    !portfolio.chain ||
    !portfolio.syncCursor
  ) {
    return { imported: 0, nextCursor: null };
  }

  const page = await fetchTransferPage(
    portfolio.walletAddress,
    { slug: portfolio.chain.slug },
    { cursor: portfolio.syncCursor, limit: PAGE_LIMIT },
  );
  if (!page) {
    // Provider can't continue — clear the cursor so the UI stops offering "load more".
    await prisma.portfolio.update({ where: { id: portfolioId }, data: { syncCursor: null } });
    return { imported: 0, nextCursor: null };
  }

  const imported = await importTransfers(portfolio, page.transfers);
  await prisma.portfolio.update({
    where: { id: portfolioId },
    data: { syncCursor: page.nextCursor ?? null },
  });
  if (imported > 0) await invalidatePnlCache(portfolioId);
  return { imported, nextCursor: page.nextCursor ?? null };
}
