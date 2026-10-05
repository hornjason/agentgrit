---
description: All implementation work must go through the ship workflow — never spawn agents directly
---

## Ship Workflow Required

When shipping an issue or implementing code changes, use the ship workflow:

```
Skill("ship")  →  Workflow({ scriptPath: "workflows/ship.js" })
```

**NEVER spawn Marcus, Quinn, or Rook directly with the Agent tool.** The ship workflow captures transcripts, runs compliance grading, and enforces gates. Spawning agents directly bypasses all measurement.

If Skill("harness") or Skill("goal") fails, fall back to Skill("ship") with the issue number.
