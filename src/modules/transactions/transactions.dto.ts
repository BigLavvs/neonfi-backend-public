import type { Prisma } from '@prisma/client';

export type TransactionWithAllRelations = Prisma.TransactionGetPayload<{
  include: {
    type: true;
    direction: true;
    nativeDetail: true;
    erc20Detail: true;
    nftDetail: true;
  };
}>;

// The list query (retrofit-2) now also pulls the native/erc20 child detail so the
// list response can surface amount/symbol/usdValue flat per row. nftDetail is NOT
// included — NFTs have no amount/symbol/usdValue to surface and the join is wasted.
export type TransactionWithListIncludes = Prisma.TransactionGetPayload<{
  include: { type: true; direction: true; nativeDetail: true; erc20Detail: true };
}>;

export interface TransactionListDTO {
  id: number;
  portfolioId: number;
  type: string;
  direction: string;
  // Hardcoded for MVP — no on-chain status tracking yet. Architecture rep defines
  // status as "completed | pending | failed", but the schema has no column. All MVP
  // transactions are effectively completed (manual = user-logged after the fact;
  // connected = webhook events arrive post-confirmation). Replace with a real column
  // when pending/failed states ship post-MVP.
  status: 'completed';
  from: string | null;
  to: string | null;
  gasFee: number | null;
  transactionHash: string | null;
  // amount/symbol/usdValue come from the child detail (native or erc20).
  // All null for nft type — no balance, no USD value (retrofit-2 §1.7).
  amount: number | null;
  symbol: string | null;
  usdValue: number | null;
  // retrofit-49 (#6): the token's stored logo so connected (and manual) transactions can
  // render the token image. Resolved by the service from the Token catalog by symbol and
  // passed in; null when the symbol has no logo, for nft rows, or when not resolved.
  logoUrl: string | null;
  // retrofit-7: free-text user note (null for webhook/connected or when omitted).
  notes: string | null;
  // retrofit-10: shared id linking the two legs of a cross-portfolio transfer (the
  // source `sell` + dest `buy`). Null for ordinary transactions. Lets the frontend
  // group/label the pair as a single transfer.
  transferGroupId: string | null;
  timestamp: string;
  createdAt: string;
}

export interface NativeDetailDTO {
  amount: number;
  symbol: string;
  // retrofit-7: user-entered price that drove usdValue; null for current-price rows.
  priceAtTime: number | null;
}

export interface Erc20DetailDTO {
  amount: number;
  symbol: string;
  tokenContractAddress: string;
  tokenName: string;
  tokenSymbol: string;
  // retrofit-7: user-entered price that drove usdValue; null for current-price rows.
  priceAtTime: number | null;
}

export interface NftDetailDTO {
  tokenContractAddress: string;
  nftTokenId: string;
  nftName: string | null;
  collectionName: string | null;
}

export interface TransactionDetailDTO extends TransactionListDTO {
  detail: NativeDetailDTO | Erc20DetailDTO | NftDetailDTO;
}

// retrofit-49: `logoUrl` is resolved by the service (Token catalog by symbol) and passed
// in — the list/detail row carries no Token relation, so the mapper can't read it itself.
// Defaults to null so the many existing callers (and write-path detail responses) compile
// unchanged and simply omit the image.
export function toTransactionListDTO(
  tx: TransactionWithListIncludes,
  logoUrl: string | null = null,
): TransactionListDTO {
  let amount: number | null = null;
  let symbol: string | null = null;
  let usdValue: number | null = null;

  if (tx.nativeDetail) {
    amount = Number(tx.nativeDetail.amount.toString());
    symbol = tx.nativeDetail.symbol;
    usdValue = Number(tx.nativeDetail.usdValue.toString());
  } else if (tx.erc20Detail) {
    amount = Number(tx.erc20Detail.amount.toString());
    symbol = tx.erc20Detail.symbol;
    usdValue = Number(tx.erc20Detail.usdValue.toString());
  }
  // For nft transactions: all three remain null.

  return {
    id: tx.id,
    portfolioId: tx.portfolioId,
    type: tx.type.name,
    direction: tx.direction.name,
    status: 'completed',
    from: tx.from ?? null,
    to: tx.to ?? null,
    gasFee: tx.gasFee !== null ? Number(tx.gasFee.toString()) : null,
    transactionHash: tx.transactionHash ?? null,
    amount,
    symbol,
    usdValue,
    logoUrl,
    notes: tx.notes ?? null,
    transferGroupId: tx.transferGroupId ?? null,
    timestamp: tx.timestamp.toISOString(),
    createdAt: tx.createdAt.toISOString(),
  };
}

export function toTransactionDetailDTO(
  tx: TransactionWithAllRelations,
  logoUrl: string | null = null,
): TransactionDetailDTO {
  const base = toTransactionListDTO(tx, logoUrl);
  let detail: NativeDetailDTO | Erc20DetailDTO | NftDetailDTO;

  if (tx.type.name === 'native' && tx.nativeDetail) {
    detail = {
      amount: Number(tx.nativeDetail.amount.toString()),
      symbol: tx.nativeDetail.symbol,
      priceAtTime:
        tx.nativeDetail.priceAtTime !== null
          ? Number(tx.nativeDetail.priceAtTime.toString())
          : null,
    };
  } else if (tx.type.name === 'erc20' && tx.erc20Detail) {
    detail = {
      amount: Number(tx.erc20Detail.amount.toString()),
      symbol: tx.erc20Detail.symbol,
      tokenContractAddress: tx.erc20Detail.tokenContractAddress,
      tokenName: tx.erc20Detail.tokenName,
      tokenSymbol: tx.erc20Detail.tokenSymbol,
      priceAtTime:
        tx.erc20Detail.priceAtTime !== null
          ? Number(tx.erc20Detail.priceAtTime.toString())
          : null,
    };
  } else if (tx.type.name === 'nft' && tx.nftDetail) {
    detail = {
      tokenContractAddress: tx.nftDetail.tokenContractAddress,
      nftTokenId: tx.nftDetail.nftTokenId,
      nftName: tx.nftDetail.nftName ?? null,
      collectionName: tx.nftDetail.collectionName ?? null,
    };
  } else {
    throw new Error(
      `Transaction ${tx.id} has type '${tx.type.name}' but no matching detail record`,
    );
  }

  return { ...base, detail };
}
