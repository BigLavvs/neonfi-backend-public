function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// Aggregate per-portfolio snapshot series into one chart series. For each kept date,
// sum each portfolio's most recent snapshot value ON OR BEFORE that date (forward-fill);
// a portfolio with no snapshot yet contributes 0. This keeps the total from dipping when
// a newer portfolio simply has fewer points than an older one.
//
// retrofit-81: each output point also carries `approx` — true when ANY portfolio whose
// forward-filled snapshot feeds this date's sum is itself an estimate (backfilled balance ×
// ~today's price). The connected wallet's entire pre-first-real-snapshot history is approx, so
// the early span of the timeline flags as estimated while the recent daily points are real. A
// portfolio contributing 0 (no snapshot on/before this date) does NOT taint the flag.
export function buildValueHistory(
  snapshotsList: Array<Array<{ snapshotDate: Date; value: { toString(): string }; approx: boolean }>>,
  days: number,
): Array<{ date: string; value: number; approx: boolean }> {
  // Per-portfolio [date, value, approx] arrays, ASC by date (the repo already orders ASC).
  const series = snapshotsList.map((snaps) =>
    snaps.map((s) => ({
      date: s.snapshotDate.toISOString().slice(0, 10),
      value: Number(s.value.toString()),
      approx: s.approx === true,
    })),
  );

  const allDates = new Set<string>();
  for (const s of series) {
    for (const point of s) allDates.add(point.date);
  }
  if (allDates.size === 0) return [];

  // YYYY-MM-DD sorts lexicographically == chronologically. Keep only the last `days`.
  const keptDates = [...allDates].sort().slice(-days);

  const points = keptDates.map((date) => {
    let sum = 0;
    let approx = false;
    for (const s of series) {
      // Most recent value on/before `date`. Series is ASC, so the last point with
      // point.date <= date wins; once we pass `date` we can stop.
      let v = 0;
      let contributed = false;
      let pointApprox = false;
      for (const point of s) {
        if (point.date <= date) {
          v = point.value;
          pointApprox = point.approx;
          contributed = true;
        } else break;
      }
      sum += v;
      // Only a portfolio that actually contributes a snapshot can flag the aggregate point as
      // estimated — a portfolio still at its implicit 0 (no snapshot yet) is not an estimate.
      if (contributed && pointApprox) approx = true;
    }
    return { date, value: round(sum), approx };
  });

  // retrofit-67: trim the leading run of $0 points so already-persisted pre-funding zero
  // snapshots stop charting as a flat tail (no fresh resync needed). On the aggregate series
  // leading zeros only occur before ANY selected portfolio held value, so this is correct
  // there too; interior zeros are preserved; an all-zero series returns [].
  const firstNonZero = points.findIndex((p) => p.value > 0);
  if (firstNonZero === -1) return [];
  return firstNonZero === 0 ? points : points.slice(firstNonZero);
}

