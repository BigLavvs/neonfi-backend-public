import cron from 'node-cron';
import { config } from '../lib/config.js';
import { repriceConnectedTokens } from '../modules/wallet-data/reprice.js';

export function startConnectedRepriceScheduler(): void {
  if (!config.CONNECTED_REPRICE_ENABLED) {
    console.log('[connected-reprice] disabled via env (CONNECTED_REPRICE_ENABLED=false)');
    return;
  }
  const expr = config.CONNECTED_REPRICE_CRON;
  cron.schedule(expr, async () => {
    try {
      const r = await repriceConnectedTokens();
      console.log(`[connected-reprice] done — wallets:${r.wallets} repriced:${r.repriced}`);
    } catch (e) {
      // Never crash the scheduler — log + continue.
      console.error('[connected-reprice] uncaught error:', e);
    }
  });
  console.log(`[connected-reprice] scheduler started (cron: ${expr})`);
}
