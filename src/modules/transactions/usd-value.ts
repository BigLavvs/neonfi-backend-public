// Neonfi backend — USD-value-at-write-time helper (retrofit-2).
//
// Computes the USD value of a transaction at write-time. Used by createTransaction
// (manual) and createTransactionFromWebhook (Stage 11 / Moralis). Price priority:
//   1. Redis live cache `price:<SYMBOL>` (60s TTL, written by the Coinbase WS —
//      see src/lib/coinbase.ts:110). Payload is JSON {price, change24h, timestamp}.
//   2. DB fallback: Token.currentPrice for that symbol.
//   3. No price available: 0 + warn. Better than failing — connected portfolios in
//      particular can have webhooks arrive faster than tokens get seeded.
//
// MVP simplification (LOCKED, retrofit-2 §1.2/§1.3): this is the CURRENT price at
// write-time. Historical transactions get the current price too, so PnL is
// approximate. A follow-up retrofit could backfill from CMC historical data if
// accuracy matters; out of scope here.
//
// Cross-module note: this helper queries the Token table directly (cross-module).
// Deliberate exception — it's a one-line price read with no domain logic; routing
// it through tokens.service for a single lookup on every transaction adds
// indirection without benefit. Same rationale as auth/plan.ts's direct
// subscription read.

import { redis } from '../../lib/redis.js';
import { prisma } from '../../lib/prisma.js';

export async function computeUsdValue(symbol: string, amount: string): Promise<string> {
  const cached = await redis.get(`price:${symbol}`);
  let price: number | null = null;

  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { price?: number };
      if (typeof parsed.price === 'number' && Number.isFinite(parsed.price)) {
        price = parsed.price;
      }
    } catch {
      // ignore — fall through to DB
    }
  }

  if (price === null) {
    const token = await prisma.token.findUnique({
      where: { symbol },
      select: { currentPrice: true },
    });
    if (token) price = Number(token.currentPrice.toString());
  }

  if (price === null) {
    console.warn(`[usd-value] no price for ${symbol}; defaulting usdValue=0`);
    return '0';
  }

  const amt = Number(amount);
  const usd = amt * price;
  // Keep Decimal(20,8) precision when serializing
  return usd.toFixed(8);
}
