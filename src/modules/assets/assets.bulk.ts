// Neonfi backend — CSV bulk import for MANUAL portfolio STARTING ASSETS (retrofit-87).
//
// POST /portfolios/:id/assets/bulk. Mirror of addAsset (assets.service) over many rows: each
// CSV row { symbol, quantity, costPerUnit?, acquiredDate? } becomes an OPENING position whose
// cost mode is DERIVED from the column combo (avg / historical / none), resolved + written with
// the SAME logic the single create uses so an imported opening is identical to one added via the
// Starting-Assets editor (balance, avgCost, costBasis, netDeposit all reconcile).
//
// Parity: each prepared row is re-parsed through CreateAssetBodySchema (the exact single-create
// Zod) and the same guards apply — quantity > 0, plan-rank cap for free users, a `historical`
// row needs a price snapshot on/before its date (PRICE_HISTORY_UNAVAILABLE otherwise), and a
// second opening for a symbol already held in the portfolio errors (DUPLICATE_OPENING) rather
// than silently overwriting. Tokens are NEVER auto-created from a CSV.

import { prisma } from '../../lib/prisma.js';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import { getEffectivePlan } from '../subscriptions/subscriptions.service.js';
import { invalidatePnlCache } from '../transactions/transactions.service.js';
import { recalcAssetBalance, recalcPortfolioNetDeposit } from '../transactions/recalc.js';
import { findTokenPriceSnapshotOnOrBefore } from '../tokens/tokens.repository.js';
import { fetchHistoricalPriceUsd } from '../../lib/historical-price.js';
import { CreateAssetBodySchema, type BulkAssetsBody } from './assets.schemas.js';
import {
  BulkError,
  BULK_ROW_CAP,
  cellStr,
  dateCellError,
  normalizeSymbol,
  numberCellError,
  ymdToIso,
  type BulkResult,
  type BulkRowError,
} from '../../lib/bulk-import.js';

// A Zod issue on the rebuilt asset body → the CSV column. The human validators own the common
// cases; this only fires for something they missed (parity safety net).
function zodPathToAssetColumn(path: ReadonlyArray<string | number>): string | null {
  switch (String(path[0] ?? '')) {
    case 'balance':
      return 'quantity';
    case 'cost':
      // cost.avgCost → cost_per_unit, cost.date → acquired_date
      return String(path[1] ?? '') === 'date' ? 'acquired_date' : 'cost_per_unit';
    case 'tokenId':
      return 'symbol';
    default:
      return null;
  }
}

interface PreparedAssetRow {
  row: number;
  tokenId: number;
  balance: string;
  openingCostBasis: string | null;
  openingAt: Date | null;
}

export async function bulkCreateAssets(
  userId: number,
  portfolio: PortfolioWithRelations,
  body: BulkAssetsBody,
): Promise<BulkResult> {
  if (portfolio.type.name !== 'manual') {
    throw new BulkError(400, 'NOT_MANUAL', 'CSV import is only available for manual portfolios');
  }
  if (body.rows.length > BULK_ROW_CAP) {
    throw new BulkError(400, 'TOO_MANY_ROWS', `At most ${BULK_ROW_CAP} rows per import`);
  }

  const wantedSymbols = [
    ...new Set(body.rows.map((r) => normalizeSymbol(cellStr(r, 'symbol'))).filter(Boolean)),
  ];
  const [tokenRows, assetRows, effectivePlan] = await Promise.all([
    wantedSymbols.length
      ? prisma.token.findMany({
          where: { symbol: { in: wantedSymbols } },
          select: { id: true, symbol: true, rank: true },
        })
      : Promise.resolve([] as Array<{ id: number; symbol: string; rank: number | null }>),
    prisma.asset.findMany({ where: { portfolioId: portfolio.id }, select: { tokenId: true } }),
    getEffectivePlan(userId),
  ]);

  const tokenBySymbol = new Map(tokenRows.map((t) => [t.symbol, t]));
  const existingTokens = new Set(assetRows.map((a) => a.tokenId));
  const seenTokens = new Set<number>(); // within-batch dedup (DUPLICATE_OPENING)

  const errors: BulkRowError[] = [];
  const prepared: PreparedAssetRow[] = [];

  for (let i = 0; i < body.rows.length; i++) {
    const raw = body.rows[i];
    if (!raw) continue;
    const row = i + 1;
    const before = errors.length;
    const add = (column: string | null, message: string): void => {
      errors.push({ row, column, message });
    };

    const symbolRaw = normalizeSymbol(cellStr(raw, 'symbol'));
    const quantity = cellStr(raw, 'quantity');
    const costPerUnit = cellStr(raw, 'costPerUnit');
    const acquiredDate = cellStr(raw, 'acquiredDate');

    const token = symbolRaw ? tokenBySymbol.get(symbolRaw) : undefined;
    if (symbolRaw === '') add('symbol', 'symbol is required');
    else if (!token) add('symbol', `'${symbolRaw}' is not a recognized token`);

    if (quantity === '') add('quantity', 'quantity is required');
    else {
      const e = numberCellError(quantity, { positive: true });
      if (e) add('quantity', e);
    }

    // Cost mode: cost_per_unit present → avg (acquired_date ignored); else acquired_date → historical; else none.
    const mode: 'avg' | 'historical' | 'none' =
      costPerUnit !== '' ? 'avg' : acquiredDate !== '' ? 'historical' : 'none';
    if (mode === 'avg') {
      const e = numberCellError(costPerUnit, { positive: true });
      if (e) add('cost_per_unit', e);
    } else if (mode === 'historical') {
      const e = dateCellError(acquiredDate);
      if (e) add('acquired_date', e);
    }

    if (errors.length !== before || !token) continue;

    // DUPLICATE_OPENING — a symbol already held (in the portfolio OR earlier in this batch).
    if (existingTokens.has(token.id) || seenTokens.has(token.id)) {
      add('symbol', `'${token.symbol}' already has a starting position in this portfolio`);
      continue;
    }

    // Plan-rank cap (mirrors addAsset): free users can only open top-10 tokens.
    if (effectivePlan === 'free' && (token.rank === null || token.rank > 10)) {
      add('symbol', `'${token.symbol}' needs a Pro plan (free plans are limited to top-10 tokens)`);
      continue;
    }

    // Build the cost union + parity-check through the single-create Zod.
    const cost =
      mode === 'avg'
        ? { mode: 'avg' as const, avgCost: costPerUnit }
        : mode === 'historical'
          ? { mode: 'historical' as const, date: ymdToIso(acquiredDate) }
          : { mode: 'none' as const };
    const parsed = CreateAssetBodySchema.safeParse({ tokenId: token.id, balance: quantity, cost });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      add(zodPathToAssetColumn(issue?.path ?? []), issue?.message ?? 'invalid row');
      continue;
    }

    // Resolve the opening cost basis exactly like addAsset (reads OUTSIDE the write tx).
    const qtyNum = Number(quantity);
    let openingCostBasis: string | null = null;
    let openingAt: Date | null = null;
    if (mode === 'avg') {
      openingCostBasis = (qtyNum * Number(costPerUnit)).toFixed(8);
    } else if (mode === 'historical') {
      const asOf = new Date(ymdToIso(acquiredDate));
      const snap = await findTokenPriceSnapshotOnOrBefore(token.id, asOf);
      // Stored history first; if none on/before the date, fetch the price at that instant on-demand.
      let priceAtDate: number | null = snap ? Number(snap.price) : null;
      if (priceAtDate == null) {
        priceAtDate = await fetchHistoricalPriceUsd(token.symbol, asOf);
      }
      if (priceAtDate == null) {
        add('acquired_date', `no price available for ${acquiredDate} — provide a cost per unit instead`);
        continue;
      }
      openingCostBasis = (qtyNum * priceAtDate).toFixed(8);
      openingAt = asOf;
    }

    seenTokens.add(token.id);
    prepared.push({ row, tokenId: token.id, balance: quantity, openingCostBasis, openingAt });
  }

  if (body.mode === 'all_or_nothing' && errors.length > 0) {
    throw new BulkError(400, 'BULK_VALIDATION_FAILED', `${errors.length} row(s) failed validation; nothing was imported`, errors);
  }

  const skipped = body.mode === 'skip_invalid' ? new Set(errors.map((e) => e.row)).size : 0;
  if (prepared.length === 0) {
    return { imported: 0, skipped, errors };
  }

  await prisma.$transaction(
    async (tx) => {
      for (const p of prepared) {
        await tx.asset.create({
          data: {
            portfolioId: portfolio.id,
            tokenId: p.tokenId,
            openingBalance: p.balance,
            openingCostBasis: p.openingCostBasis,
            openingAt: p.openingAt,
          },
        });
        // recalc seeds balance = openingBalance and avgCost/costBasis from the opening lot.
        await recalcAssetBalance(tx, portfolio.id, p.tokenId);
      }
      await recalcPortfolioNetDeposit(tx, portfolio.id);
    },
    { timeout: 30000 },
  );

  await invalidatePnlCache(portfolio.id);

  return { imported: prepared.length, skipped, errors };
}
