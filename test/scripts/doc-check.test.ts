import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type CascadeMap,
  type Measurement,
  checkCascade,
  checkTestCountDrift,
  checkVersionChangelog,
  headings,
  loadCascadeMap,
  matchingHeadings,
  parseBunPassCount,
  parseTestCountClaims,
  renderReport,
  validateCascadeMap,
  versionOf,
} from "../../scripts/doc-check";

const ROOT = resolve(import.meta.dir, "..", "..");

describe("doc-cascade-map.json describes the repo as it actually is", () => {
  // This is the regression. Issue #171 specified `src/capture/* -> README
  // section "Signal Capture"`, but README's heading is
  // "1. Capture — Signal Collection", and src/evaluate, src/scoring and
  // src/showcase were left out of the map entirely. Shipped as written, the
  // cascade check would have reported nothing for those four directories and
  // looked clean doing it.
  test("every cascade target and test-count row resolves against the real docs", () => {
    const problems = validateCascadeMap(ROOT, loadCascadeMap(ROOT));
    expect(problems).toEqual([]);
  });

  test("every directory under src/ is accounted for", () => {
    const map = loadCascadeMap(ROOT);
    for (const dir of ["src/capture", "src/evaluate", "src/scoring", "src/showcase"]) {
      expect(Object.keys(map.cascade)).toContain(dir);
    }
  });
});

describe("validateCascadeMap catches a map that has stopped matching", () => {
  const base = (): CascadeMap => loadCascadeMap(ROOT);

  test("rejects the section name #171 asked for, because README has no such heading", () => {
    const map = base();
    map.cascade["src/capture"] = {
      targets: [{ doc: "README.md", section: "Signal Capture" }],
    };
    const problems = validateCascadeMap(ROOT, map);
    expect(problems).toContain('src/capture → README.md has no heading containing "Signal Capture"');
  });

  test("rejects an unmapped src/ directory rather than silently skipping it", () => {
    const map = base();
    delete map.cascade["src/capture"];
    expect(validateCascadeMap(ROOT, map).join("\n")).toContain("src/capture exists but has no entry");
  });

  test("rejects emptying the targets of a directory the docs name explicitly", () => {
    // The cheap wrong fix for a broken section reference is to blank the
    // targets. SYSTEM-SPEC's heading literally contains `(src/capture/)`, so
    // the map is required to carry a target for it.
    const map = base();
    map.cascade["src/capture"] = { targets: [], undocumented: "shrug" };
    expect(validateCascadeMap(ROOT, map).join("\n")).toContain(
      "documents src/capture, but doc-cascade-map.json gives src/capture no targets",
    );
  });

  test("rejects an empty targets list with no reason", () => {
    const map = base();
    map.cascade["src/showcase"] = { targets: [] };
    expect(validateCascadeMap(ROOT, map).join("\n")).toContain("no `undocumented` reason");
  });

  test("rejects an ambiguous section reference", () => {
    const map = base();
    map.cascade["src/capture"] = { targets: [{ doc: "README.md", section: "e" }] };
    expect(validateCascadeMap(ROOT, map).join("\n")).toContain("the reference is ambiguous");
  });

  test("rejects a test-count row that has been renamed out from under the check", () => {
    const map = base();
    map.testCounts = { ...map.testCounts, "Area That Does Not Exist": "test/capture" };
    expect(validateCascadeMap(ROOT, map).join("\n")).toContain(
      'testCounts area "Area That Does Not Exist" has no "N tests pass" row',
    );
  });

  test("rejects a test path that no longer exists", () => {
    const map = base();
    map.testCounts = { ...map.testCounts, "Signal capture": "test/does-not-exist" };
    expect(validateCascadeMap(ROOT, map).join("\n")).toContain("which does not exist");
  });
});

describe("headings", () => {
  test("reads ATX headings and ignores fenced code", () => {
    const md = ["# Title", "", "```sh", "# not a heading", "```", "", "### 1. Capture — Signal Collection"].join("\n");
    expect(headings(md)).toEqual(["Title", "1. Capture — Signal Collection"]);
  });

  test("matches a section as a substring of the heading", () => {
    const md = "### 6. Graph — Knowledge Retrieval";
    expect(matchingHeadings(md, "Knowledge Retrieval")).toEqual(["6. Graph — Knowledge Retrieval"]);
    expect(matchingHeadings(md, "Signal Capture")).toEqual([]);
  });
});

describe("checkCascade", () => {
  const map: CascadeMap = {
    version: 1,
    cascade: {
      "src/graph": {
        targets: [
          { doc: "README.md", section: "Knowledge Retrieval" },
          { doc: "docs/SYSTEM-SPEC.md", section: "Context Injection" },
        ],
      },
      "src/showcase": { targets: [], undocumented: "no section covers it" },
    },
    testCounts: {},
    testCountDoc: "docs/SYSTEM-SPEC.md",
  };

  test("fires when src/ moves and the docs do not", () => {
    const f = checkCascade(["src/graph/bm25.ts"], map);
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain("README.md");
    expect(f[0].message).toContain("docs/SYSTEM-SPEC.md");
  });

  test("names only the docs that were missed", () => {
    const f = checkCascade(["src/graph/bm25.ts", "README.md"], map);
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain("docs/SYSTEM-SPEC.md");
    expect(f[0].message).not.toContain("README.md");
  });

  test("stays quiet when every target doc moved too", () => {
    expect(checkCascade(["src/graph/bm25.ts", "README.md", "docs/SYSTEM-SPEC.md"], map)).toEqual([]);
  });

  test("stays quiet for a directory with no doc target", () => {
    expect(checkCascade(["src/showcase/template.ts"], map)).toEqual([]);
  });

  test("does not treat a prefix collision as a hit", () => {
    expect(checkCascade(["src/graphics/thing.ts"], map)).toEqual([]);
  });
});

describe("checkVersionChangelog", () => {
  test("fires on a bump with no changelog edit", () => {
    const f = checkVersionChangelog(["package.json"], "0.2.0", "0.2.1");
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain("0.2.0 → 0.2.1");
  });

  test("silent when the changelog moved too", () => {
    expect(checkVersionChangelog(["package.json", "CHANGELOG.md"], "0.2.0", "0.2.1")).toEqual([]);
  });

  test("silent when package.json changed but the version did not", () => {
    expect(checkVersionChangelog(["package.json"], "0.2.0", "0.2.0")).toEqual([]);
  });

  test("silent when the base version cannot be read, rather than claiming a bump", () => {
    expect(checkVersionChangelog(["package.json"], null, "0.2.1")).toEqual([]);
  });

  test("versionOf returns null on unparseable input instead of throwing", () => {
    expect(versionOf("{ not json")).toBeNull();
    expect(versionOf('{"name":"x"}')).toBeNull();
    expect(versionOf('{"version":"1.2.3"}')).toBe("1.2.3");
  });
});

describe("test-count drift", () => {
  const spec = [
    "| Area | Status | Reference |",
    "|------|--------|-----------|",
    "| Signal capture | COMPLETE | 216 tests pass |",
    "| Pattern detection | COMPLETE | 47 tests pass |",
    "| Graph + injection | SHIPPED (hybrid) | BM25 + vector |",
  ].join("\n");

  test("parses only the rows that claim a count", () => {
    expect(parseTestCountClaims(spec)).toEqual({ "Signal capture": 216, "Pattern detection": 47 });
  });

  test("reports the delta when live differs from the doc", () => {
    const f = checkTestCountDrift(spec, { "Signal capture": { kind: "count", value: 339 } });
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain("doc says 216 tests pass, live run says 339 (+123)");
  });

  test("silent when the doc matches", () => {
    expect(checkTestCountDrift(spec, { "Signal capture": { kind: "count", value: 216 } })).toEqual([]);
  });

  test("reports UNMEASURED rather than treating a crashed run as zero", () => {
    const f = checkTestCountDrift(spec, {
      "Signal capture": { kind: "unmeasured", why: "no `N pass` summary line" },
    });
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain("UNMEASURED");
    expect(f[0].message).not.toContain("(-216)");
  });

  test("reports a missing row rather than skipping the area", () => {
    const f = checkTestCountDrift(spec, { "Rule promotion": { kind: "count", value: 370 } });
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain("UNMEASURED");
  });

  test("parseBunPassCount reads the summary line out of combined output", () => {
    const out = ["test/capture/foo.test.ts:", "(pass) does a thing", "", " 339 pass", " 0 fail", ""].join("\n");
    expect(parseBunPassCount(out)).toEqual({ kind: "count", value: 339 });
  });

  test("parseBunPassCount refuses to invent a zero when bun printed no summary", () => {
    const m: Measurement = parseBunPassCount("error: Cannot find module 'rungate/lib/conformity'");
    expect(m.kind).toBe("unmeasured");
  });
});

describe("renderReport", () => {
  test("is empty when nothing is wrong, so the workflow posts no comment", () => {
    expect(renderReport([], [])).toBe("");
  });

  test("surfaces map problems above the findings", () => {
    const md = renderReport(
      [{ check: "cascade", message: "`src/graph/` changed" }],
      ["src/capture → README.md has no heading containing \"Signal Capture\""],
    );
    expect(md.indexOf("out of step")).toBeLessThan(md.indexOf("Source changed"));
    expect(md).toContain("<!-- agentgrit-doc-check -->");
  });
});

describe("the workflow wiring matches the script", () => {
  const yml = readFileSync(join(ROOT, ".github/workflows/doc-check.yml"), "utf8");

  test("asks for the comment permission the comment step needs", () => {
    expect(yml).toContain("pull-requests: write");
  });

  test("runs the script this test covers", () => {
    expect(yml).toContain("scripts/doc-check.ts");
  });

  test("skips the comment on forks, where the token is read-only regardless", () => {
    expect(yml).toContain("github.event.pull_request.head.repo.fork == false");
  });

  test("triggers on pull_request and never on pull_request_target", () => {
    // Matched against trigger keys, not prose: the file explains in a comment
    // why pull_request_target is the wrong shape here, and a naive substring
    // check would trip on the explanation.
    const triggerKeys = /^on:\n((?:[ \t].*\n|\n)*)/m.exec(yml)?.[1] ?? "";
    expect(triggerKeys).toMatch(/^ {2}pull_request:$/m);
    expect(triggerKeys).not.toMatch(/^\s*pull_request_target:/m);
  });

  test("never fails the build", () => {
    expect(yml).toContain("continue-on-error: true");
  });
});
