// Neonfi backend — shared CSV bulk-import helpers (retrofit-87).
//
// Pure validation/normalization shared by POST /portfolios/:id/transactions/bulk and
// POST /portfolios/:id/assets/bulk. The wording + accept/reject decisions MIRROR the
// frontend's client-side preview (Neonfi/src/lib/csv-import.ts) so the errors the server
// reports line up with the cells the preview already highlighted — but THIS layer is the
// authoritative gate (the FE mirror is UX only). Each bulk service ALSO re-validates every
// prepared row through the existing single-create Zod schema (transactions.schemas /
// assets.schemas) so bulk import can never accept something the single-create path rejects.

// Row cap for the two bulk endpoints — over this → 400 TOO_MANY_ROWS (not a generic 400).
export const BULK_ROW_CAP = 500;

// Decimal(20,8) magnitude bound — mirrors transactions.schemas' MAX_DECIMAL and the FE mirror.
// A value at/above this overflows the column, so it's rejected with a clean message here.
const MAX_DECIMAL = 1e12;

export interface BulkRowError {
  /** 1-based index of the offending row WITHIN the request `rows` array. */
  row: number;
  /** Offending CSV column name (e.g. `amount`, `symbol`, `gas_fee`), or null for a row-level issue. */
  column: string | null;
  /** Human, specific reason — e.g. "expected a number, got 'abc'". */
  message: string;
}

export type BulkMode = 'all_or_nothing' | 'skip_invalid';

export interface BulkResult {
  imported: number;
  skipped: number;
  errors: BulkRowError[];
}

// Thrown by the bulk services. `errors` is set only for the all_or_nothing validation
// failure (the controller then returns 400 carrying the full error list); structural
// failures (NOT_MANUAL, TOO_MANY_ROWS) leave it undefined and use the standard envelope.
export class BulkError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly errors?: BulkRowError[],
  ) {
    super(message);
    this.name = 'BulkError';
  }
}

// Non-negative decimal string — same shape the single-create Zod schemas accept.
const NUM_RE = /^\d+(\.\d+)?$/;

// Validate a numeric CSV cell. `positive` → strictly > 0; otherwise ≥ 0. Returns a human
// message (spec wording) or null when valid. Mirrors the FE mirror's numberError exactly.
export function numberCellError(value: string, opts: { positive: boolean }): string | null {
  if (!NUM_RE.test(value)) return `expected a number, got '${value}'`;
  const n = Number(value);
  if (opts.positive && !(n > 0)) return `must be greater than 0, got '${value}'`;
  if (n >= MAX_DECIMAL) return `is too large (must be under ${MAX_DECIMAL})`;
  return null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validate a YYYY-MM-DD CSV cell: well-formed, a real calendar date, not in the future.
// Returns the spec's single message on any failure, else null. Future cut-off uses
// end-of-today UTC so a same-day acquisition is accepted regardless of the server clock's
// time-of-day (mirrors the FE mirror's dateError).
export function dateCellError(value: string): string | null {
  const fail = `date must be YYYY-MM-DD and not in the future`;
  if (!DATE_RE.test(value)) return fail;
  const parts = value.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return fail;
  const todayEnd = new Date();
  todayEnd.setUTCHours(23, 59, 59, 999);
  if (dt.getTime() > todayEnd.getTime()) return fail;
  return null;
}

// YYYY-MM-DD → ISO at 00:00:00Z — the timestamp/date format the single-create paths expect.
export function ymdToIso(value: string): string {
  return `${value}T00:00:00.000Z`;
}

// Normalize a CSV symbol to the catalog's canonical form (trimmed, upper-cased) so it
// resolves against the unique Token.symbol exactly the way the single-create resolver does.
// The catalog stores upper-case symbols (BTC/ETH/USDT…) and the FE already upper-cases, so
// this keeps validate-symbols and the actual import in lock-step.
export function normalizeSymbol(value: string): string {
  return value.trim().toUpperCase();
}

// Read a field from a loose CSV-row object as a trimmed string. Missing/null → ''. Non-string
// (a client that sent a JSON number) → its String() form, so numeric cells still validate.
export function cellStr(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (v === undefined || v === null) return '';
  return (typeof v === 'string' ? v : String(v)).trim();
}
