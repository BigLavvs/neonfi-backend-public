import type { PrismaTransactionClient } from '../../lib/prisma.js';

// The $extends'd client's interactive-tx type (see prisma.ts) — not Prisma.TransactionClient.
type TxClient = PrismaTransactionClient;

// Recalculates an Asset's balance, average cost, realized PnL — AND the legacy
// netDeposit — for a (portfolioId, tokenId) pair from its opening lot plus all
// native/erc20 transactions for that token in that portfolio (retrofit-27).
//
// AVERAGE-COST MODEL (retrofit-27 §2). Process the asset's txns in CHRONOLOGICAL
// order, seeded by the immutable opening lot (Asset.openingBalance/openingCostBasis):
//   qty          = openingBalance
//   costKnownQty = openingCostBasis != null ? openingBalance : 0
//   totalCost    = openingCostBasis ?? 0          // USD basis of costKnownQty
//   buy:  qty += amt; costKnownQty += amt; totalCost += usdValue
//   sell: avg = costKnownQty>0 ? totalCost/costKnownQty : null
//         if avg != null: sold = min(amt, costKnownQty); realized += sold*(price−avg);
//                         costKnownQty −= sold; totalCost −= sold*avg
//         qty −= amt
//   avgCost   = costKnownQty>0 ? totalCost/costKnownQty : null
//   costBasis = totalCost
// Cost-UNKNOWN units (null opening cost / never bought with a price) are excluded from
// avg cost AND unrealized PnL; an all-unknown asset → avgCost=null → PnL N/A.
//
// netDeposit (Augment decision, retrofit-27): STILL maintained here as
// Σ(buy usdValue) − Σ(sell usdValue) so the legacy netDeposit-based pnlAllTime* and the
// analytics summary keep working. The opening lot is NOT a transaction and does not move
// netDeposit (matches the pre-retrofit-27 definition exactly).
//
// TRANSFERS (retrofit-10): a cross-portfolio transfer is a paired `sell`+`buy` carrying a
// transferGroupId. Its legs DO move balance + netDeposit (so the existing tests/basis-carry
// hold), but the SELL leg realizes ZERO PnL — a transfer relocates basis, it isn't a sale
// ("Transfers stay net-zero", §2/§6). The manual `transfer` DIRECTION stays a pure no-op
// (neither buy nor sell). NFT transactions are excluded — ownership is tracked via the Nft
// table and NFTs carry no amount/usdValue. Negative balances are accepted here (the
// oversell guard lives in createTransaction, POST-only — recalc just reflects state).
export async function recalcAssetBalance(
  tx: TxClient,
  portfolioId: number,
  tokenId: number,
): Promise<void> {
  const token = await tx.token.findUnique({ where: { id: tokenId } });
  if (!token) return;

  const asset = await tx.asset.findUnique({
    where: { portfolioId_tokenId: { portfolioId, tokenId } },
  });
  if (!asset) return; // nothing to recalc (caller creates the asset first)

  const [nativeTxs, erc20Txs] = await Promise.all([
    tx.nativeTransactionDetail.findMany({
      where: { symbol: token.symbol, transaction: { portfolioId } },
      include: { transaction: { include: { direction: true } } },
    }),
    tx.erc20TransactionDetail.findMany({
      where: { symbol: token.symbol, transaction: { portfolioId } },
      include: { transaction: { include: { direction: true } } },
    }),
  ]);

  // One chronological stream across native + erc20. Tie-break same-timestamp txns by id
  // (monotonic with insertion order), so a buy logged before a sell at the same timestamp
  // is processed first — average cost depends on order.
  const events = [...nativeTxs, ...erc20Txs]
    .map((d) => ({
      dir: d.transaction.direction.name,
      amount: Number(d.amount.toString()),
      usd: Number(d.usdValue.toString()),
      isTransfer: d.transaction.transferGroupId !== null,
      ts: d.transaction.timestamp.getTime(),
      id: d.transaction.id,
    }))
    .sort((a, b) => a.ts - b.ts || a.id - b.id);

  const openingBalance = Number(asset.openingBalance.toString());
  const openingCostBasis =
    asset.openingCostBasis !== null ? Number(asset.openingCostBasis.toString()) : null;

  let qty = openingBalance;
  let costKnownQty = openingCostBasis !== null ? openingBalance : 0;
  let totalCost = openingCostBasis ?? 0;
  let realized = 0;
  let netDeposit = 0;

  for (const e of events) {
    if (e.dir === 'buy') {
      qty += e.amount;
      costKnownQty += e.amount;
      totalCost += e.usd;
      netDeposit += e.usd;
    } else if (e.dir === 'sell') {
      const avg = costKnownQty > 0 ? totalCost / costKnownQty : null;
      if (avg !== null) {
        const sold = Math.min(e.amount, costKnownQty);
        // amount>0 guards price = usd/amount; sold is 0 only when amount is 0, so the
        // realized term is 0 either way (transfers never realize).
        const price = e.amount > 0 ? e.usd / e.amount : 0;
        if (!e.isTransfer) realized += sold * (price - avg);
        costKnownQty -= sold;
        totalCost -= sold * avg;
      }
      qty -= e.amount;
      netDeposit -= e.usd;
    }
    // direction === 'transfer' (manual address sub-mode): no-op for balance, cost, netDeposit.
  }

  const avgCost = costKnownQty > 0 ? totalCost / costKnownQty : null;
  const costBasis = totalCost;

  // updateMany gracefully handles "asset deleted mid-flight" (0 rows) instead of throwing.
  await tx.asset.updateMany({
    where: { portfolioId, tokenId },
    data: {
      balance: qty.toString(),
      netDeposit: netDeposit.toFixed(8),
      realizedPnl: realized.toFixed(8),
      avgCost: avgCost !== null ? avgCost.toFixed(8) : null,
      costBasis: costBasis.toFixed(8),
    },
  });
}

// Recomputes Portfolio.netDeposit as the sum of its assets' netDeposit values
// (retrofit-2 §1.4). Call inside the same $transaction, after recalcAssetBalance,
// so the per-asset netDeposit is already up to date.
export async function recalcPortfolioNetDeposit(
  tx: TxClient,
  portfolioId: number,
): Promise<void> {
  const assets = await tx.asset.findMany({
    where: { portfolioId },
    select: { netDeposit: true },
  });
  const total = assets.reduce((sum, a) => sum + Number(a.netDeposit.toString()), 0);
  await tx.portfolio.update({
    where: { id: portfolioId },
    data: { netDeposit: total.toFixed(8) },
  });
}
