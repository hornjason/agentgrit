import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type RegistryQuery,
  decidePublish,
  normalizeTag,
  parseRegistryVersions,
} from "../../scripts/publish-preflight";

const ROOT = resolve(import.meta.dir, "..", "..");

const published = (...versions: string[]): RegistryQuery => ({ ok: true, versions });

describe("normalizeTag", () => {
  test("strips the leading v that GitHub release tags carry", () => {
    expect(normalizeTag("v0.2.1")).toBe("0.2.1");
  });

  test("leaves an already-bare version alone", () => {
    expect(normalizeTag("0.2.1")).toBe("0.2.1");
  });

  test("does not strip a v that is part of the version itself", () => {
    // "1.0.0-vendor.1" must not become "1.0.0-endor.1".
    expect(normalizeTag("1.0.0-vendor.1")).toBe("1.0.0-vendor.1");
  });
});

describe("parseRegistryVersions", () => {
  test("reads the normal multi-version array", () => {
    const q = parseRegistryVersions(0, '["0.1.9","0.2.0"]', "");
    expect(q).toEqual({ ok: true, versions: ["0.1.9", "0.2.0"] });
  });

  test("handles the single-version case, where npm view returns a bare string", () => {
    // `npm view pkg versions --json` on a package with exactly one version
    // emits `"0.1.0"`, not `["0.1.0"]`. Treating that as 'not an array, so no
    // versions' would let a republish of the only existing version through.
    expect(parseRegistryVersions(0, '"0.1.0"', "")).toEqual({ ok: true, versions: ["0.1.0"] });
  });

  test("treats E404 as a package that has never been published", () => {
    const q = parseRegistryVersions(1, "", "npm error code E404\nnpm error 404 Not Found");
    expect(q).toEqual({ ok: true, versions: [] });
  });

  test("fails closed when the registry cannot be reached", () => {
    // The dangerous default here is 'no versions found, so go ahead'. A
    // network blip would then look identical to a brand-new package.
    const q = parseRegistryVersions(1, "", "npm error code ENOTFOUND registry.npmjs.org");
    expect(q.ok).toBe(false);
  });

  test("fails closed on output that is not JSON at all", () => {
    expect(parseRegistryVersions(0, "<html>proxy error</html>", "").ok).toBe(false);
  });
});

describe("decidePublish", () => {
  test("publishes a bumped version that is not yet on the registry", () => {
    const d = decidePublish({
      tag: "v0.2.1",
      pkgVersion: "0.2.1",
      registry: published("0.1.9", "0.2.0"),
    });
    expect(d.action).toBe("publish");
  });

  test("publishes the very first version of a package with no releases", () => {
    const d = decidePublish({ tag: "v0.1.0", pkgVersion: "0.1.0", registry: published() });
    expect(d.action).toBe("publish");
  });

  // This is run 31038878645, reproduced. On 2026-08-05 the workflow checked
  // out v0.1.7, built it, authenticated, signed a provenance statement into
  // the Sigstore transparency log, and only then discovered that 0.1.7 had
  // been published by hand eighteen minutes earlier. It exited 1 and the
  // release showed a red X. Nothing was wrong except that there was nothing
  // left to do, and that is a skip, not a failure.
  test("skips, rather than failing, when the version is already on the registry", () => {
    const d = decidePublish({
      tag: "v0.1.7",
      pkgVersion: "0.1.7",
      registry: published("0.1.6", "0.1.7"),
    });
    expect(d.action).toBe("skip");
    expect(d.reason).toContain("0.1.7");
  });

  // The state of main today: package.json says 0.2.0 and npm already has
  // 0.2.0. Cutting a release right now without a version bump is this case.
  test("skips a release cut against an un-bumped package.json", () => {
    const d = decidePublish({
      tag: "v0.2.0",
      pkgVersion: "0.2.0",
      registry: published("0.1.9", "0.2.0"),
    });
    expect(d.action).toBe("skip");
  });

  test("fails when the release tag and package.json disagree", () => {
    // Tagging v0.3.0 against a package.json still reading 0.2.0 would
    // silently publish 0.2.0 — or, worse, succeed while publishing something
    // nobody asked for under a tag that claims otherwise.
    const d = decidePublish({
      tag: "v0.3.0",
      pkgVersion: "0.2.0",
      registry: published("0.2.0"),
    });
    expect(d.action).toBe("fail");
    expect(d.reason).toContain("0.3.0");
    expect(d.reason).toContain("0.2.0");
  });

  test("fails rather than publishing when the registry could not be read", () => {
    const d = decidePublish({
      tag: "v0.2.1",
      pkgVersion: "0.2.1",
      registry: { ok: false, reason: "ENOTFOUND" },
    });
    expect(d.action).toBe("fail");
  });

  test("checks tag agreement before it checks the registry", () => {
    // A mismatched tag is a mistake worth surfacing even if the version
    // happens to already be published; reporting 'already published' there
    // would hide the real problem behind a green skip.
    const d = decidePublish({
      tag: "v9.9.9",
      pkgVersion: "0.2.0",
      registry: published("0.2.0"),
    });
    expect(d.action).toBe("fail");
  });
});

// The decision logic above is worthless if publish.yml stops consulting it.
// Deleting the `if:` from the publish step would leave every test in this file
// green while npm publish ran unconditionally again — exactly the shape
// .claude/rules/checks-must-be-able-to-fail.md is about.
describe("publish.yml actually consults the preflight", () => {
  const yml = readFileSync(join(ROOT, ".github/workflows/publish.yml"), "utf8");

  test("runs the preflight script under the id the gate references", () => {
    expect(yml).toContain("bun scripts/publish-preflight.ts");
    expect(yml).toContain("id: preflight");
  });

  test("gates npm publish on the preflight's verdict", () => {
    expect(yml).toContain("if: steps.preflight.outputs.should_publish == 'true'");
  });

  test("passes the release tag by env, not by shell interpolation", () => {
    // ${{ ... }} spliced into a run: body is the GitHub Actions injection
    // footgun. The tag reaches the script as an environment variable.
    expect(yml).toContain("RELEASE_TAG: ${{ github.event.release.tag_name }}");
    expect(yml).not.toMatch(/run:.*\$\{\{\s*github\.event\.release/);
  });

  test("the preflight precedes the publish step", () => {
    expect(yml.indexOf("id: preflight")).toBeLessThan(yml.indexOf("npm publish"));
  });
});
