// Neonfi backend — connected-wallet token re-price worker (retrofit-48).
//
// Integration (real DB). The read-side provider chain (wallet-data/index.js) is MOCKED so we
// control the refreshed prices deterministically. Exercises repriceConnectedTokens():
//   - refreshes ONLY auto-listed tokens (matched by contract), leaving CMC rows untouched,
//   - is best-effort: a wallet whose summary throws is logged + skipped, others still run.

import { it, beforeEach, afterAll, expect, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { repriceConnectedTokens } from '../src/modules/wallet-data/reprice.js';
import { truncateAllUserData } from './helpers.js';

// reprice.ts imports fetchWalletSummary from './index.js' — mock that module.
const { fetchWalletSummaryMock } = vi.hoisted(() => ({ fetchWalletSummaryMock: vi.fn() }));
vi.mock('../src/modules/wallet-data/index.js', () => ({
  previewWallet: vi.fn(),
  fetchWalletSummary: fetchWalletSummaryMock,
}));

const SYM_AUTO = 'ZZREP48A';
const SYM_CMC = 'ZZREP48C';
const SYM_AUTO_B = 'ZZREP48B';
const SYMBOLS = [SYM_AUTO, SYM_CMC, SYM_AUTO_B];
const CONTRACT_AUTO = '0xrep48auto';
const CONTRACT_AUTO_B = '0xrep48autob';
const WALLET_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WALLET_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

beforeEach(async () => {
  await truncateAllUserData();
  await prisma.token.deleteMany({ where: { symbol: { in: SYMBOLS } } });
  fetchWalletSummaryMock.mockReset();
});

afterAll(async () => {
  await truncateAllUserData();
  await prisma.token.deleteMany({ where: { symbol: { in: SYMBOLS } } });
});

let userCounter = 0;
async function makeUser(): Promise<number> {
  const authProvider = await prisma.authProvider.findUniqueOrThrow({ where: { name: 'email' } });
  const onboarding = await prisma.onboardingStatus.findUniqueOrThrow({ where: { name: 'verified' } });
  const user = await prisma.user.create({
    data: {
      email: `reprice.${userCounter++}@neonfi.test`,
      passwordHash: 'x',
      fullName: 'Reprice Worker',
      authProviderId: authProvider.id,
      onboardingStatusId: onboarding.id,
    },
  });
  return user.id;
}

async function makeConnectedPortfolio(userId: number, walletAddress: string): Promise<number> {
  const type = await prisma.portfolioType.findUniqueOrThrow({ where: { name: 'connected' } });
  const eth = await prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } });
  const portfolio = await prisma.portfolio.create({
    data: { userId, name: 'Reprice Connected', typeId: type.id, walletAddress, chainId: eth.id },
  });
  return portfolio.id;
}

it('411: refreshes only auto-listed tokens (by contract); CMC rows untouched', async () => {
  const userId = await makeUser();
  const portfolioId = await makeConnectedPortfolio(userId, WALLET_A);

  const autoToken = await prisma.token.create({
    data: { symbol: SYM_AUTO, name: 'Auto Reprice', currentPrice: '5', autoListed: true, contractAddress: CONTRACT_AUTO },
  });
  const cmcToken = await prisma.token.create({
    data: { symbol: SYM_CMC, name: 'CMC Token', currentPrice: '2', autoListed: false, contractAddress: null },
  });
  await prisma.asset.create({ data: { portfolioId, tokenId: autoToken.id, balance: '10' } });
  await prisma.asset.create({ data: { portfolioId, tokenId: cmcToken.id, balance: '20' } });

  // Provider returns fresh prices for BOTH; contract arrives upper-cased to test lower-casing.
  fetchWalletSummaryMock.mockResolvedValue({
    nativeSymbol: 'ETH', nativeBalance: 0, totalUsd: 999, tokenCount: 2,
    tokens: [
      { symbol: SYM_AUTO, name: 'Auto Reprice', contractAddress: CONTRACT_AUTO.toUpperCase(), balance: 10, decimals: 18, usdPrice: 12.5, usdValue: 125, isNative: false },
      { symbol: SYM_CMC, name: 'CMC Token', contractAddress: null, balance: 20, decimals: 18, usdPrice: 99, usdValue: 1980, isNative: false },
    ],
    provider: 'moralis',
  });

  const r = await repriceConnectedTokens();
  expect(r).toEqual({ wallets: 1, repriced: 1 });
  expect(fetchWalletSummaryMock).toHaveBeenCalledWith(WALLET_A, { slug: 'eth' });

  // Auto-listed row updated (matched by contract); CMC row left frozen.
  const autoAfter = await prisma.token.findUniqueOrThrow({ where: { id: autoToken.id } });
  expect(Number(autoAfter.currentPrice)).toBe(12.5);
  const cmcAfter = await prisma.token.findUniqueOrThrow({ where: { id: cmcToken.id } });
  expect(Number(cmcAfter.currentPrice)).toBe(2);
});

it('412: a wallet whose summary throws is logged + skipped; other wallets still reprice', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  const userA = await makeUser();
  const portfolioA = await makeConnectedPortfolio(userA, WALLET_A);
  const tokenA = await prisma.token.create({
    data: { symbol: SYM_AUTO, name: 'Auto A', currentPrice: '5', autoListed: true, contractAddress: CONTRACT_AUTO },
  });
  await prisma.asset.create({ data: { portfolioId: portfolioA, tokenId: tokenA.id, balance: '1' } });

  const userB = await makeUser();
  const portfolioB = await makeConnectedPortfolio(userB, WALLET_B);
  const tokenB = await prisma.token.create({
    data: { symbol: SYM_AUTO_B, name: 'Auto B', currentPrice: '7', autoListed: true, contractAddress: CONTRACT_AUTO_B },
  });
  await prisma.asset.create({ data: { portfolioId: portfolioB, tokenId: tokenB.id, balance: '1' } });

  // Wallet A's provider read throws; wallet B returns a fresh price. Keyed by address so the
  // outcome is independent of Map iteration order.
  fetchWalletSummaryMock.mockImplementation(async (address: string) => {
    if (address === WALLET_A) throw new Error('provider down');
    return {
      nativeSymbol: 'ETH', nativeBalance: 0, totalUsd: 50, tokenCount: 1,
      tokens: [
        { symbol: SYM_AUTO_B, name: 'Auto B', contractAddress: CONTRACT_AUTO_B, balance: 1, decimals: 18, usdPrice: 42, usdValue: 42, isNative: false },
      ],
      provider: 'moralis',
    };
  });

  const r = await repriceConnectedTokens();
  expect(r).toEqual({ wallets: 2, repriced: 1 });

  // A unchanged (its read failed); B refreshed.
  expect(Number((await prisma.token.findUniqueOrThrow({ where: { id: tokenA.id } })).currentPrice)).toBe(5);
  expect(Number((await prisma.token.findUniqueOrThrow({ where: { id: tokenB.id } })).currentPrice)).toBe(42);
  expect(err).toHaveBeenCalledWith('[connected-reprice] wallet failed', { slug: 'eth' }, expect.any(Error));

  err.mockRestore();
});
