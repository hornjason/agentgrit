---
doc-type: spec
status: draft
owner: [name]
created: [YYYY-MM-DD]
updated: [YYYY-MM-DD]
governs: [intent — "I want to..." language, e.g. "Fix scaffold output, change what files get generated". This drives the AGENTS.md routing table. Write once, be specific.]
testable: false
---

# [Spec Title]

## Problem Statement

[What gap, risk, or need this spec addresses. 2-3 sentences max.]

## Design Decisions

[Key decisions. Use a table for multiple:]

| Decision | What | Rationale |
|---|---|---|
| D-1 | [decision] | [why] |

## Target State

[What the system looks like when this spec is fully implemented.]

## Success Criteria

Each SC must be parseable by the conformity test generator (`lib/conformity.ts` → `matchPattern()`). SCs that don't match a pattern generate a warning but don't fail tests.

### Recognized Patterns

<!-- BEGIN GENERATED PATTERNS -->
Use these exact patterns for auto-testable SCs:

#### file-exists
**Syntax:** `{file} exists [at root] [<= N lines]`

**Example:** `- [ ] SC-N: AGENTS.md exists`

**Notes:** Checks that a file exists at the project root. Optionally checks line count with <= N lines suffix.

#### dir-exists
**Syntax:** `{dir}/ directory exists [with >= N {type}]`

**Example:** `- [ ] SC-N: specs/ directory exists`

**Notes:** Checks that a directory exists. Supports aliases (test/tests, reference/ref). Optional minimum file count.

#### all-specs-frontmatter
**Syntax:** `all specs have frontmatter`

**Example:** `- [ ] SC-N: all specs have frontmatter`

**Notes:** Validates that every spec in specs/ has YAML frontmatter with a testable field. Skips status: split files.

#### paths-resolve
**Syntax:** `all paths referenced in {file} resolve`

**Example:** `- [ ] SC-N: all paths referenced in AGENTS.md resolve`

**Notes:** Scans markdown links in the target file and verifies each local path resolves. Skips http and anchor links.

#### root-clean
**Syntax:** `root is clean [content: <= N] [code: <= N]`

**Example:** `- [ ] SC-N: root is clean`

**Notes:** Checks that the project root has a reasonable number of top-level items. Content projects default to 10, code projects to 30.

#### pointer-exists
**Syntax:** `{file} exists with pointer to {target}`

**Example:** `- [ ] SC-N: CLAUDE.md exists with pointer to AGENTS.md`

**Notes:** Checks that a file exists AND contains a reference to the target string.

#### test-passes
**Syntax:** `bun test passes`

**Example:** `- [ ] SC-N: bun test passes`

**Notes:** Placeholder assertion that always passes. Actual test execution is handled by the CI pipeline.

#### canary
**Syntax:** `canary`

**Example:** `- [ ] SC-N: canary test exists`

**Notes:** Checks that a conformity or canary test file exists in the test/ directory.

#### content-contains
**Syntax:** `{file} contains [{item1}, {item2}, ...]`

**Example:** `- [ ] SC-N: AGENTS.md contains [Project Identity, Rules]`

**Notes:** Checks that a file contains all listed items. Items are comma-separated inside brackets.

#### content-not-contains
**Syntax:** `{file} must NOT contain [{item1}, {item2}, ...]`

**Example:** `- [ ] SC-N: AGENTS.md must NOT contain [deprecated-section]`

**Notes:** Checks that a file does NOT contain any of the listed items. Supports both 'must NOT contain' and 'has no' syntax.

#### count-threshold
**Syntax:** `{file} is under [{N}] lines|words`

**Example:** `- [ ] SC-N: AGENTS.md is under [200] lines`

**Notes:** Checks that a file is under a threshold of lines or words. Supports both 'is under' and 'at most' syntax.

#### json-field-equals
**Syntax:** `{file} {field} field equals [{value}]`

**Example:** `- [ ] SC-N: package.json name field equals [rungate]`

**Notes:** Checks that a JSON file's field has the expected value. Supports nested fields with dot notation (e.g., config.name).

#### section-exists
**Syntax:** `{file} has section [{SectionName}]`

**Example:** `- [ ] SC-N: AGENTS.md has section [Rules]`

**Notes:** Checks that a markdown file has a heading matching the section name. Matches any heading level (# through ######).

#### regex-match
**Syntax:** `{file} matches /{pattern}/[flags]`

**Example:** `- [ ] SC-N: AGENTS.md matches /^# /m`

**Notes:** Checks that a file's content matches the given regular expression. Supports standard regex flags.

#### source-contains
**Syntax:** `harness {file} contains [{keywords}]`

**Example:** `- [ ] SC-N: harness lib/conformity.ts contains [matchPattern, runScaffoldConformity]`

**Notes:** Checks that a harness source file (lib/, scripts/, hooks/, gates/) contains listed keywords. Requires 'harness' prefix or source path prefix.

#### json-has-field
**Syntax:** `{file}.json has field {name}`

**Example:** `- [ ] SC-N: package.json has field scripts`

**Notes:** Checks that a JSON file has the specified field defined. Supports nested fields with dot notation.

#### scaffold-produces
**Syntax:** `scaffold output {file} exists`

**Example:** `- [ ] SC-N: scaffold output AGENTS.md exists`

**Notes:** Checks that a scaffold-generated file exists. Currently validates file presence; future versions will run scaffold and verify output.

#### frontmatter-field
**Syntax:** `{file} frontmatter has {field} [= {value}]`

**Example:** `- [ ] SC-N: specs/CONFIG-DRIVEN-TESTING-SPEC.md frontmatter has testable = true`

**Notes:** Checks YAML frontmatter in a file. Verifies field exists, optionally checks its value. Used for spec and agent file metadata.

#### file-line-range
**Syntax:** `{file} is between [{min}] and [{max}] lines`

**Example:** `- [ ] SC-N: AGENTS.md is between [50] and [300] lines`

**Notes:** Checks that a file's line count falls within a range (inclusive). Useful for ensuring files are neither too short nor too long.
<!-- END GENERATED PATTERNS -->

### Writing Effective SCs

**DO:**
- Use exact pattern syntax from above
- Be specific about filenames and paths
- Use measurable criteria (line counts, file counts)
- Start with simplest patterns first

**DON'T:**
- Use vague language ("should", "might", "consider")
- Mix multiple criteria in one SC (split them)
- Use absolute paths (`~/`, `/Users/`) — use relative paths
- Write SCs that require human judgment

**Pattern not available?** Complex criteria need custom test code in phase test files (see `test/phase-*.test.ts`).

---

- [ ] SC-1: [first criterion]
- [x] SC-2: [second criterion]
- [ ] SC-A1: [anti-criterion — must NOT happen]

## Implementation

[Steps to implement. Optional — can reference issues instead.]

## Cautions

[Things that could go wrong. What to verify before/after.]
