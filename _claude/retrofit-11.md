# retrofit-11: backend boot fix — js-sha3 ESM interop

The backend fails to boot under the real runtime (`tsx`/`node`) with:

```
SyntaxError: The requested module 'js-sha3' does not provide an export named 'keccak256'
    at src/lib/moralis-signature.ts:11
```

`js-sha3` is CommonJS and assembles its exports dynamically, so Node's ESM lexer can't
expose `keccak256` as a named import. **The vitest loader synthesizes CJS interop
differently, so the whole test suite passed while the app couldn't start** — a
runtime-vs-test gap that hid the bug until the first real `npm run dev`.

## Already patched in the working tree (verify, then commit)
The only two `import { keccak256 } from 'js-sha3'` occurrences (confirmed by grep across src):
- `src/lib/moralis-signature.ts`
- `src/modules/webhooks/moralis-handlers.ts` (uses `keccak256` at the event-hash, line ~156)

Both changed to default-import + destructure, with an explanatory comment so it isn't reverted:
```ts
import jsSha3 from 'js-sha3';
// ...
const { keccak256 } = jsSha3;
```
This form is robust across `tsx`, `node`, and vitest. Import-only change — no behavior change.

## Do
1. Verify both files use the default-import form (already edited in the tree — don't re-break them).
2. **Boot check (the real regression test the suite can't do):** start the server (`npm run dev`)
   and confirm it reaches `[neonfi-backend] listening on http://localhost:3000`, then stop it.
3. Run the suite (per-file / Neon-retry) — confirm still green; the Moralis-webhook signature
   tests in particular must still pass (they exercise `verifyMoralisSignature`).
4. Commit explicitly (no `git add -A`):
   ```bash
   git add src/lib/moralis-signature.ts src/modules/webhooks/moralis-handlers.ts _claude/retrofit-11.md
   git commit -m "fix(boot): js-sha3 default-import so the backend starts under tsx/node (retrofit-11)"
   ```
   Leave the stale `_claude/stage-14*.md` / `frontend-audit.md` untracked.

## Follow-up (flag, not in this commit)
The suite can't catch CJS-named-import boot failures (vitest loader ≠ tsx/node). Worth a tiny
**boot smoke-test** in CI — e.g. a step that does `tsx -e "await import('./src/app.ts')"` (or
`node --check` of the built entry) and fails on a SyntaxError — so this class of bug fails CI
rather than the first real boot. (Pairs with the CI/CD pipeline that's still on the to-do list.)
