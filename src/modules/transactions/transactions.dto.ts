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

export type TransactionWithTypeDirection = Prisma.TransactionGetPayload<{
  include: { type: true; direction: true };
}>;

export interface TransactionListDTO {
  id: number;
  portfolioId: number;
  type: string;
  direction: string;
  from: string | null;
  to: string | null;
  gasFee: number | null;
  transactionHash: string | null;
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

export function toTransactionListDTO(tx: TransactionWithTypeDirection): TransactionListDTO {
  return {
    id: tx.id,
    portfolioId: tx.portfolioId,
    type: tx.type.name,
    direction: tx.direction.name,
    from: tx.from ?? null,
    to: tx.to ?? null,
    gasFee: tx.gasFee !== null ? Number(tx.gasFee.toString()) : null,
    transactionHash: tx.transactionHash ?? null,
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
