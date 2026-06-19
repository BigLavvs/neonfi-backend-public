import cron from 'node-cron';
import { config } from '../lib/config.js';
import { flushLivePricesToCurrentPrice } from '../modules/tokens/live-flush.js';

// retrofit-70 fix #2: keep Token.currentPrice fresh between the 6-hourly CMC syncs by
// flushing the live canonical price ticks into it on a short interval. Gated by
// LIVE_PRICE_FLUSH_ENABLED, started only outside tests (src/index.ts).
export function startLivePriceFlushScheduler(): void {
  if (!config.LIVE_PRICE_FLUSH_ENABLED) {
    console.log('[live-price-flush] disabled via env (LIVE_PRICE_FLUSH_ENABLED=false)');
    return;
  }
  const expr = config.LIVE_PRICE_FLUSH_CRON;
  cron.schedule(expr, async () => {
    try {
      const r = await flushLivePricesToCurrentPrice();
      console.log(`[live-price-flush] done — updated:${r.updated}`);
    } catch (e) {
      // Never crash the scheduler — log + continue.
      console.error('[live-price-flush] uncaught error:', e);
    }
  });
  console.log(`[live-price-flush] scheduler started (cron: ${expr})`);
}
