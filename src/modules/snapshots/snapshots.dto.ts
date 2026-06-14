import type { BalanceSnapshot } from '@prisma/client';

// Snapshot resource representation (retrofit-3 §1.3). Mirrors the architecture
// resource rep verbatim (Neonfi System Architecture.docx, BalanceSnapshot rep):
//   { id, portfolioId, userId, value, snapshotDate, createdAt }
export interface SnapshotDTO {
  id: number;
  portfolioId: number;
  userId: number;
  // Decimal(20,8) → Number. Round-trips through string first to avoid float drift.
  value: number;
  // @db.Date column → Prisma returns a Date at UTC midnight. The rep shows a bare
  // calendar day ("2026-04-09"); slice the ISO string so timezone never shifts it.
  snapshotDate: string;
  // Hono serializes Date → ISO timestamp string in the response body.
  createdAt: Date;
}

export function toSnapshotDTO(snapshot: BalanceSnapshot): SnapshotDTO {
  return {
    id: snapshot.id,
    portfolioId: snapshot.portfolioId,
    userId: snapshot.userId,
    value: Number(snapshot.value.toString()),
    snapshotDate: snapshot.snapshotDate.toISOString().slice(0, 10),
    createdAt: snapshot.createdAt,
  };
}
