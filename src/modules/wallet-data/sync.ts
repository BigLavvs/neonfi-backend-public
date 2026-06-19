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
  fetchTransactionCount,
  fetchValueHistory,
} from './index.js';
import type { WalletNftHolding, WalletTransfer } from './types.js';

// How many transfers to pull per page (initial sync + each "load more").
const PAGE_LIMIT = 100;
// retrofit-60: how many days of daily value history to backfill into BalanceSnapshot on (re)sync.
// Up to ~3 years now that the one-call providers (Zerion/Mobula) reach multi-year in ONE call.
const VALUE_HISTORY_DAYS = 1095;
// retrofit-60: hard ceiling of Moralis `to_block` sample-points per wallet (the deep-tail / only-
// source fallback). Bounds the worst case — Moralis carrying the whole history — at ~50 calls.
const MAX_MORALIS_VALUE_SAMPLES = 50;

// Decimal(20,8) column scale for PRICES (kept at full 8-dp, unlike trimmed amounts).
function dec8(n: number): string {
  return n.toFixed(8);
}

interface TokenResolveInput {
  symbol: string;
  name: string | null;
  contractAddress: string | null;
  usdPrice: number | null;
  logoUrl?: string | null;
}

// Resolve a wallet token to its catalog row, auto-listing it when no row exists.
//
// `symbol` stays the UNIQUE catalog key (re-keying to (symbol, contract) is out of scope),
// so there is still exactly one row per ticker. `contractAddress` makes resolution PRECISE:
// we match on the on-chain identity first and only fall back to the ticker. retrofit-49 also
// backfills a missing `logoUrl` from the provider so transactions can render the token image.
async function resolveOrCreateToken(t: TokenResolveInput) {
  const symbol = t.symbol.toUpperCase();
  // Lower-case EVM contracts to match the wallet-validator's normalization; Solana mints are
  // case-sensitive but arrive already-normalized from the provider, so .toLowerCase() is a
  // no-op risk we accept here (native/Solana flows resolve by symbol anyway).
  const contract = t.contractAddress ? t.contractAddress.toLowerCase() : null;

  // 1. Resolve precisely — contract is the on-chain identity, so try it FIRST when present.
  let token =
    contract != null
      ? await prisma.token.findFirst({
          where: { contractAddress: { equals: contract, mode: 'insensitive' } },
        })
      : null;
  const matchedByContract = token != null;

  // Fall back to the symbol match (native tokens, with no contract, resolve here too).
  if (!token) {
    token = await prisma.token.findFirst({
      where: { symbol: { equals: t.symbol, mode: 'insensitive' } },
    });
  }

  if (token) {
    if (!matchedByContract && contract != null) {
      if (token.contractAddress == null) {
        // 2. Backfill the contract on a symbol match so future resolves are precise. (Only
        //    when the row has no contract yet — never overwrite a different one.)
        token = await prisma.token.update({
          where: { id: token.id },
          data: { contractAddress: contract },
        });
      } else if (token.contractAddress.toLowerCase() !== contract) {
        // 3. Genuine same-ticker / different-project collision. `symbol` is UNIQUE so we
        //    cannot create a second row — map the holding to the existing row (never drop)
        //    and log it. This is the documented limitation; the catalog re-key to
        //    (symbol, contractAddress) — which would touch the firehose, webhook, and
        //    transactions — is explicitly out of scope for this retrofit.
        console.warn('[wallet-sync] ticker collision', {
          symbol,
          existing: token.contractAddress,
          incoming: contract,
        });
      }
    }
    // retrofit-49: backfill a missing logo from the provider (never overwrite an existing one).
    if (token.logoUrl == null && t.logoUrl) {
      token = await prisma.token.update({ where: { id: token.id }, data: { logoUrl: t.logoUrl } });
    }
    return token;
  }

  // 4. Nothing matched → auto-list. autoListed:true marks the row for the connected-reprice
  //    job (it is NOT on the live exchange firehose, which subscribes by symbol to majors).
  //    LIVE-PRICING CAVEAT: until the reprice job runs, the value holds at the synced price.
  //    Guard the unique-symbol create against a concurrent same-symbol insert (across
  //    portfolios) — on P2002 re-resolve to the now-existing row.
  try {
    return await prisma.token.create({
      data: {
        symbol,
        name: t.name ?? t.symbol,
        currentPrice: t.usdPrice != null ? dec8(t.usdPrice) : '0',
        rank: null,
        logoUrl: t.logoUrl ?? null,
        autoListed: true,
        contractAddress: contract,
        // retrofit-71 (C4): an auto-listed wallet token's provider price is unverified until the
        // connected-reprice job cross-checks it against a canonical feed. Flag it now (no HTTP on
        // the connect path) so the UI can mark/exclude it rather than presenting it as fact.
        priceConfidence: 'unverified',
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const existing = await prisma.token.findFirst({
        where: { symbol: { equals: t.symbol, mode: 'insensitive' } },
      });
      if (existing) return existing;
    }
    throw e;
  }
}

function isDuplicateHash(e: unknown): boolean {
  return e instanceof TransactionError && e.code === 'TRANSACTION_HASH_DUPLICATE';
}

// Import one native/erc20 transfer as a real transaction. direction: in→buy, out→sell.
// amount/gas trimmed to Decimal(20,8); usdValue is the provider's HISTORICAL value at tx time
// (override). Returns true when a row was created, false when the hash was already imported
// (dedupe via the unique constraint — also how a multi-asset tx's extra legs collapse).
async function importFungibleTransfer(
  portfolio: PortfolioWithRelations,
  tr: WalletTransfer,
): Promise<boolean> {
  if (!tr.symbol) return false;
  const token = await resolveOrCreateToken({
    symbol: tr.symbol,
    name: tr.name,
    contractAddress: tr.contractAddress,
    usdPrice: null, // history carries no per-unit price; valuation comes from usdValue
    logoUrl: tr.logoUrl,
  });

  const direction = tr.direction === 'in' ? 'buy' : 'sell';
  const amount = toDecimalString(tr.amount);
  const gasFee = tr.gasFee != null ? toDecimalString(tr.gasFee) : null;

  const body: CreateTransactionBody =
    tr.type === 'native'
      ? {
          type: 'native',
          direction,
          amount,
          symbol: token.symbol,
          timestamp: tr.timestamp,
          ...(tr.hash ? { transactionHash: tr.hash } : {}),
          from: tr.from,
          to: tr.to,
          gasFee,
        }
      : {
          type: 'erc20',
          direction,
          amount,
          symbol: token.symbol,
          tokenContractAddress: tr.contractAddress ?? '',
          tokenName: tr.name ?? token.symbol,
          tokenSymbol: tr.symbol,
          timestamp: tr.timestamp,
          ...(tr.hash ? { transactionHash: tr.hash } : {}),
          from: tr.from,
          to: tr.to,
          gasFee,
        };

  try {
    await createTransactionFromWebhook({ portfolio, body, usdValueOverride: tr.usdValue });
    return true;
  } catch (e) {
    if (isDuplicateHash(e)) return false;
    throw e;
  }
}

// Import one NFT transfer: maintain the Nft holdings row (upsert on in, delete on out —
// both idempotent) AND record the transfer as an nft transaction (skip on duplicate hash).
async function importNftTransfer(
  portfolio: PortfolioWithRelations,
  tr: WalletTransfer,
): Promise<boolean> {
  const contract = (tr.contractAddress ?? '').toLowerCase();
  const tokenId = tr.nftTokenId ?? '';
  if (!contract || !tokenId) return false;
  const chainSlug = portfolio.chain?.slug ?? '';

  if (tr.direction === 'in') {
    await prisma.nft.upsert({
      where: {
        portfolioId_contractAddress_tokenId: { portfolioId: portfolio.id, contractAddress: contract, tokenId },
      },
      create: {
        portfolioId: portfolio.id,
        contractAddress: contract,
        tokenId,
        name: tr.name ?? null,
        description: tr.description ?? null,
        collectionName: tr.collectionName ?? null,
        logoUrl: tr.logoUrl ?? null,
        chain: chainSlug,
      },
      update: {
        ...(tr.logoUrl ? { logoUrl: tr.logoUrl } : {}),
        ...(tr.name ? { name: tr.name } : {}),
        ...(tr.description ? { description: tr.description } : {}),
      },
    });
  } else {
    await prisma.nft.deleteMany({
      where: { portfolioId: portfolio.id, contractAddress: contract, tokenId },
    });
  }

  try {
    await createNftTransactionFromWebhook({
      portfolio,
      body: {
        direction: tr.direction === 'in' ? 'buy' : 'sell',
        tokenContractAddress: contract,
        nftTokenId: tokenId,
        ...(tr.name ? { nftName: tr.name } : {}),
        ...(tr.collectionName ? { collectionName: tr.collectionName } : {}),
        timestamp: tr.timestamp,
        ...(tr.hash ? { transactionHash: tr.hash } : {}),
        from: tr.from,
        to: tr.to,
        gasFee: tr.gasFee != null ? toDecimalString(tr.gasFee) : null,
      },
    });
    return true;
  } catch (e) {
    if (isDuplicateHash(e)) return false;
    throw e;
  }
}

// Import a page of transfers oldest→newest (so balances build forward). Per-item best-effort.
// Returns the number of transactions actually created (excludes duplicates/errors).
async function importTransfers(
  portfolio: PortfolioWithRelations,
  transfers: WalletTransfer[],
): Promise<number> {
  // The provider returns DESC (newest first); replay oldest→newest.
  const ordered = [...transfers].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  let imported = 0;
  for (const tr of ordered) {
    try {
      const did =
        tr.type === 'nft'
          ? await importNftTransfer(portfolio, tr)
          : await importFungibleTransfer(portfolio, tr);
      if (did) imported += 1;
    } catch (e) {
      console.error('[wallet-sync] transfer import failed', { hash: tr.hash, type: tr.type }, (e as Error).message);
    }
  }
  return imported;
}

// Upsert the wallet's CURRENT NFT holdings (predating the transfer window). Per-item best-effort.
async function importNftHoldings(
  portfolio: PortfolioWithRelations,
  holdings: WalletNftHolding[],
): Promise<void> {
  const chainSlug = portfolio.chain?.slug ?? '';
  for (const h of holdings) {
    try {
      await prisma.nft.upsert({
        where: {
          portfolioId_contractAddress_tokenId: {
            portfolioId: portfolio.id,
            contractAddress: h.contractAddress,
            tokenId: h.tokenId,
          },
        },
        create: {
          portfolioId: portfolio.id,
          contractAddress: h.contractAddress,
          tokenId: h.tokenId,
          name: h.name,
          description: h.description,
          collectionName: h.collectionName,
          logoUrl: h.logoUrl,
          chain: chainSlug,
          tokenStandard: h.tokenStandard,
        },
        update: {
          ...(h.logoUrl ? { logoUrl: h.logoUrl } : {}),
          ...(h.name ? { name: h.name } : {}),
          ...(h.description ? { description: h.description } : {}),
        },
      });
    } catch (e) {
      console.error('[wallet-sync] nft holding import failed', { contract: h.contractAddress, tokenId: h.tokenId }, (e as Error).message);
    }
  }
}

// retrofit-56: resolve the wallet's REAL on-chain tx total (GoldRush transactions_summary).
// Connected portfolios import only a window of transactions, so the DB row count
// under-reports; this fixed real total is what the overview count consumes. Best-effort:
// null on any failure → the caller leaves externalTxCount unchanged (falls back to the page
// total, then the DB row count). Never throws.
async function resolveExternalTxCount(
  address: string,
  chain: { slug: string },
): Promise<number | null> {
  try {
    return await fetchTransactionCount(address, chain);
  } catch (e) {
    console.error('[wallet-sync] tx-count fetch failed', (e as Error).message);
    return null;
  }
}

// retrofit-60: the corrected CURRENT value = Σ(Asset.balance × Token.currentPrice), read fresh
// from the DB (the balances setConnectedBalancesFromSummary just wrote — cache-immune). This is
// the value the chart's right edge is stitched to, so it equals the headline (no drift).
async function currentConnectedValue(portfolioId: number): Promise<number> {
  const assets = await prisma.asset.findMany({ where: { portfolioId }, include: { token: true } });
  let total = 0;
  for (const a of assets) total += Number(a.balance.toString()) * Number(a.token.currentPrice.toString());
  return total;
}

// retrofit-60: bounded Moralis `to_block` value-history sampler — the deep-tail / only-source
// FALLBACK used when no priced one-call provider (Zerion/Mobula/GoldRush) serves the wallet, or to
// extend an older gap a one-call series doesn't reach. Samples ≤ `maxSamples` evenly-spaced dates
// in [fromMs, toMs): dateToBlock → tokens?to_block → Σ usd_value. Bounded so even "Moralis carries
// the whole history" is ~50 calls, one-time.
//
// CAVEAT (r60 probe): Moralis to_block USD is ~CURRENT-priced, NOT historical — so this fallback's
// older values are APPROXIMATE (historical balance × ~today's price). A true historical-price
// source is the held retrofit-58 Part 5b work; until then the EXACT path is the one-call providers
// above, and this only runs when they all fail. Best-effort: each failed sample is skipped.
async function sampleMoralisValueHistory(
  address: string,
  chainSlug: string,
  chainHex: string,
  fromMs: number,
  toMs: number,
  maxSamples: number,
): Promise<Array<{ date: string; value: number }>> {
  if (!config.MORALIS_API_KEY || toMs <= fromMs || maxSamples <= 0) return [];
  const headers = { 'X-API-Key': config.MORALIS_API_KEY };
  const base = config.MORALIS_DEEP_INDEX_BASE;
  const out: Array<{ date: string; value: number }> = [];
  const span = toMs - fromMs;
  const n = Math.min(maxSamples, Math.max(1, Math.floor(span / (86400 * 1000)))); // ≤ 1/day, ≤ cap
  for (let i = 0; i < n; i++) {
    const ts = fromMs + Math.floor((span * i) / n);
    const iso = new Date(ts).toISOString();
    try {
      const d2b = await fetch(`${base}/dateToBlock?chain=${chainSlug}&date=${encodeURIComponent(iso)}`, { headers });
      if (!d2b.ok) continue;
      const block = ((await d2b.json()) as { block?: number }).block;
      if (!block) continue;
      const tk = await fetch(`${base}/wallets/${address}/tokens?chain=${chainHex}&to_block=${block}`, { headers });
      if (!tk.ok) continue;
      const rows = ((await tk.json()) as { result?: Array<{ usd_value?: number | null }> }).result ?? [];
      const value = rows.reduce((s, r) => s + (r.usd_value != null ? Number(r.usd_value) : 0), 0);
      // retrofit-67: skip $0 samples (the wallet held nothing yet at that block) so we never
      // persist leading pre-funding zeros. The leading-zero trim in buildConnectedValueHistory
      // is the real fix; this just keeps the sampled tail clean at the source.
      if (value > 0) out.push({ date: iso.slice(0, 10), value });
    } catch (e) {
      console.error('[wallet-sync] moralis value-history sample failed', { iso }, (e as Error).message);
    }
  }
  return out;
}

// retrofit-60: compose the connected value-history series for the target window. Prefers the
// deepest ONE-CALL priced provider (Zerion → Mobula → GoldRush, via fetchValueHistory); if that
// series doesn't reach the window start, fills the older gap with the bounded Moralis sampler and
// stitches; finally pins TODAY's point to the corrected current balance so the chart's right edge
// equals the headline. Empty result → caller writes nothing (the chart builds forward via the
// daily snapshot job — the "found_no_history" outcome).
async function buildConnectedValueHistory(
  portfolio: PortfolioWithRelations,
  address: string,
  chain: { slug: string },
  days: number,
): Promise<Array<{ date: string; value: number }>> {
  const currentValue = await currentConnectedValue(portfolio.id);

  // 1. Deepest priced one-call series.
  let series = (await fetchValueHistory(address, chain, days)) ?? [];

  // 2. Tail-fill the older gap (>1 week before the priced series' earliest point) with the
  //    bounded Moralis sampler. When the priced series is empty, this covers the whole window.
  const windowStartMs = Date.now() - days * 86400 * 1000;
  const earliestMs = series.length > 0 ? Date.parse(`${series[0]!.date}T00:00:00.000Z`) : Date.now();
  if (earliestMs > windowStartMs + 7 * 86400 * 1000) {
    const tail = await sampleMoralisValueHistory(
      address,
      chain.slug,
      portfolio.chain?.moralisId ?? '0x1',
      windowStartMs,
      earliestMs,
      MAX_MORALIS_VALUE_SAMPLES,
    );
    series = [...tail, ...series];
  }

  // 3. Stitch today's point to the corrected current balance (right edge = headline).
  const today = new Date().toISOString().slice(0, 10);
  const byDate = new Map<string, number>();
  for (const p of series) byDate.set(p.date, p.value);
  byDate.set(today, currentValue);

  // retrofit-67: trim the LEADING run of $0 points — the period before the wallet was first
  // funded. Charting them dates the line back to the window start (the flat June-2025 tail).
  // Interior zeros are kept (a wallet drained mid-history is real); if every point is 0 (a
  // genuinely empty wallet) return [] — the caller already writes nothing in that case.
  const sorted = [...byDate.entries()]
    .filter(([d]) => d <= today)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, value]) => ({ date, value }));
  const firstNonZero = sorted.findIndex((p) => p.value > 0);
  if (firstNonZero === -1) return [];
  return firstNonZero === 0 ? sorted : sorted.slice(firstNonZero);
}

// retrofit-56/60: backfill daily portfolio value into BalanceSnapshot. The historical points come
// from buildConnectedValueHistory (one-call provider + bounded Moralis tail). Historical dates are
// CREATE-ONLY (createMany skipDuplicates on the composite PK) so a re-sync writes nothing new and
// the daily job's rows are never clobbered; TODAY is UPSERTED to the corrected current balance so
// the chart's right edge always equals the headline (retrofit-60 stitch). Best-effort.
//
// retrofit-60 C2: the multi-year backfill is ONE-TIME (initial sync, fullHistory=true). Resync
// passes fullHistory=false → it only tops up TODAY's point (the corrected current balance), never
// re-pulling the whole multi-year series or resetting what the user already loaded.
async function backfillConnectedSnapshots(
  portfolio: PortfolioWithRelations,
  address: string,
  chain: { slug: string },
  opts: { fullHistory?: boolean } = {},
): Promise<void> {
  const fullHistory = opts.fullHistory ?? true;
  try {
    const dayMs = (d: string) => new Date(`${d}T00:00:00.000Z`);
    const today = new Date().toISOString().slice(0, 10);

    // Resync (incremental): only refresh today's right edge — no multi-year re-pull.
    if (!fullHistory) {
      const value = await currentConnectedValue(portfolio.id);
      await prisma.balanceSnapshot.upsert({
        where: { portfolioId_snapshotDate: { portfolioId: portfolio.id, snapshotDate: dayMs(today) } },
        create: { portfolioId: portfolio.id, userId: portfolio.userId, snapshotDate: dayMs(today), value: toDecimalString(value) },
        update: { value: toDecimalString(value) },
      });
      return;
    }

    const series = await buildConnectedValueHistory(portfolio, address, chain, VALUE_HISTORY_DAYS);
    if (series.length === 0) return;

    const historical = series.filter((p) => p.date < today);
    if (historical.length > 0) {
      await prisma.balanceSnapshot.createMany({
        data: historical.map(({ date, value }) => ({
          portfolioId: portfolio.id,
          userId: portfolio.userId,
          snapshotDate: dayMs(date),
          value: toDecimalString(value),
        })),
        skipDuplicates: true,
      });
    }

    const todayPoint = series.find((p) => p.date === today);
    if (todayPoint) {
      await prisma.balanceSnapshot.upsert({
        where: { portfolioId_snapshotDate: { portfolioId: portfolio.id, snapshotDate: dayMs(today) } },
        create: {
          portfolioId: portfolio.id,
          userId: portfolio.userId,
          snapshotDate: dayMs(today),
          value: toDecimalString(todayPoint.value),
        },
        update: { value: toDecimalString(todayPoint.value) },
      });
    }
  } catch (e) {
    console.error('[wallet-sync] connected snapshot backfill failed', (e as Error).message);
  }
}

// retrofit-58: set connected balances DIRECTLY from the provider summary — the authoritative
// current state. Each held token's Asset.balance becomes the provider's EXACT balance; any
// existing asset NOT in the summary is zeroed (the wallet sold out of it). This replaces the
// residual opening-lot reconcile, killing both failure modes retrofit-57 traced:
//   - NEGATIVE: a sold token (absent from the summary) is set to 0, never left negative.
//   - INFLATED: an over-imported held token is set to the provider balance, not the windowed sum.
// Cost-basis fields (avgCost/costBasis/realizedPnl/netDeposit) are cleared: a windowed transfer
// import can't yield a trustworthy cost basis for a connected wallet, so connected PnL is derived
// from recorded BalanceSnapshot deltas instead (Part 2). The imported transactions remain as the
// activity feed; they simply no longer drive the balance. Idempotent (a resync re-sets the same
// values). Returns the number of held tokens set (the resync "reconciled" count). Per-token
// best-effort — one failed upsert logs and continues.
export async function setConnectedBalancesFromSummary(
  portfolioId: number,
  held: HeldToken[],
): Promise<number> {
  const heldTokenIds = new Set(held.map((h) => h.tokenId));

  for (const h of held) {
    try {
      await prisma.asset.upsert({
        where: { portfolioId_tokenId: { portfolioId, tokenId: h.tokenId } },
        update: {
          balance: toDecimalString(h.balance),
          avgCost: null,
          costBasis: '0',
          realizedPnl: '0',
          netDeposit: '0',
        },
        create: {
          portfolioId,
          tokenId: h.tokenId,
          balance: toDecimalString(h.balance),
        },
      });
    } catch (e) {
      console.error('[wallet-sync] set-balance failed', { symbol: h.symbol }, (e as Error).message);
    }
  }

  // Zero any existing asset the wallet no longer holds (absent from the provider summary).
  const existing = await prisma.asset.findMany({
    where: { portfolioId },
    select: { tokenId: true },
  });
  const toZero = existing.filter((a) => !heldTokenIds.has(a.tokenId)).map((a) => a.tokenId);
  if (toZero.length > 0) {
    await prisma.asset.updateMany({
      where: { portfolioId, tokenId: { in: toZero } },
      data: { balance: '0', avgCost: null, costBasis: '0', realizedPnl: '0', netDeposit: '0' },
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
      held.push({ tokenId: token.id, symbol: token.symbol, balance: t.balance, usdPrice: t.usdPrice });
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

  // Pass 4 (retrofit-58): set balances DIRECTLY from the provider summary — the authoritative
  // current state (no reconstruction). Runs AFTER import so it overrides any balance the
  // imported transactions' recalc left behind.
  await setConnectedBalancesFromSummary(portfolioId, held);

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

  // retrofit-58: re-set balances straight from the provider summary (idempotent, never drifts).
  const reconciled = await setConnectedBalancesFromSummary(portfolioId, held);

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
