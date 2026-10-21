---
description: Specs routing table — which spec governs which area, read before changing that area
---

Read the governing spec BEFORE making changes in that area.

| Spec | Governs | Testable |
|------|---------|----------|
| _(none yet)_ | — | — |

`specs/SPEC-TEMPLATE.md` is not listed: it documents how to write a spec and
governs nothing.

## Adding a row

Every file you add under `specs/` needs a row here in the same commit. The row
is not paperwork — `HYGIENE-4` in `test/scaffold-conformity.test.ts` reads this
file and fails on any `specs/*.md` it cannot find, and without the file at all
the check skips, which reads exactly like a check that passed.

Take the `Governs` text from the spec's own `governs` frontmatter field and the
`Testable` column from `testable`, so the table and the spec cannot drift into
two different answers.
