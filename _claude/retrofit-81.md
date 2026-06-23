# retrofit-81 — Restore the full value-history timeline (revert retrofit-79 §3's over-omit)

## What broke (regression I introduced in retrofit-79 §3)
§3 changed `findAllSnapshotsAscByPortfolio` to filter `approx = false` to hide the connected
wallet's fake cliff. But that read also feeds the **aggregate value chart**, and the connected
portfolio's entire multi-year history is `approx=true` backfill — so filtering it dropped the whole
3-year span. The dashboard "Portfolio Value" chart now starts at the **manual portfolio's creation
date** (recent) instead of the **oldest portfolio's inception** (~3 years). That regresses
retrofit-72 (union manual + connected timelines), which deliberately starts the line at the
longest-lived portfolio.

Live confirmation: `/overview` now returns `valueHistory` length **2** (Jun 19 $12.22, Jun 20
$16.34) and `connectedValueHistory` length **2** — the multi-year series is gone.

The mistake: omitting the estimate to avoid a misleading *shape* also deleted the *timeline* the
user relies on. The right move is to KEEP the timeline and MARK the estimated portion, not discard it.

## Fix
1. **Revert the `approx` filter** on `findAllSnapshotsAscByPortfolio` (snapshots.repository.ts) —
   serve ALL snapshots again so the chart spans every portfolio's full life (oldest inception →
   today). This restores retrofit-72's union timeline. (retrofit-77/78's SHORT-TERM baseline filter
   in `findSnapshotAtOrBefore` stays — that's a different read and is correct; this revert is ONLY
   the chart/history read.)
2. **Expose provenance instead of hiding it.** Add `approx: boolean` to each value-history point in
   the payloads that feed charts:
   - overview `valueHistory` + `connectedValueHistory` (overview.dto + service),
   - analytics `performance` snapshots (analytics.dto + service).
   A point is `approx=true` if its source snapshot is approx (backfill estimate). Real daily
   snapshots are `approx=false`.
3. **Frontend (Cowork) — render the estimate distinctly.** In intraday.ts / the chart components,
   draw the `approx=true` segment as a dashed/greyed "estimated" line (with an "estimated history"
   legend/marker), and the `approx=false` segment as the solid real line. Keep the union-timeline
   merge (retrofit-72) intact. This gives the user the full timeline AND honesty about which part is
   an estimate — neither the fake-solid-cliff nor the 2-point stub.

## Note (still open, separate)
The estimated values remain approximate (H11 — historical balance × ~today's price), so the dashed
segment can still show a rough shape (e.g. the step down to the first real snapshot). The dashed
styling labels it as an estimate; the proper cure is the accurate historical reconstruction (real
per-block balances × historical prices), which stays deferred. retrofit-81 is specifically about not
DELETING the timeline.

## Validate
- `/overview` `valueHistory` spans from the oldest portfolio's inception again (not 2 points); ALL
  and 1Y ranges start ~3 years back for this account, not at the manual portfolio's createdAt.
- Each value-history point carries `approx`; the connected pre-first-real-snapshot points are
  `approx=true`, the Jun-19-onward daily points `approx=false`.
- Frontend: chart shows the full span with the estimated portion visually distinct from real.
- overview + analytics suites green; add: value-history includes approx-flagged points (not filtered
  out), and a manual-only portfolio's history is unaffected (all approx=false).
