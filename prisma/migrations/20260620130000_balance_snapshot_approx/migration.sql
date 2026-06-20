-- retrofit-77 (N1): provenance flag on balance_snapshot. true = backfilled ESTIMATE
-- (connected initial-sync net-worth-at-block, approximate); false = REAL observed snapshot
-- (daily job + live "today" stitch). The short-term (24h/7d/30d) baseline lookup filters to
-- approx=false so a freshly-synced wallet shows "—" until real snapshots accrue, rather than a
-- garbage delta off an inflated backfill point. Existing rows default false (safe: long-lived
-- portfolios already have real daily snapshots winning the nearest-match).
ALTER TABLE "balance_snapshot" ADD COLUMN "approx" BOOLEAN NOT NULL DEFAULT false;
