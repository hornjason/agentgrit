import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import type { Rule } from "../adapters/types";
import { keywordClassify } from "../graph/builder";

interface RuleDomainEntry {
  domains: string[];
  source: string;
}

interface RuleDomainsFile {
  version: number;
  reviewed: boolean;
  rules: Record<string, RuleDomainEntry>;
}

export function writeRuleFile(rule: Rule, rulesDir: string): string {
  if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });

  const filePath = join(rulesDir, `${rule.id}.md`);
  const content = [
    "---",
    `name: ${rule.id}`,
    `description: ${rule.text}`,
    "type: learned",
    "---",
    "",
    rule.text,
    "",
  ].join("\n");

  atomicWrite(filePath, content);
  return filePath;
}

export function updateRuleDomains(
  rule: Rule,
  ruleDomainsPath: string,
): string[] {
  const domains = keywordClassify(rule.id, rule.text, rule.text) ?? ["verification"];

  let file: RuleDomainsFile;
  if (existsSync(ruleDomainsPath)) {
    try {
      file = JSON.parse(readFileSync(ruleDomainsPath, "utf-8")) as RuleDomainsFile;
    } catch {
      file = { version: 1, reviewed: false, rules: {} };
    }
  } else {
    const dir = dirname(ruleDomainsPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    file = { version: 1, reviewed: false, rules: {} };
  }

  file.rules[rule.id] = { domains, source: "auto" };
  atomicWrite(ruleDomainsPath, JSON.stringify(file, null, 2));
  return domains;
}

export function appendToLearnedMd(rule: Rule, learnedPath: string): void {
  if (!existsSync(learnedPath)) return;

  const content = readFileSync(learnedPath, "utf-8");
  const ruleLine = `- **${rule.id}:** ${rule.text}`;

  if (content.includes(`- **${rule.id}:`)) return;

  const lastRuleIdx = content.lastIndexOf("\n- **");
  if (lastRuleIdx === -1) {
    const sectionIdx = content.indexOf("### Learned Rules");
    if (sectionIdx === -1) return;
    const afterSection = content.indexOf("\n", sectionIdx);
    if (afterSection === -1) return;
    const newContent = content.slice(0, afterSection + 1) + ruleLine + "\n" + content.slice(afterSection + 1);
    atomicWrite(learnedPath, newContent);
    return;
  }

  const endOfLastRule = content.indexOf("\n", lastRuleIdx + 1);
  if (endOfLastRule === -1) {
    atomicWrite(learnedPath, content + "\n" + ruleLine + "\n");
    return;
  }

  const newContent = content.slice(0, endOfLastRule + 1) + ruleLine + "\n" + content.slice(endOfLastRule + 1);
  atomicWrite(learnedPath, newContent);
}

function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmpPath = filePath + ".tmp." + process.pid;
  try {
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
    throw new Error(`Failed to atomically write ${filePath}: ${err}`);
  }
}
