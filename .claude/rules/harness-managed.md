---
description: Files managed by rungate scaffold — do not edit directly
paths:
  - ".github/workflows/**"
  - ".claude/agents/**"
  - "CODE-MAP.md"
  - "test/scaffold-conformity.test.ts"
---

These files are managed by rungate and regenerated on re-scaffold. **Do not edit them directly.**

| File | How to customize | What NOT to do |
|------|-----------------|----------------|
| `.github/workflows/ci.yml` | Set `ci` fields in `.claude/rungate.json` | Don't edit the YAML |
| `.github/workflows/gates.yml` | Settings from `.claude/rungate.json` | Don't edit the YAML |
| `.claude/agents/*.md` | Settings from `.claude/rungate.json` | Don't edit briefs |
| `test/scaffold-conformity.test.ts` | Runs automatically | Don't edit |
| `CODE-MAP.md` | Auto-generated from code scan | Don't edit |
