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
  timestamp: string;
  createdAt: string;
}

export interface NativeDetailDTO {
  amount: number;
  symbol: string;
}

export interface Erc20DetailDTO {
  amount: number;
  symbol: string;
  tokenContractAddress: string;
  tokenName: string;
  tokenSymbol: string;
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

export function toTransactionListDTO(tx: TransactionWithListIncludes): TransactionListDTO {
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
    timestamp: tx.timestamp.toISOString(),
    createdAt: tx.createdAt.toISOString(),
  };
}

export function toTransactionDetailDTO(tx: TransactionWithAllRelations): TransactionDetailDTO {
  const base = toTransactionListDTO(tx);
  let detail: NativeDetailDTO | Erc20DetailDTO | NftDetailDTO;

  if (tx.type.name === 'native' && tx.nativeDetail) {
    detail = {
      amount: Number(tx.nativeDetail.amount.toString()),
      symbol: tx.nativeDetail.symbol,
    };
  } else if (tx.type.name === 'erc20' && tx.erc20Detail) {
    detail = {
      amount: Number(tx.erc20Detail.amount.toString()),
      symbol: tx.erc20Detail.symbol,
      tokenContractAddress: tx.erc20Detail.tokenContractAddress,
      tokenName: tx.erc20Detail.tokenName,
      tokenSymbol: tx.erc20Detail.tokenSymbol,
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
