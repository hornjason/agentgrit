---
description: Which spec governs which area — read the governing spec before changing that area
---

## Specs Routing

Read the governing spec BEFORE making changes in that area. Every file in
`specs/` must have a row here: `HYGIENE-4` in the conformity run reads this
table and fails on a spec that is not listed.

| Spec | Governs | Testable |
|------|---------|----------|
| _(none yet)_ | `specs/` currently holds only `SPEC-TEMPLATE.md`, which documents how to write a spec and governs nothing | — |

`SPEC-TEMPLATE.md` is excluded by the check itself and deliberately has no row.

## Adding a spec

Create it with `bunx rungate create-spec "title"`, then add its row here in the
same commit. A spec with no row fails the conformity run, and the failure names
the file — not this table — so the next reader has to find their way back here.
