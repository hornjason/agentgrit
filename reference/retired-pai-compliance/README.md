---
doc-type: reference
status: active
owner: jason
updated: 2026-10-05
---

# Retired PAI compliance tests

Retired 2026-10-05 as part of the AgentGrit cutover.

These two files (18 tests) asserted that files existed inside the live PAI install —
`~/.claude/PAI/output-types/`, `~/.claude/skills/ship/gates/verify-campaign.sh`,
`~/.claude/MEMORY/...`. Neither imports a single line of AgentGrit source. They tested
PAI's ship harness from inside AgentGrit's suite.

They were kept while AgentGrit and PAI ran side by side. The cutover retires PAI, so
holding them would mean wiring AgentGrit tighter to the system being removed, and 11 of
the 18 were already failing because PAI's layout had moved on underneath them.

Kept as `.retired` rather than deleted so the assertions stay readable if any of this
behaviour needs reimplementing on the AgentGrit side. They are outside `test/` and the
`.retired` suffix keeps them out of `bun test` discovery.
