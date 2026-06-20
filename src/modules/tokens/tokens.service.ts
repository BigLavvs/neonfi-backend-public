import { getLivePriceMap } from '../../lib/live-price.js';
import { getEffectivePlan } from '../subscriptions/subscriptions.service.js';
import {
  findManyTokens,
  findTokenById,
  findExistingTokenSymbols,
  findTokenPriceSnapshotsSince,
  aggregateTokenPriceExtremes,
} from './tokens.repository.js';
import { normalizeSymbol } from '../../lib/bulk-import.js';
import {
  toTokenListDTO,
  toTokenDetailDTO,
  type TokenListDTO,
  type TokenDetailDTO,
  type TokenHistoryDTO,
} from './tokens.dto.js';
import type { ListTokensQuery } from './tokens.schemas.js';

// Round a price to the column's wire scale (Decimal(20,8) → 8dp). Snapshot prices read
// back from the DB are already exact; this mainly strips IEEE-754 noise off the live
// price (a Redis JSON float) without flattening sub-cent tokens the way 2dp would.
function roundPrice(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

// retrofit-71 (C6): below this many REAL daily snapshot rows the chart can't honestly be drawn as
// "history" (a freshly auto-listed token has ~2), so the DTO flags `limitedHistory` and the UI
// shows "limited history" instead of a fabricated line.
const MIN_REAL_HISTORY_POINTS = 7;

export class TokenError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

export async function listTokens(
  userId: number,
  query: ListTokensQuery,
): Promise<{ tokens: TokenListDTO[]; meta: { limit: number; nextCursor: number | null } }> {
  const effectivePlan = await getEffectivePlan(userId);
  const freeTier = effectivePlan !== 'pro';
  const cursor = query.cursor ?? null;

  const rows = await findManyTokens({ cursor, limit: query.limit, search: query.search, freeTier });

  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const nextCursor = hasMore ? (items[items.length - 1]!.id) : null;

  // retrofit-15: overlay live `price:<SYMBOL>` ticks over the seeded currentPrice for
  // the symbols on this page; a miss falls back to currentPrice.
  const priceMap = await getLivePriceMap(items.map((t) => t.symbol));

  return {
    tokens: items.map((t) => toTokenListDTO(t, priceMap.get(t.symbol))),
    meta: { limit: query.limit, nextCursor },
  };
}

// retrofit-87: read-only pre-import check for the CSV-import preview. Normalizes the input
// (trim + upper-case + dedup, drop blanks) so it matches the canonical catalog symbol, then
// returns the ones that DON'T resolve — upper-cased — so the frontend can flag unknown tokens
// per-row without holding the catalog client-side. Uses the same Token.symbol resolution as
// the single transaction/asset create, so a symbol that passes here will import.
export async function validateSymbols(symbols: string[]): Promise<{ unknown: string[] }> {
  const normalized = [...new Set(symbols.map(normalizeSymbol).filter((s) => s.length > 0))];
  if (normalized.length === 0) return { unknown: [] };
  const found = await findExistingTokenSymbols(normalized);
  return { unknown: normalized.filter((s) => !found.has(s)) };
}

export async function getTokenById(id: number): Promise<TokenDetailDTO> {
  const token = await findTokenById(id);
  if (!token) {
    throw new TokenError(404, 'TOKEN_NOT_FOUND', 'Token not found');
  }
  // retrofit-15: prefer the live tick for this symbol; miss falls back to currentPrice.
  const priceMap = await getLivePriceMap([token.symbol]);
  return toTokenDetailDTO(token, priceMap.get(token.symbol));
}

// retrofit-21: daily price history for the token-detail chart + ATH/ATL.
//
// Source: the `token_price_snapshot` rows sampled daily by snapshot.job.ts (one per
// token per UTC day) — so history is sparse until the job has run, exactly like the
// portfolio balance chart. The "now" end of the chart and the high/low folding use the
// LIVE price, which getTokenById already overlays onto `token.currentPrice`
// (getLivePriceMap ?? Token.currentPrice) — so we reuse it rather than re-reading Redis.
//
// ATH/ATL semantics: high/low SINCE TRACKING BEGAN (min/max over ALL snapshots, folded
// with the live price), NOT a true all-time high/low — CMC's quote doesn't expose those.
export async function getTokenPriceHistory(id: number, days: number): Promise<TokenHistoryDTO> {
  // 404 first, via the existing TokenError path. The returned DTO's `currentPrice` is
  // the already-resolved live price (overlay applied in getTokenById).
  const token = await getTokenById(id);
  const live = token.currentPrice;

  // Window cutoff at UTC midnight, mirroring snapshot.job.ts/snapshots.service —
  // never local-time setDate arithmetic, which drifts across timezone boundaries.
  const todayYmd = new Date().toISOString().slice(0, 10);
  const today = new Date(`${todayYmd}T00:00:00.000Z`);
  const since = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);

  const [rows, extremes] = await Promise.all([
    findTokenPriceSnapshotsSince(id, since),
    aggregateTokenPriceExtremes(id),
  ]);

  const points = rows.map((r) => ({
    date: r.snapshotDate.toISOString().slice(0, 10),
    price: roundPrice(r.price),
  }));

  // End the chart at "now": if today's snapshot doesn't exist yet (job hasn't run today),
  // append a live point so the series reaches the current price.
  const last = points[points.length - 1];
  if (!last || last.date !== todayYmd) {
    points.push({ date: todayYmd, price: roundPrice(live) });
  }

  // ATH/ATL = max/min over all snapshots, folded with the live price. No snapshots yet →
  // both collapse to the live price.
  const ath = roundPrice(extremes.max != null ? Math.max(extremes.max, live) : live);
  const atl = roundPrice(extremes.min != null ? Math.min(extremes.min, live) : live);

  // retrofit-71 (C5): these are extremes SINCE TRACKING BEGAN, never a true provider ATH/ATL —
  // tell the UI so it doesn't mislabel them "All-Time".
  const athAtlBasis = 'tracked' as const;
  // retrofit-71 (C6): flag a series too short to honestly chart as history (count the REAL daily
  // snapshot rows, before the appended live "now" point) so the UI shows "limited history" rather
  // than a fabricated 2-point line. Freshly auto-listed tokens accrue ≤2 points until the daily
  // job has run for a while.
  const limitedHistory = rows.length < MIN_REAL_HISTORY_POINTS;

  return { points, ath, atl, athAtlBasis, limitedHistory };
}
