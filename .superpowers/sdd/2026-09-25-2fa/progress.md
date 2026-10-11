# SDD ledger — plan: docs/superpowers/plans/2026-09-25-2fa.md
BASE: 004d1a56da3f9bc48dc6b8b776def30a8f624a52 (branch feat/f5.17-2fa)

## Pre-flight scan (shared files / interfaces)
| Tasks | Produces vs consumes | Finding |
|---|---|---|
| T1 -> T5 | T1 produces env.REQUIRE_ADMIN_2FA; T5 consumes in login gate | match: boolean after transform |
| T2 -> T4 | T2 produces User.totp* + RecoveryCode; T4 consumes via prisma | match: field names as spec'd |
| T3 -> T5/T6/T7 | T3 produces 2FA Zod schemas + AuditAction strings; T5-7 consume | match: names in plan header |
| T4 -> T5 | T4 produces TwoFactorService methods; T5 consumes | match: signatures per Task 4 Interfaces block |
| T5 -> T6/T7 | T5 produces HTTP contracts; T6/T7 consume | match: 202 challenge shape, /2fa/* paths |
| T4 self | confirmSetup test uses decrypt() helper; impl encrypts | match, no plaintext persisted |

Ruling: Task 1 implementer must NOT run pnpm add (user-install rule) — do env flag only, list packages, verify env typecheck. Cost if wrong: blocked Task 4 typecheck until user installs; mitigated by starting env part now.
Ruling: Task 4 plan text does createMany then backfill hashes in two passes — wasteful but harmless; implementer may simplify to hash-then-createMany in one pass if tests stay green. Cost if wrong: none, fewer DB roundtrips.

Task 1: fix round 1/5 (3 addressed, 0 open; commits 95cb262..ef661a1)
Task 1: complete (commits 004d1a5..aa953c3, review clean after 1 fix round; deps installed by user, committed aa953c3)

Task 2: complete (commits aa953c3..0c3acbb, review clean; migrate honestly blocked - no DB, schema valid via generate)

Task 3: complete (commits 0c3acbb..b6a813e, review clean)
Ruling: LoginNeeds2FAResponse dropped from plan — named in Task 3 Produces but never defined in steps; Task 5 returns the 202 shape inline and Task 6 narrows with 'requires2FA' in-check, so no shared type is needed. Cost if wrong: trivial to add later if a consumer wants it.

Task 4: fix round 1/5 (stale-codes ADDRESSED; 4 new: 3 open, 1 deferred)
Ruling: non-atomic delete+create downgraded to deferred minor — failure window leaves user with zero unused codes but setup retry regenerates them; \ would complicate the hand-mocked prisma fake disproportionate to a recoverable error path. Cost if wrong: failed confirm needs a retry, already the UX for any confirm error.

Task 4: fix round 2/5 (3 addressed, 0 open; commits d6e549a..7520845)
Task 4: complete (commits b6a813e..7520845, review clean; 1 deferred minor: non-atomic delete+create, recoverable via retry)

Task 5: fix round 1/3 (3 addressed, 0 open; commits 455ae83..526ddda)
Task 5: complete (commits 7520845..526ddda, review clean)

Task 6: complete (commits 526ddda..484728e, review clean; live matrix owed when servers up)

Task 7: fix round 1/3 (2 addressed, 0 open; commits a8d35d7..c091380)
Task 7: complete (commits 484728e..c091380, review clean)
