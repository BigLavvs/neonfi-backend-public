// Parses simple duration strings (e.g. "15m", "7d") used for token/cookie
// lifetimes.  Supported units: s, m, h, d, w.

const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function parseDurationToMs(duration: string): number {
  const match = /^(\d+)(s|m|h|d|w)$/.exec(duration);
  if (!match || !match[1] || !match[2]) {
    throw new Error(`Invalid duration string: "${duration}". Expected e.g. "15m", "7d".`);
  }
  const unit = UNITS[match[2]];
  if (unit === undefined) throw new Error(`Unrecognised duration unit: "${match[2]}"`);
  return parseInt(match[1], 10) * unit;
}

export function parseDurationToSeconds(duration: string): number {
  return Math.floor(parseDurationToMs(duration) / 1000);
}
