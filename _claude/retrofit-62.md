# retrofit-62 — Fix the pre-existing live-price 383 test failure

The full suite has carried exactly one failure since **retrofit-28**: `tests/overview.test.ts` test
**383** (the live-price allocation case). It's pre-existing — not caused by any recent retrofit — but
"green suite" should mean green, so fix it.

## Why it fails
retrofit-28 deliberately **removed the per-request live-price overlay from the overview
allocation/holdings path** — the CLIENT now owns the live overlay (it recomputes from the firehose ×
balance, with the daily/stored `currentPrice` as the fallback). `overview.service.ts` allocation now
reads `a.token.currentPrice` (no live `price:<SYMBOL>` map). Test 383 still asserts the **old** behavior
(allocation reflecting the live overlay), so it fails against the current, intended code.

## Fix
Update test 383 to assert the **current** behavior: allocation/holdings use the stored/daily
`currentPrice`, and the live overlay is a client concern (totals stay live via `computeDerived`, which
keeps its own overlay — that part is unchanged). Read `overview.service.ts`'s allocation loop to confirm
the exact current numbers and rewrite the assertion to match.

- The retrofit-28 design (client owns the live allocation overlay) stands — **do NOT re-introduce the
  server-side overlay** just to make the old assertion pass.
- Edge case: if on reading you find the *code* actually still references a live map in the allocation
  path (i.e. the behavior regressed, not just the test), fix the code instead. Per retrofit-28 the test
  is the stale side, but verify rather than assume.

## Validate
- Overview suite green including 383.
- Full suite: 606 pass / 1 skip (#300) / **0 fail**.
