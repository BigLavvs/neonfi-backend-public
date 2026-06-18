// Neonfi backend — Decimal(20,8) string formatter (retrofit-49 §5).
//
// Mirrors the frontend `toDecimalString` helper: turns any provider number/string into a
// clean decimal string that Prisma's Decimal(20,8) columns accept. Connected-wallet imports
// (sync.ts) feed raw provider amounts/gas/usd values straight into Transaction details, and
// a meme-token balance can be huge or carry >8 fractional digits or arrive in scientific
// notation — any of which makes Prisma reject the write. This normalizes every such value:
//   - no scientific notation (Number.toFixed never emits an exponent below 1e21),
//   - clamped to 8 fractional digits (the column scale),
//   - trailing zeros (and a dangling '.') trimmed,
//   - CLAMPED to the Decimal(20,8) magnitude (≤ 12 integer digits) so an overflow stores the
//     clamped max + logs once instead of throwing,
//   - non-finite / negative inputs collapse to '0' (amounts/gas/usd are non-negative; the
//     transaction's direction carries the sign, never the magnitude).

// Decimal(20,8): precision 20, scale 8 ⇒ at most 12 integer digits. The largest representable
// value is 12 nines before the point and 8 after. Numbers up to ~1e12 stay inside the JS
// double safe-integer range (2^53 ≈ 9e15), so no integer precision is lost on the way in.
const MAX_DECIMAL_20_8 = 999999999999.99999999;

export function toDecimalString(value: number | string | null | undefined): string {
  let n = typeof value === 'string' ? Number(value) : (value ?? 0);
  if (typeof n !== 'number' || !Number.isFinite(n)) n = 0;
  // Magnitude only — direction encodes buy/sell, so a stray negative is meaningless here.
  if (n < 0) n = 0;
  if (n > MAX_DECIMAL_20_8) {
    console.warn(
      `[decimal] value ${String(value)} exceeds Decimal(20,8); clamping to ${MAX_DECIMAL_20_8}`,
    );
    n = MAX_DECIMAL_20_8;
  }
  // toFixed(8): exactly the column scale, never an exponent for n < 1e21. Trim the trailing
  // zeros it pads (and a now-dangling '.') so '100.00000000' → '100', '0.50000000' → '0.5'.
  let s = n.toFixed(8);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}
