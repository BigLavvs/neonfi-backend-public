# Neonfi backend — retrofit-9: NFT owner (C4a)

Commit 4a of the frontend-audit remediation (`_claude/frontend-audit.md`). Working dir:
`C:\Users\pelum\Desktop\neonfi-backend`. Previous commit: `08ff2db` (retrofit-8).

Surfaces `owner` on the NFT representation (frontend `NftDetailModal` expects it). **Derived, not stored:**
an NFT belongs to a connected portfolio, whose `walletAddress` IS the owner — so `owner` is the portfolio's
`walletAddress`, available in scope. No schema column (a stored column would only ever duplicate
`portfolio.walletAddress`). This is the clean realization of "add an owner field" — same reasoning as the C3
asset-fields decision. No schema delta, no migration.

**Deliberate divergence (docx-fix pile):** the NFT resource rep gains `owner` (derived).

## 0. Pre-verified state (re-verify before editing)

- `src/modules/nfts/nfts.dto.ts:3-20` — `NftDTO` (no `owner`). `:22-41` — `toNftDTO(nft)` takes only the Nft row.
- `src/modules/nfts/nfts.service.ts:16-24` — `listNfts(portfolio)`: NFTs returned ONLY for `portfolio.type.name === 'connected'` (manual → `[]`, line 19-21); `portfolio.walletAddress` is in scope and non-null for connected portfolios. `:26-35` — `getNftById(portfolio, nftId)`: also has `portfolio.walletAddress`.
- `toNftDTO` is called in exactly two places (verified grep): nfts.service.ts:23 and :34. No webhook/other caller — so changing the signature is safe and localized.
- `prisma/schema.prisma` Nft (388-415): no `owner` column — and we are NOT adding one.

## 1. Changes [LOCKED]
- `nfts.dto.ts`: `NftDTO` += `owner: string | null`. `toNftDTO(nft: Nft, owner: string | null): NftDTO` → set `owner` from the param. (Place it near `contractAddress`/`chain` in the shape.)
- `nfts.service.ts`: 
  - `listNfts`: `return nfts.map((n) => toNftDTO(n, portfolio.walletAddress));`
  - `getNftById`: `return toNftDTO(nft, portfolio.walletAddress);`
  - (`portfolio.walletAddress` is non-null for connected portfolios; type is `string | null`, which matches the DTO field.)

## 2. Scope
```
src/modules/nfts/nfts.dto.ts       # NftDTO += owner; toNftDTO(nft, owner)
src/modules/nfts/nfts.service.ts   # pass portfolio.walletAddress at both callsites
tests/nfts.test.ts                 # assert owner
```
No schema.prisma / migration. No webhook/repository change. No frontend (NftDetailModal's `collection`→`collectionName` / `blockchain`→`chain` renames + consuming `owner` are in the frontend pass).

## 3. Tests (mirror tests/nfts.test.ts)
- `GET /portfolios/:id/nfts` (connected, Pro) → each NFT DTO `owner` equals that portfolio's `walletAddress`.
- `GET /portfolios/:id/nfts/:nftId` → DTO `owner` equals the portfolio's `walletAddress`.
- Existing NFT tests stay green (the DTO just gains a field).

## 4. STOP-and-ask gates
1. If a third `toNftDTO` caller is found (none in grep), it must pass `owner` too — surface rather than default to null silently.

## 5. What NOT to do
- No `Nft.owner` schema column — `owner` is derived from the portfolio's `walletAddress`.
- No webhook/sync changes. No docx edits. No `git add -A`; leave stale `stage-14*.md` + `frontend-audit.md` untracked.

## 6. Commit and report
```bash
git add src/modules/nfts/nfts.dto.ts src/modules/nfts/nfts.service.ts \
        tests/nfts.test.ts _claude/retrofit-9.md
git commit -m "feat(nfts): surface NFT owner (derived from the portfolio wallet address) (retrofit-9)"
git log --oneline -3
```
Report: new SHA; NFT DTO showing `owner` = the connected portfolio's wallet address (list + detail); full suite count; doc-fix item (NFT rep gains derived `owner`). If blocked, output the question and STOP.
