// Neonfi backend — Users module contract notes (Part 1: NO endpoints here).
//
// This file exists only to fix two cross-cutting contract decisions in code so
// Stage 1 / Stage 2 inherit a settled answer. GET /users/me and PATCH /users/me
// are implemented in Stage 1/2, NOT in Part 1.

// =============================================================================
// GATE C — `name` vs `displayName` on GET /users/me  (resolved)
// -----------------------------------------------------------------------------
// GET /users/me returns `displayName` per the User resource rep. The SvelteKit
// client auth store does the `name = displayName ?? fullName` fallback when
// populating the session shape (frontend reads `user.name ?? user.displayName`,
// hooks.server.ts:61). Do NOT add a synthesized `name` field in the backend
// response, and do NOT add a `name` column — there is no `name` in the schema
// (§0.1 item 1; Build Guide §0.3 / Stage 1 / Part 5).
// =============================================================================

// =============================================================================
// GATE D — `emailVerified` exposure  (resolved: derive, do NOT add a column)
// -----------------------------------------------------------------------------
// `emailVerified` appears in the User resource rep (System_Architecture, item 2
// in the hierarchy) but is NOT a column on User in the schema (item 1). Absence
// in the schema beats presence in the rep — that is the whole point of the
// source-of-truth hierarchy (§0.1). So derive it at query time:
//
//     emailVerified = (onboardingStatus.name !== 'pending_verification')
//
// This is correct for every documented code path: email users start
// `pending_verification` and only leave it on the verify-link click; Google
// users start `verified` immediately. No schema deviation.
//
// CAVEAT for the future (do NOT act on this in Part 1 — it just protects the
// derivation): this holds ONLY while `pending_verification` is the SOLE
// unverified state. If email-change-with-re-verification is ever designed
// (post-MVP), revisit whether to (a) add an explicit `emailVerified` column
// then, (b) introduce a new onboarding state like `email_change_pending`, or
// (c) add a separate `email_verification_token` table. None of those are Part 1
// decisions; this note exists so a future onboarding-state addition does not
// silently break the derivation.
// =============================================================================

export {};
