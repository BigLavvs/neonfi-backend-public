import type { PrismaTransactionClient } from '../../lib/prisma.js';

// The $extends'd client's interactive-tx type (see prisma.ts) — not Prisma.TransactionClient.
type TxClient = PrismaTransactionClient;

// Recalculates Asset.balance AND Asset.netDeposit for a (portfolioId, tokenId)
// pair by summing all native and erc20 transactions for that token in that
// portfolio.
//   balance    = sum(buy amount)   − sum(sell amount)
//   netDeposit = sum(buy usdValue) − sum(sell usdValue)   (retrofit-2)
// buy adds, sell subtracts, transfer is a no-op for both (net-zero between own
// wallets). NFT transactions are excluded — ownership is tracked via the Nft
// table (Stage 12) and NFTs carry no usdValue.
// Accepts negative balances as MVP simplification (no short-position model yet).
export async function recalcAssetBalance(
  tx: TxClient,
  portfolioId: number,
  tokenId: number,
): Promise<void> {
  const token = await tx.token.findUnique({ where: { id: tokenId } });
  if (!token) return;

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

  let balance = 0;
  let netDeposit = 0;

  for (const detail of nativeTxs) {
    const dir = detail.transaction.direction.name;
    const amount = Number(detail.amount.toString());
    const usd = Number(detail.usdValue.toString());
    if (dir === 'buy') {
      balance += amount;
      netDeposit += usd;
    } else if (dir === 'sell') {
      balance -= amount;
      netDeposit -= usd;
    }
  }

  for (const detail of erc20Txs) {
    const dir = detail.transaction.direction.name;
    const amount = Number(detail.amount.toString());
    const usd = Number(detail.usdValue.toString());
    if (dir === 'buy') {
      balance += amount;
      netDeposit += usd;
    } else if (dir === 'sell') {
      balance -= amount;
      netDeposit -= usd;
    }
  }

  // updateMany gracefully handles "asset not found" (0 rows updated) instead of throwing
  await tx.asset.updateMany({
    where: { portfolioId, tokenId },
    data: { balance: balance.toString(), netDeposit: netDeposit.toFixed(8) },
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
