// retrofit-34 — one-shot catalog seeder. `npm run seed:tokens` ingests the CMC top-N
// (TOKEN_CATALOG_SIZE, default 500) into the Token table, then exits. Needs
// COINMARKETCAP_API_KEY in the environment. Safe to re-run — runTokenCatalogIngest
// UPSERTs, so existing rows are refreshed rather than duplicated.

import { runTokenCatalogIngest } from '../modules/tokens/sync/catalog-ingest.js';

const size = Number(process.env.TOKEN_CATALOG_SIZE ?? 500);

runTokenCatalogIngest(size)
  .then((r) => {
    console.log(`[seed:tokens] done — inserted=${r.inserted} updated=${r.updated}`);
    process.exit(0);
  })
  .catch((e) => {
    console.error('[seed:tokens] failed:', e);
    process.exit(1);
  });
