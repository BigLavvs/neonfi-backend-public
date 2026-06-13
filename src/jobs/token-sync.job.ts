import cron from 'node-cron';
import { config } from '../lib/config.js';
import { runTokenMetadataSync } from '../modules/tokens/sync/sync.js';

export function startTokenSyncScheduler(): void {
  if (!config.TOKEN_SYNC_ENABLED) {
    console.log('[token-sync] disabled via env (TOKEN_SYNC_ENABLED=false)');
    return;
  }
  const expr = config.TOKEN_SYNC_CRON;
  cron.schedule(expr, async () => {
    try {
      await runTokenMetadataSync();
    } catch (e) {
      // Never crash the scheduler — log + continue
      console.error('[token-sync] uncaught error:', e);
    }
  });
  console.log(`[token-sync] scheduler started (cron: ${expr})`);
}
