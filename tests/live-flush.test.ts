// Neonfi backend — live price → Token.currentPrice flush tests (retrofit-70 fix #2).
//
// flushLivePricesToCurrentPrice writes the canonical live `price:<SYM>` ticks back into
// Token.currentPrice. Token is the SHARED seed catalog (not cleaned by truncateAllUserData),
// so each test snapshots + restores the touched tokens' currentPrice and clears the live
// ticks (price:* in the test Redis db) so neighbouring suites still see the seeded prices.

import { it, beforeEach, afterEach, expect } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { flushLivePricesToCurrentPrice } from '../src/modules/tokens/live-flush.js';

let btcId: number;
let ethId: number;
let btcOrig: string;
let ethOrig: string;

function tick(price: number): string {
  return JSON.stringify({ price, change24h: 1, source: 'coinbase', ts: 1700000000000 });
}

beforeEach(async () => {
  const btc = await prisma.token.findUniqueOrThrow({ where: { symbol: 'BTC' } });
  const eth = await prisma.token.findUniqueOrThrow({ where: { symbol: 'ETH' } });
  btcId = btc.id;
  ethId = eth.id;
  btcOrig = btc.currentPrice.toString();
  ethOrig = eth.currentPrice.toString();
  // Start from a clean live-price slate so the flush only sees what each test sets.
  const keys = await redis.keys('price:*');
  if (keys.length) await redis.del(...keys);
});

afterEach(async () => {
  await prisma.token.update({ where: { id: btcId }, data: { currentPrice: btcOrig } });
  await prisma.token.update({ where: { id: ethId }, data: { currentPrice: ethOrig } });
  const keys = await redis.keys('price:*');
  if (keys.length) await redis.del(...keys);
});

it('r70: flush writes the live tick into Token.currentPrice; tokens without a tick are untouched', async () => {
  // BTC gets a fresh live tick that differs from its stored currentPrice; ETH gets none.
  await redis.set('price:BTC', tick(123456.78), 'EX', 60);

  const { updated } = await flushLivePricesToCurrentPrice();
  expect(updated).toBe(1); // only BTC had a (changed) tick

  const btc = await prisma.token.findUniqueOrThrow({ where: { id: btcId } });
  expect(Number(btc.currentPrice.toString())).toBeCloseTo(123456.78, 2); // live price persisted

  const eth = await prisma.token.findUniqueOrThrow({ where: { id: ethId } });
  expect(eth.currentPrice.toString()).toBe(ethOrig); // no tick → untouched
});

it('r70: a live tick equal to currentPrice is a no-op (no write churn)', async () => {
  await redis.set('price:BTC', tick(Number(btcOrig)), 'EX', 60);

  const { updated } = await flushLivePricesToCurrentPrice();
  expect(updated).toBe(0); // unchanged price skipped by the `<>` guard
});
