---
doc-type: reference
status: active
owner: jhorn
updated: 2026-10-19
---

# What we are building, and how we will know it worked

## The thing

AgentGrit turns what went wrong in one session into a rule the next session
actually loads — without anyone being asked to write it down.

## What this is not

It is not a logger, and it is not an analytics dashboard over past sessions.
Recording that a correction happened is the cheap half and the half that
looks like progress. The product is the rule arriving in the next session's
context; everything upstream of that is plumbing. A version of this that
captured perfectly and injected nothing would be a total failure wearing a
full database.

## The claims

All four below are stated as things that can be shown false, and each carries
the command that would show it. Every one is failing today, with the issue
number that tracks it — a claim recorded as met without a measurement beside
it is the thing this file exists to prevent.

### Claim 1 — Every captured correction reaches the detector

A signal that cannot be parsed must not be able to stop the ones that can.

**How it fails:** one malformed record aborts the whole detection pass, so a
signal file that is 99% readable yields zero patterns. Concretely: 21 of 3011
records in `correction-captures.jsonl` carry `user_text` instead of
`correction_phrase`, and `failures.ts:59` dereferences the missing field.

**How to measure it:**
```bash
bun -e 'const {detectFailurePatterns}=await import("./src/detect/failures.ts");
        console.log((await detectFailurePatterns(process.env.HOME+"/.agentgrit/signals")).length)'
```
Prints a count, or throws. Throwing is the failure.

### Claim 2 — The rules it learns reach the next session

A rule on disk that no session loads has not been learned.

**How it fails:** rule files accumulate in `~/.agentgrit/rules/` while the
graph they are queried through goes stale, so every session falls back to the
same handful of rules and nobody notices because the fallback looks like an
answer.

**How to measure it:** `agentgrit doctor` reports 0 rule files missing from
the graph, and `~/.agentgrit/context/GRAPH-CONTEXT.md` carries domain-matched
rules with the current date — not the `# Graph Context — unavailable` banner,
which is the failure state rendered as prose.

### Claim 3 — The loop runs without being asked

A learning loop that needs a human to trigger it is a script.

**How it fails:** `daemon.interval` is set in config while nothing on the
machine schedules the daemon, so the config and reality disagree and the last
cycle recedes into the past silently.

**How to measure it:** `~/.agentgrit/logs/daemon.log` gains a cycle nobody
invoked by hand. `agentgrit doctor` fails — not warns — when an interval is
configured and no scheduler is registered.

### Claim 4 — A step that did not run says so

The failure mode that costs the most is the one that reports a number.

**How it fails:** a step whose command never executed writes a plausible
result anyway. Concretely: test-cache spawns `bun test` in `$HOME/agentgrit`,
which does not exist; `?? ""` turns the null output into an empty string and
`{"pass":0,"fail":0}` is written as though measured. It never appears in the
daemon's error list, so it is invisible in exactly the way a real result is.

**How to measure it:** point a daemon step at an unreachable target and
confirm it surfaces an error rather than a zero. `0`, `{}` and `SKIP` are
indistinguishable from success; `UNMEASURED` is not.

## Standing

| Claim | Standing | Measured |
|---|---|---|
| 1 — corrections reach the detector | **failing** | 2026-10-19 — throws on `signal.correction_phrase.slice`; 0 patterns detected. #254 |
| 2 — learned rules reach the session | **failing** | 2026-10-19 — 44 of 47 rule files absent from graph; GRAPH-CONTEXT.md frozen 2026-10-05 at the unavailable banner. #258 |
| 3 — the loop runs unasked | **failing** | 2026-10-19 — no launchd agent, no crontab entry; `daemon.log` ends 2026-10-17 03:00. #259 |
| 4 — a step that did not run says so | **failing** | 2026-10-19 — `test-results.json` reads `{"pass":0,"fail":0}` from a spawn in a nonexistent cwd. #256 |
