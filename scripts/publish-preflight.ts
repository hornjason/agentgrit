/**
 * publish-preflight — decide whether a release should actually publish (#317).
 *
 * `publish.yml` has run three times, on 2026-08-05, and published nothing. Two
 * runs predated the `NPM_TOKEN` secret by five minutes. The third
 * (31038878645) authenticated, built, signed a provenance statement into the
 * Sigstore transparency log, and then failed `E403` on the final PUT because
 * 0.1.7 had been published by hand eighteen minutes earlier.
 *
 * So the workflow is not broken — it has never been handed a version that was
 * still publishable. Two guards make that difference visible before npm is
 * asked to do anything:
 *
 *   1. the release tag and package.json must name the same version;
 *   2. a version already on the registry is a no-op, not a red X.
 *
 * Both run before `npm publish`, so a release cut against an un-bumped
 * package.json reports "already published" and exits green instead of
 * signing provenance for a tarball the registry will refuse.
 *
 * Every exported function is pure so test/scripts/publish-preflight.test.ts
 * can drive it without npm, CI or a network. The IO lives in main() below.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type RegistryQuery = { ok: true; versions: string[] } | { ok: false; reason: string };

export interface PreflightInput {
  tag: string;
  pkgVersion: string;
  registry: RegistryQuery;
}

export interface Decision {
  action: "publish" | "skip" | "fail";
  reason: string;
}

/**
 * Strip the leading `v` of a release tag (`v0.2.1` → `0.2.1`).
 *
 * Only a `v` directly in front of a digit counts, so a prerelease such as
 * `1.0.0-vendor.1` keeps its name.
 */
export function normalizeTag(tag: string): string {
  const trimmed = tag.trim();
  return /^v\d/.test(trimmed) ? trimmed.slice(1) : trimmed;
}

/**
 * Interpret `npm view <pkg> versions --json`.
 *
 * Fails closed: anything this cannot positively identify as "the registry
 * answered" becomes `ok: false`, because the alternative reading — an empty
 * version list — is indistinguishable from a brand-new package and would wave
 * a republish straight through.
 */
export function parseRegistryVersions(code: number, stdout: string, stderr: string): RegistryQuery {
  // A package that has never been published 404s. That genuinely means "no
  // versions", and it is the only non-zero exit we accept.
  if (code !== 0) {
    if (/E404|404 Not Found/.test(stderr + stdout)) return { ok: true, versions: [] };
    return { ok: false, reason: (stderr || stdout).trim().split("\n")[0] || `npm exited ${code}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: `registry response was not JSON: ${stdout.trim().slice(0, 80)}` };
  }

  // With exactly one published version npm emits a bare string, not an array.
  if (typeof parsed === "string") return { ok: true, versions: [parsed] };
  if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
    return { ok: true, versions: parsed as string[] };
  }
  return { ok: false, reason: "registry response was neither a version nor a version list" };
}

export function decidePublish({ tag, pkgVersion, registry }: PreflightInput): Decision {
  // Tag agreement first. A mismatch is a mistake in how the release was cut,
  // and it stays worth reporting even when the version is already published —
  // surfacing "already published" there would hide it behind a green skip.
  const tagVersion = normalizeTag(tag);
  if (tagVersion !== pkgVersion) {
    return {
      action: "fail",
      reason: `release tag ${tag} declares ${tagVersion}, but package.json says ${pkgVersion}. Bump package.json and re-cut the release, or retag.`,
    };
  }

  if (!registry.ok) {
    return {
      action: "fail",
      reason: `could not read the published versions, so a republish cannot be ruled out: ${registry.reason}`,
    };
  }

  if (registry.versions.includes(pkgVersion)) {
    return {
      action: "skip",
      reason: `${pkgVersion} is already on the registry, so there is nothing to publish. (Every version up to 0.2.0 was published by hand; see #317.)`,
    };
  }

  return { action: "publish", reason: `${pkgVersion} is not on the registry yet` };
}

function main(): void {
  const root = join(import.meta.dir, "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };

  const tag = process.env.RELEASE_TAG?.trim();
  if (!tag) {
    console.error("preflight: RELEASE_TAG is empty — this script expects a release event.");
    process.exit(1);
  }

  const proc = Bun.spawnSync(["npm", "view", pkg.name, "versions", "--json"]);
  const registry = parseRegistryVersions(
    proc.exitCode,
    proc.stdout.toString(),
    proc.stderr.toString(),
  );

  const decision = decidePublish({ tag, pkgVersion: pkg.version, registry });
  console.log(`preflight: ${decision.action} — ${decision.reason}`);

  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `should_publish=${decision.action === "publish"}\n`);

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    appendFileSync(summary, `### publish preflight\n\n**${decision.action}** — ${decision.reason}\n`);
  }

  process.exit(decision.action === "fail" ? 1 : 0);
}

if (import.meta.main) main();
