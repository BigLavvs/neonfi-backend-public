// Neonfi backend — connected-wallet token re-price worker (retrofit-48).
//
// Integration (real DB). The read-side provider chain (wallet-data/index.js) is MOCKED so we
// control the refreshed prices deterministically. Exercises repriceConnectedTokens():
//   - refreshes ONLY auto-listed tokens (matched by contract), leaving CMC rows untouched,
//   - is best-effort: a wallet whose summary throws is logged + skipped, others still run.

import { it, beforeEach, afterAll, expect, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { repriceConnectedTokens } from '../src/modules/wallet-data/reprice.js';
import {
  _setCanonicalPriceSource,
  _resetCanonicalPriceSource,
} from '../src/modules/tokens/canonical-price.js';
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
  // retrofit-71 (C4): reprice now cross-checks against a canonical feed. Default the source to
  // "no canonical listing" so tests stay hermetic (no real CoinGecko HTTP); individual tests
  // override it. With no canonical, reconcile keeps the provider price and flags 'unverified'.
  _setCanonicalPriceSource({ byContract: async () => null });
});

afterAll(async () => {
  await truncateAllUserData();
  await prisma.token.deleteMany({ where: { symbol: { in: SYMBOLS } } });
  _resetCanonicalPriceSource();
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
  // retrofit-71: no canonical listing (stub returns null) → provider price kept, flagged unverified.
  expect(autoAfter.priceConfidence).toBe('unverified');
  const cmcAfter = await prisma.token.findUniqueOrThrow({ where: { id: cmcToken.id } });
  expect(Number(cmcAfter.currentPrice)).toBe(2);
  expect(cmcAfter.priceConfidence).toBeNull(); // CMC row untouched
});

it('r71-reprice: canonical feed overrides a provider price >25% off and flags verified; within tolerance keeps provider', async () => {
  const userId = await makeUser();
  const portfolioId = await makeConnectedPortfolio(userId, WALLET_A);

  // SYM_AUTO: provider price 3.7× the canonical (the PEPU case) → canonical wins, verified.
  // SYM_AUTO_B: provider within 25% of canonical → provider kept, verified.
  const offToken = await prisma.token.create({
    data: { symbol: SYM_AUTO, name: 'Off Price', currentPrice: '0', autoListed: true, contractAddress: CONTRACT_AUTO },
  });
  const okToken = await prisma.token.create({
    data: { symbol: SYM_AUTO_B, name: 'Ok Price', currentPrice: '0', autoListed: true, contractAddress: CONTRACT_AUTO_B },
  });
  await prisma.asset.create({ data: { portfolioId, tokenId: offToken.id, balance: '1' } });
  await prisma.asset.create({ data: { portfolioId, tokenId: okToken.id, balance: '1' } });

  // Canonical prices keyed by contract.
  _setCanonicalPriceSource({
    byContract: async (_slug, contract) => {
      if (contract.toLowerCase() === CONTRACT_AUTO) return 0.0000242; // real PEPU-ish
      if (contract.toLowerCase() === CONTRACT_AUTO_B) return 100; // close to provider 95
      return null;
    },
  });

  fetchWalletSummaryMock.mockResolvedValue({
    nativeSymbol: 'ETH', nativeBalance: 0, totalUsd: 0, tokenCount: 2,
    tokens: [
      { symbol: SYM_AUTO, name: 'Off Price', contractAddress: CONTRACT_AUTO, balance: 1, decimals: 18, usdPrice: 0.00009, usdValue: 0, isNative: false },
      { symbol: SYM_AUTO_B, name: 'Ok Price', contractAddress: CONTRACT_AUTO_B, balance: 1, decimals: 18, usdPrice: 95, usdValue: 95, isNative: false },
    ],
    provider: 'moralis',
  });

  const r = await repriceConnectedTokens();
  expect(r.repriced).toBe(2);

  // Off-by-3.7× provider price overridden by canonical; flagged verified.
  const offAfter = await prisma.token.findUniqueOrThrow({ where: { id: offToken.id } });
  expect(Number(offAfter.currentPrice)).toBeCloseTo(0.0000242, 10);
  expect(offAfter.priceConfidence).toBe('verified');

  // Within-tolerance provider price kept; still flagged verified (we had a canonical reference).
  const okAfter = await prisma.token.findUniqueOrThrow({ where: { id: okToken.id } });
  expect(Number(okAfter.currentPrice)).toBe(95);
  expect(okAfter.priceConfidence).toBe('verified');
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
