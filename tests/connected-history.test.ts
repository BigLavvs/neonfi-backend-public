// Neonfi backend — connected value-history provenance (retrofit-85, H11 deep).
//
// rebuildConnectedHistory re-pulls the provider's REAL historical value series and writes each
// point with its provenance: provider-priced points (fetchValueHistory — GoldRush portfolio_v2 /
// Zerion / Mobula, historically priced) → approx=false; the bounded Moralis to_block tail
// (~current-priced estimate) → approx=true. The historical write is an approx-GUARDED upsert: it
// UPGRADES prior approx=true estimates but never clobbers a REAL (approx=false) row.
//
// Strategy: real DB, direct Prisma seeding (no HTTP). wallet-data/index.js is mocked so
// fetchValueHistory is controllable; the Moralis tail uses global fetch (stubbed in the tail test).

import { it, beforeEach, afterAll, expect, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { truncateAllUserData } from './helpers.js';

// Control the provider value-history; stub the other fns sync.ts imports from index.js so the
// module mock is complete (rebuild only ever calls fetchValueHistory + currentConnectedValue).
const { fetchValueHistoryMock } = vi.hoisted(() => ({ fetchValueHistoryMock: vi.fn() }));
vi.mock('../src/modules/wallet-data/index.js', () => ({
  previewWallet: vi.fn(),
  fetchWalletSummary: vi.fn(),
  fetchTransferPage: vi.fn(),
  fetchNftHoldings: vi.fn().mockResolvedValue(null),
  fetchSpamContracts: vi.fn().mockResolvedValue(new Set()),
  fetchWalletSpamContracts: vi.fn().mockResolvedValue(new Set()), // retrofit-86 (H13.1)
  fetchTransactionCount: vi.fn().mockResolvedValue(null),
  fetchValueHistory: fetchValueHistoryMock,
  fetchWalletPnl: vi.fn().mockResolvedValue(null),
}));

import { rebuildConnectedHistory } from '../src/modules/wallet-data/sync.js';

const DAY = 86_400_000;
const ymd = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString().slice(0, 10);
const dayDate = (d: string): Date => new Date(`${d}T00:00:00.000Z`);

async function createConnectedPortfolio(): Promise<{ portfolioId: number; userId: number }> {
  const [authProvider, onboarding, type, chain] = await Promise.all([
    prisma.authProvider.findUniqueOrThrow({ where: { name: 'email' } }),
    prisma.onboardingStatus.findUniqueOrThrow({ where: { name: 'complete' } }),
    prisma.portfolioType.findUniqueOrThrow({ where: { name: 'connected' } }),
    prisma.chain.findUniqueOrThrow({ where: { slug: 'eth' } }),
  ]);
  const user = await prisma.user.create({
    data: { email: `r85.${Date.now()}@neonfi.test`, fullName: 'R85', authProviderId: authProvider.id, onboardingStatusId: onboarding.id },
  });
  const portfolio = await prisma.portfolio.create({
    data: { userId: user.id, name: 'R85 Wallet', typeId: type.id, chainId: chain.id, walletAddress: '0xr85wallet' },
  });
  // One BTC asset so currentConnectedValue (today's stitch) is > 0.
  const btc = await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } });
  await prisma.asset.create({ data: { portfolioId: portfolio.id, tokenId: btc.id, balance: 1 } });
  return { portfolioId: portfolio.id, userId: user.id };
}

async function loadPortfolio(portfolioId: number) {
  return prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId }, include: { type: true, chain: true } });
}

async function snapshotMap(portfolioId: number): Promise<Map<string, { value: number; approx: boolean }>> {
  const rows = await prisma.balanceSnapshot.findMany({ where: { portfolioId } });
  const m = new Map<string, { value: number; approx: boolean }>();
  for (const r of rows) m.set(r.snapshotDate.toISOString().slice(0, 10), { value: Number(r.value.toString()), approx: r.approx });
  return m;
}

beforeEach(async () => {
  await prisma.balanceSnapshot.deleteMany({});
  await truncateAllUserData();
  fetchValueHistoryMock.mockReset();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.balanceSnapshot.deleteMany({});
});

// ---------------------------------------------------------------------------
// r85-provenance: provider points → approx=false; guarded upsert upgrades prior estimates but
// never clobbers a REAL (approx=false) row.
// ---------------------------------------------------------------------------

it('r85-provenance: provider-priced history is written approx=false; upgrades estimates, protects real rows', async () => {
  const { portfolioId, userId } = await createConnectedPortfolio();

  // Provider series spans near the window start (oldest ~1090d) so the Moralis tail is SKIPPED
  // (earliest ≤ windowStart+7d) — this isolates the provider/provenance path with no network.
  const dOld = ymd(1090 * DAY);
  const dMid = ymd(100 * DAY);
  const dRecent = ymd(2 * DAY);
  fetchValueHistoryMock.mockResolvedValue([
    { date: dOld, value: 10 },
    { date: dMid, value: 20 },
    { date: dRecent, value: 30 },
  ]);

  // Pre-seed: an approx=true ESTIMATE at dMid (should be UPGRADED to the provider value), and a
  // REAL approx=false daily-job row at dRecent (should be PROTECTED — provider value must NOT win).
  await prisma.balanceSnapshot.createMany({
    data: [
      { portfolioId, userId, snapshotDate: dayDate(dMid), value: '111', approx: true },
      { portfolioId, userId, snapshotDate: dayDate(dRecent), value: '999', approx: false },
    ],
  });

  const portfolio = await loadPortfolio(portfolioId);
  expect(await rebuildConnectedHistory(portfolio)).toBe(true);

  const snaps = await snapshotMap(portfolioId);
  // dOld: newly inserted with provider value → approx=false.
  expect(snaps.get(dOld)).toEqual({ value: 10, approx: false });
  // dMid: prior approx=true estimate (111) UPGRADED to provider value (20) + approx=false.
  expect(snaps.get(dMid)).toEqual({ value: 20, approx: false });
  // dRecent: REAL approx=false row PROTECTED — keeps 999, the provider's 30 did not overwrite it.
  expect(snaps.get(dRecent)).toEqual({ value: 999, approx: false });
  // today: corrected current balance, real → approx=false.
  const today = ymd(0);
  expect(snaps.get(today)?.approx).toBe(false);
  expect(snaps.get(today)!.value).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// r85-tail: the deep gap a priced provider can't reach is filled by the Moralis to_block sampler
// and stays approx=true (path 3 — the honest dashed estimate), while recent provider days are
// approx=false.
// ---------------------------------------------------------------------------

it('r85-tail: Moralis to_block tail is approx=true; recent provider days approx=false', async () => {
  const { portfolioId } = await createConnectedPortfolio();

  // Provider only covers the last couple of days → the older gap (>1wk before) is tail-filled.
  const dRecent = ymd(2 * DAY);
  fetchValueHistoryMock.mockResolvedValue([{ date: dRecent, value: 30 }]);

  // Stub the Moralis sampler's two calls: dateToBlock → a block; tokens?to_block → one priced row.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('dateToBlock')) return { ok: true, json: async () => ({ block: 1234 }) } as Response;
    if (u.includes('/tokens?')) return { ok: true, json: async () => ({ result: [{ usd_value: 5, possible_spam: false }] }) } as Response;
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }));

  const portfolio = await loadPortfolio(portfolioId);
  await rebuildConnectedHistory(portfolio);

  const snaps = await snapshotMap(portfolioId);
  // The recent provider day is real.
  expect(snaps.get(dRecent)).toEqual({ value: 30, approx: false });
  // At least one OLDER tail point exists, valued at the sampled $5, marked approx=true.
  const tail = [...snaps.entries()].filter(([d]) => d < dRecent);
  expect(tail.length).toBeGreaterThan(0);
  expect(tail.every(([, v]) => v.approx === true && v.value === 5)).toBe(true);
  // today still real.
  expect(snaps.get(ymd(0))?.approx).toBe(false);
});
