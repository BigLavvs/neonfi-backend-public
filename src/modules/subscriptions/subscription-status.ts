// Neonfi backend — shared "effectively active" subscription predicate.
//
// A subscription is effectively active when it is either explicitly active, OR
// cancelled-but-still-within-the-paid-period (Build Guide §4.7: "subscription still
// functions as Pro until currentPeriodEnd"). Five callers across the codebase use this
// identical rule — this helper is the single source of truth for it.

/** Minimal shape required from a subscription to evaluate liveness. */
export interface SubscriptionLiveness {
  status: { name: string };
  currentPeriodEnd: Date | null;
}

/**
 * Returns true when the subscription should be treated as active for access-control
 * purposes. Pass `now` in tests to drive the comparison deterministically.
 */
export function isSubscriptionEffectivelyActive(
  sub: SubscriptionLiveness,
  now: Date = new Date(),
): boolean {
  return (
    sub.status.name === 'active' ||
    (sub.status.name === 'cancelled' &&
      sub.currentPeriodEnd !== null &&
      sub.currentPeriodEnd > now)
  );
}
