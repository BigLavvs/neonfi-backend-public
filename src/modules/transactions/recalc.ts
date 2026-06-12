import type { Prisma } from '@prisma/client';

type TxClient = Prisma.TransactionClient;

// Recalculates Asset.balance for a (portfolioId, tokenId) pair by summing all
// native and erc20 transactions for that token in that portfolio.
// buy adds, sell subtracts, transfer is a no-op (net-zero between own wallets).
// NFT transactions are excluded — ownership is tracked via the Nft table (Stage 12).
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

  for (const detail of nativeTxs) {
    const dir = detail.transaction.direction.name;
    const amount = Number(detail.amount.toString());
    if (dir === 'buy') balance += amount;
    else if (dir === 'sell') balance -= amount;
  }

  for (const detail of erc20Txs) {
    const dir = detail.transaction.direction.name;
    const amount = Number(detail.amount.toString());
    if (dir === 'buy') balance += amount;
    else if (dir === 'sell') balance -= amount;
  }

  // updateMany gracefully handles "asset not found" (0 rows updated) instead of throwing
  await tx.asset.updateMany({
    where: { portfolioId, tokenId },
    data: { balance: balance.toString() },
  });
}
