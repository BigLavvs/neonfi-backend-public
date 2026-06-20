// Neonfi backend — CSV bulk import for MANUAL portfolio TRANSACTIONS (retrofit-87).
//
// POST /portfolios/:id/transactions/bulk. Takes the rows the frontend already parsed +
// previewed (lib/csv-import.ts) and is the AUTHORITATIVE validator + writer. Every row is
// reduced to the SAME shape the single-create path produces — a `native` transaction whose
// CSV `type` → direction, `price` → priceAtTime, `date` → timestamp — and goes through the
// SAME write primitives (createTransactionRow / createNativeDetail / computeUsdValue / recalc)
// so an imported row is byte-for-byte what New-Transaction → Buy/Sell would have written.
//
// Two safety nets guarantee parity with the single-create path:
//   1. each prepared row is re-parsed through CreateTransactionBodySchema (the exact Zod the
//      single POST uses) — bulk can never accept what the single create rejects;
//   2. the same business rules single-create enforces (asset auto-create on buy + plan-rank
//      gate, ASSET_NOT_IN_PORTFOLIO on a sell of an unheld token, INSUFFICIENT_BALANCE on an
//      oversell) are applied here against a RUNNING balance seeded from the live assets and
//      advanced row-by-row in request order, so a buy earlier in the file legitimately funds a
//      later sell.

import { prisma } from '../../lib/prisma.js';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import { getEffectivePlan } from '../subscriptions/subscriptions.service.js';
import { createTransactionRow, createNativeDetail } from './transactions.repository.js';
import { recalcAssetBalance, recalcPortfolioNetDeposit } from './recalc.js';
import { computeUsdValue } from './usd-value.js';
import { invalidatePnlCache } from './transactions.service.js';
import { CreateTransactionBodySchema, type BulkTransactionsBody } from './transactions.schemas.js';
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

// A Zod issue on the rebuilt native-transaction body → the CSV column the user typed in. The
// human validators below own the common cases; this only fires for something they missed, so
// the bulk path can never accept a row the single-create Zod would reject.
function zodPathToTxColumn(path: ReadonlyArray<string | number>): string | null {
  switch (String(path[0] ?? '')) {
    case 'direction':
      return 'type';
    case 'priceAtTime':
      return 'price';
    case 'timestamp':
      return 'date';
    case 'transactionHash':
      return 'transaction_hash';
    case 'gasFee':
      return 'gas_fee';
    case 'amount':
    case 'symbol':
    case 'notes':
    case 'from':
    case 'to':
      return String(path[0]);
    default:
      return null;
  }
}

interface PreparedTxRow {
  row: number;
  tokenId: number;
  symbol: string; // canonical catalog symbol (recalc matches details by it)
  direction: 'buy' | 'sell';
  amount: string;
  priceAtTime: string;
  usdValue: string;
  timestamp: Date;
  notes: string | null;
  from: string | null;
  to: string | null;
  transactionHash?: string;
  gasFee: string | null;
  createAsset: boolean; // first buy of a not-yet-held token in this batch
  duplicate: boolean; // hash already exists (DB or earlier in batch) → skipped, not errored
}

export async function bulkCreateTransactions(
  portfolio: PortfolioWithRelations,
  body: BulkTransactionsBody,
): Promise<BulkResult> {
  // Scope: manual portfolios only — connected ones are provider-synced (retrofit-59).
  if (portfolio.type.name !== 'manual') {
    throw new BulkError(400, 'NOT_MANUAL', 'CSV import is only available for manual portfolios');
  }
  if (body.rows.length > BULK_ROW_CAP) {
    throw new BulkError(400, 'TOO_MANY_ROWS', `At most ${BULK_ROW_CAP} rows per import`);
  }

  // --- one-shot reads for the whole batch (resolution, balances, dedup) -------------------
  const wantedSymbols = [
    ...new Set(body.rows.map((r) => normalizeSymbol(cellStr(r, 'symbol'))).filter(Boolean)),
  ];
  const wantedHashes = [
    ...new Set(body.rows.map((r) => cellStr(r, 'transactionHash')).filter(Boolean)),
  ];
  const [tokenRows, assetRows, hashRows, effectivePlan] = await Promise.all([
    wantedSymbols.length
      ? prisma.token.findMany({
          where: { symbol: { in: wantedSymbols } },
          select: { id: true, symbol: true, rank: true },
        })
      : Promise.resolve([] as Array<{ id: number; symbol: string; rank: number | null }>),
    prisma.asset.findMany({ where: { portfolioId: portfolio.id }, select: { tokenId: true, balance: true } }),
    wantedHashes.length
      ? prisma.transaction.findMany({
          where: { portfolioId: portfolio.id, transactionHash: { in: wantedHashes } },
          select: { transactionHash: true },
        })
      : Promise.resolve([] as Array<{ transactionHash: string | null }>),
    getEffectivePlan(portfolio.userId),
  ]);

  const tokenBySymbol = new Map(tokenRows.map((t) => [t.symbol, t]));
  const runningBalance = new Map<number, number>();
  const heldTokens = new Set<number>();
  for (const a of assetRows) {
    heldTokens.add(a.tokenId);
    runningBalance.set(a.tokenId, Number(a.balance.toString()));
  }
  const existingHashes = new Set(hashRows.map((h) => h.transactionHash).filter(Boolean) as string[]);
  const seenHashes = new Set<string>();

  const errors: BulkRowError[] = [];
  const prepared: PreparedTxRow[] = [];

  // --- forward pass: validate + prepare each row in request order ------------------------
  for (let i = 0; i < body.rows.length; i++) {
    const raw = body.rows[i];
    if (!raw) continue;
    const row = i + 1;
    const before = errors.length;
    const add = (column: string | null, message: string): void => {
      errors.push({ row, column, message });
    };

    const typeRaw = cellStr(raw, 'type').toLowerCase();
    const symbolRaw = normalizeSymbol(cellStr(raw, 'symbol'));
    const amount = cellStr(raw, 'amount');
    const price = cellStr(raw, 'price');
    const date = cellStr(raw, 'date');
    const gasFee = cellStr(raw, 'gasFee');

    if (typeRaw === '') add('type', 'type is required (buy or sell)');
    else if (typeRaw !== 'buy' && typeRaw !== 'sell')
      add('type', `must be buy or sell, got '${typeRaw}'`);

    const token = symbolRaw ? tokenBySymbol.get(symbolRaw) : undefined;
    if (symbolRaw === '') add('symbol', 'symbol is required');
    else if (!token) add('symbol', `'${symbolRaw}' is not a recognized token`);

    for (const [column, value] of [
      ['amount', amount],
      ['price', price],
    ] as const) {
      if (value === '') add(column, `${column} is required`);
      else {
        const e = numberCellError(value, { positive: true });
        if (e) add(column, e);
      }
    }

    if (date === '') add('date', 'date is required');
    else {
      const e = dateCellError(date);
      if (e) add('date', e);
    }

    if (gasFee !== '') {
      const e = numberCellError(gasFee, { positive: false });
      if (e) add('gas_fee', e);
    }

    // Cells bad (or token unknown) → row invalid; it does NOT advance the running balance.
    if (errors.length !== before || !token) continue;

    const direction = typeRaw as 'buy' | 'sell';
    const transactionHash = cellStr(raw, 'transactionHash') || undefined;
    const notes = cellStr(raw, 'notes') || null;
    const from = cellStr(raw, 'from') || null;
    const to = cellStr(raw, 'to') || null;

    // Parity gate: rebuild the exact native-transaction body and run the single-create Zod.
    const candidate = {
      type: 'native' as const,
      direction,
      symbol: token.symbol,
      amount,
      priceAtTime: price,
      timestamp: ymdToIso(date),
      ...(notes !== null ? { notes } : {}),
      ...(from !== null ? { from } : {}),
      ...(to !== null ? { to } : {}),
      ...(transactionHash ? { transactionHash } : {}),
      ...(gasFee !== '' ? { gasFee } : {}),
    };
    const parsed = CreateTransactionBodySchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      add(zodPathToTxColumn(issue?.path ?? []), issue?.message ?? 'invalid row');
      continue;
    }

    // Dedup on transactionHash (the @@unique(portfolioId, transactionHash) constraint):
    // a duplicate is SKIPPED, never an error, and never advances the running balance.
    if (transactionHash && (existingHashes.has(transactionHash) || seenHashes.has(transactionHash))) {
      prepared.push({
        row,
        tokenId: token.id,
        symbol: token.symbol,
        direction,
        amount,
        priceAtTime: price,
        usdValue: '0',
        timestamp: new Date(ymdToIso(date)),
        notes,
        from,
        to,
        transactionHash,
        gasFee: gasFee || null,
        createAsset: false,
        duplicate: true,
      });
      continue;
    }
    if (transactionHash) seenHashes.add(transactionHash);

    // Business rules — identical to createTransaction, evaluated against the running balance.
    let createAsset = false;
    const held = heldTokens.has(token.id);
    if (direction === 'buy') {
      if (!held) {
        if (effectivePlan === 'free' && (token.rank === null || token.rank > 10)) {
          add('symbol', `'${token.symbol}' needs a Pro plan (free plans are limited to top-10 tokens)`);
          continue;
        }
        createAsset = true;
        heldTokens.add(token.id);
        runningBalance.set(token.id, 0);
      }
      runningBalance.set(token.id, (runningBalance.get(token.id) ?? 0) + Number(amount));
    } else {
      // sell
      if (!held) {
        add('symbol', `you don't hold '${token.symbol}' yet — import its buy first`);
        continue;
      }
      const bal = runningBalance.get(token.id) ?? 0;
      if (Number(amount) > bal) {
        add('amount', `can't sell ${amount} ${token.symbol}; only ${bal} available at this point`);
        continue;
      }
      runningBalance.set(token.id, bal - Number(amount));
    }

    // computeUsdValue reads the price cache/DB — do it OUTSIDE the write tx (price always
    // present here, so it resolves to amount × price deterministically).
    const usdValue = await computeUsdValue(token.symbol, amount, price);

    prepared.push({
      row,
      tokenId: token.id,
      symbol: token.symbol,
      direction,
      amount,
      priceAtTime: price,
      usdValue,
      timestamp: new Date(ymdToIso(date)),
      notes,
      from,
      to,
      transactionHash,
      gasFee: gasFee || null,
      createAsset,
      duplicate: false,
    });
  }

  // all_or_nothing: any real error → write nothing, 400 with the full list (duplicates,
  // which are skips not errors, do NOT trip this).
  if (body.mode === 'all_or_nothing' && errors.length > 0) {
    throw new BulkError(400, 'BULK_VALIDATION_FAILED', `${errors.length} row(s) failed validation; nothing was imported`, errors);
  }

  const toInsert = prepared.filter((p) => !p.duplicate);
  const skipped =
    prepared.filter((p) => p.duplicate).length +
    (body.mode === 'skip_invalid' ? new Set(errors.map((e) => e.row)).size : 0);

  if (toInsert.length === 0) {
    return { imported: 0, skipped, errors };
  }

  // --- single write transaction (atomic for all_or_nothing; the valid set for skip) ------
  const [nativeType, buyDir, sellDir] = await Promise.all([
    prisma.transactionType.findUniqueOrThrow({ where: { name: 'native' } }),
    prisma.transactionDirection.findUniqueOrThrow({ where: { name: 'buy' } }),
    prisma.transactionDirection.findUniqueOrThrow({ where: { name: 'sell' } }),
  ]);

  const affectedTokens = new Set<number>();
  await prisma.$transaction(
    async (tx) => {
      for (const p of toInsert) {
        if (p.createAsset) {
          await tx.asset.create({
            data: { portfolioId: portfolio.id, tokenId: p.tokenId, balance: '0', netDeposit: '0' },
          });
        }
        const created = await createTransactionRow(tx, {
          portfolioId: portfolio.id,
          typeId: nativeType.id,
          directionId: p.direction === 'buy' ? buyDir.id : sellDir.id,
          from: p.from,
          to: p.to,
          gasFee: p.gasFee,
          transactionHash: p.transactionHash,
          timestamp: p.timestamp,
          notes: p.notes,
        });
        await createNativeDetail(tx, created.id, {
          amount: p.amount,
          symbol: p.symbol,
          usdValue: p.usdValue,
          priceAtTime: p.priceAtTime,
        });
        affectedTokens.add(p.tokenId);
      }
      // recalc each touched token once, then the portfolio total once (matches single-create).
      for (const tokenId of affectedTokens) {
        await recalcAssetBalance(tx, portfolio.id, tokenId);
      }
      await recalcPortfolioNetDeposit(tx, portfolio.id);
    },
    { timeout: 30000 },
  );

  await invalidatePnlCache(portfolio.id);

  return { imported: toInsert.length, skipped, errors };
}
