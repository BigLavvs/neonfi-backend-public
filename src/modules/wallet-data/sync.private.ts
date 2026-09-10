import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../lib/config.js';
import { toDecimalString } from '../../lib/decimal.js';
import { invalidatePnlCache, createTransactionFromWebhook, createNftTransactionFromWebhook, TransactionError } from '../transactions/transactions.service.js';
import type { CreateTransactionBody } from '../transactions/transactions.schemas.js';
import { findPortfolioById } from '../portfolios/portfolios.repository.js';
import type { PortfolioWithRelations } from '../portfolios/portfolios.dto.js';
import { fetchWalletSummary, fetchTransferPage, fetchNftHoldings, fetchSpamContracts, fetchWalletSpamContracts, fetchTransactionCount, fetchValueHistory, fetchWalletPnl } from './index.js';
import { classifyNftSpam } from './nft-spam.js';
import type { WalletNftHolding, WalletPnl, WalletTransfer } from './types.js';

export const PAGE_LIMIT = 50;
const VALUE_HISTORY_DAYS = 1095;
const MAX_MORALIS_VALUE_SAMPLES = 50;

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

export async function resolveOrCreateToken(t: TokenResolveInput) {
  const symbol = t.symbol.toUpperCase();
  const contract = t.contractAddress ? t.contractAddress.toLowerCase() : null;

  let token =
    contract != null
      ? await prisma.token.findFirst({
          where: { contractAddress: { equals: contract, mode: 'insensitive' } },
        })
      : null;
  const matchedByContract = token != null;

  if (!token) {
    token = await prisma.token.findFirst({
      where: { symbol: { equals: t.symbol, mode: 'insensitive' } },
    });
  }

  if (token) {
    if (!matchedByContract && contract != null) {
      if (token.contractAddress == null) {
        token = await prisma.token.update({
          where: { id: token.id },
          data: { contractAddress: contract },
        });
      } else if (token.contractAddress.toLowerCase() !== contract) {
        console.warn('[wallet-sync] ticker collision', {
          symbol,
          existing: token.contractAddress,
          incoming: contract,
        });
      }
    }
    if (token.logoUrl == null && t.logoUrl) {
      token = await prisma.token.update({ where: { id: token.id }, data: { logoUrl: t.logoUrl } });
    }
    return token;
  }

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

export async function importTransfers(
  portfolio: PortfolioWithRelations,
  transfers: WalletTransfer[],
): Promise<number> {
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

export async function importNftHoldings(
  portfolio: PortfolioWithRelations,
  holdings: WalletNftHolding[],
): Promise<void> {
  const chainSlug = portfolio.chain?.slug ?? '';
  const [spamContracts, walletSpam] = await Promise.all([
    fetchSpamContracts({ slug: chainSlug }),
    portfolio.walletAddress
      ? fetchWalletSpamContracts(portfolio.walletAddress, { slug: chainSlug })
      : Promise.resolve(new Set<string>()),
  ]);
  for (const c of walletSpam) spamContracts.add(c);
  const heldByContract = new Map<string, number>();
  for (const h of holdings) {
    const c = h.contractAddress.toLowerCase();
    heldByContract.set(c, (heldByContract.get(c) ?? 0) + 1);
  }
  for (const h of holdings) {
    try {
      const spam = classifyNftSpam({
        possibleSpam: h.possibleSpam,
        spamContract: spamContracts.has(h.contractAddress.toLowerCase()),
        name: h.name,
        collectionName: h.collectionName,
        contractAddress: h.contractAddress,
        heldCount: heldByContract.get(h.contractAddress.toLowerCase()) ?? 1,
      });
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
          possibleSpam: h.possibleSpam, // retrofit-73 (H13)
          spam, // retrofit-84 (H13): combined verdict
        },
        update: {
          ...(h.logoUrl ? { logoUrl: h.logoUrl } : {}),
          ...(h.name ? { name: h.name } : {}),
          ...(h.description ? { description: h.description } : {}),
          possibleSpam: h.possibleSpam, // retrofit-73 (H13): refresh the flag on re-sync
          spam, // retrofit-84 (H13): re-evaluate the combined verdict on re-sync
        },
      });
    } catch (e) {
      console.error('[wallet-sync] nft holding import failed', { contract: h.contractAddress, tokenId: h.tokenId }, (e as Error).message);
    }
  }
}

export async function resolveExternalTxCount(
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

async function currentConnectedValue(portfolioId: number): Promise<number> {
  const assets = await prisma.asset.findMany({
    where: { portfolioId },
    select: { balance: true, token: { select: { currentPrice: true } } },
  });
  let total = 0;
  for (const a of assets) total += Number(a.balance.toString()) * Number(a.token.currentPrice.toString());
  return total;
}

export interface HistoricalTokenRow {
  usd_value?: number | string | null;
  possible_spam?: boolean;
}

export function sumHistoricalTokenValue(rows: HistoricalTokenRow[]): number {
  let total = 0;
  for (const r of rows) {
    if (r.possible_spam === true) continue;
    const v = r.usd_value != null ? Number(r.usd_value) : null;
    if (v == null || !Number.isFinite(v) || v <= 0) continue;
    total += v;
  }
  return total;
}

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
      const rows =
        ((await tk.json()) as { result?: HistoricalTokenRow[] }).result ?? [];
      const value = sumHistoricalTokenValue(rows);
      if (value > 0) out.push({ date: iso.slice(0, 10), value });
    } catch (e) {
      console.error('[wallet-sync] moralis value-history sample failed', { iso }, (e as Error).message);
    }
  }
  return out;
}

interface ValuePoint {
  date: string;
  value: number;
  approx: boolean;
}
async function buildConnectedValueHistory(
  portfolio: PortfolioWithRelations,
  address: string,
  chain: { slug: string },
  days: number,
): Promise<ValuePoint[]> {
  const currentValue = await currentConnectedValue(portfolio.id);

  const priced = (await fetchValueHistory(address, chain, days)) ?? [];

  const windowStartMs = Date.now() - days * 86400 * 1000;
  const earliestMs = priced.length > 0 ? Date.parse(`${priced[0]!.date}T00:00:00.000Z`) : Date.now();
  let tail: Array<{ date: string; value: number }> = [];
  if (earliestMs > windowStartMs + 7 * 86400 * 1000) {
    tail = await sampleMoralisValueHistory(
      address,
      chain.slug,
      portfolio.chain?.moralisId ?? '0x1',
      windowStartMs,
      earliestMs,
      MAX_MORALIS_VALUE_SAMPLES,
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const byDate = new Map<string, { value: number; approx: boolean }>();
  for (const p of tail) byDate.set(p.date, { value: p.value, approx: true });
  for (const p of priced) byDate.set(p.date, { value: p.value, approx: false });
  byDate.set(today, { value: currentValue, approx: false });

  const sorted = [...byDate.entries()]
    .filter(([d]) => d <= today)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, { value, approx }]) => ({ date, value, approx }));
  const firstNonZero = sorted.findIndex((p) => p.value > 0);
  if (firstNonZero === -1) return [];
  return firstNonZero === 0 ? sorted : sorted.slice(firstNonZero);
}

export async function backfillConnectedSnapshots(
  portfolio: PortfolioWithRelations,
  address: string,
  chain: { slug: string },
  opts: { fullHistory?: boolean } = {},
): Promise<void> {
  const fullHistory = opts.fullHistory ?? true;
  try {
    const dayMs = (d: string) => new Date(`${d}T00:00:00.000Z`);
    const today = new Date().toISOString().slice(0, 10);

    if (!fullHistory) {
      const value = await currentConnectedValue(portfolio.id);
      await prisma.balanceSnapshot.upsert({
        where: { portfolioId_snapshotDate: { portfolioId: portfolio.id, snapshotDate: dayMs(today) } },
        create: { portfolioId: portfolio.id, userId: portfolio.userId, snapshotDate: dayMs(today), value: toDecimalString(value), approx: false },
        update: { value: toDecimalString(value), approx: false },
      });
      return;
    }

    const series = await buildConnectedValueHistory(portfolio, address, chain, VALUE_HISTORY_DAYS);
    if (series.length === 0) return;

    const historical = series.filter((p) => p.date < today);
    if (historical.length > 0) {
      const rows = historical.map(
        ({ date, value, approx }) =>
          Prisma.sql`(${portfolio.id}::int, ${portfolio.userId}::int, ${toDecimalString(value)}::decimal, ${date}::date, ${approx}::boolean)`,
      );
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        await prisma.$executeRaw`
          INSERT INTO "balance_snapshot" ("portfolioId", "userId", "value", "snapshotDate", "approx")
          VALUES ${Prisma.join(chunk)}
          ON CONFLICT ("portfolioId", "snapshotDate")
          DO UPDATE SET "value" = EXCLUDED."value", "approx" = EXCLUDED."approx"
          WHERE "balance_snapshot"."approx" = true
        `;
      }
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
          approx: false,
        },
        update: { value: toDecimalString(todayPoint.value), approx: false },
      });
    }
  } catch (e) {
    console.error('[wallet-sync] connected snapshot backfill failed', (e as Error).message);
  }
}

export async function rebuildConnectedHistory(portfolio: PortfolioWithRelations): Promise<boolean> {
  const address = portfolio.walletAddress;
  const slug = portfolio.chain?.slug;
  if (!address || !slug) return false;
  await backfillConnectedSnapshots(portfolio, address, { slug }, { fullHistory: true });
  return true;
}


