import { inference, type InferenceOptions, type InferenceResult } from "../adapters/inference";

export interface ContradictionResult {
  hasConflict: boolean;
  conflictingRule?: string;
  details?: string;
}

export type InferenceFn = (opts: InferenceOptions) => Promise<InferenceResult>;

const SYSTEM_PROMPT = `You are a rule-conflict detector. Given a candidate rule and a list of existing rules, determine if the candidate contradicts or duplicates any existing rule. Answer with exactly one of:
CONFLICT: <the conflicting rule text>
NO_CONFLICT`;

export async function checkContradiction(
  candidateText: string,
  existingRules: string[],
  inferenceFn: InferenceFn = inference,
): Promise<ContradictionResult> {
  if (existingRules.length === 0) {
    return { hasConflict: false };
  }

  const numberedRules = existingRules
    .map((r, i) => `${i + 1}. ${r}`)
    .join("\n");

  const userPrompt = `Candidate rule:\n${candidateText}\n\nExisting rules:\n${numberedRules}`;

  let result;
  try {
    result = await inferenceFn({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      level: "fast",
    });
  } catch {
    return { hasConflict: false };
  }

  if (!result.success) {
    return { hasConflict: false };
  }

  const output = result.output.trim();
  if (output.startsWith("CONFLICT:")) {
    const conflictingRule = output.slice("CONFLICT:".length).trim();
    return {
      hasConflict: true,
      conflictingRule,
      details: `Candidate "${candidateText}" conflicts with: "${conflictingRule}"`,
    };
  }

  return { hasConflict: false };
}

export function extractExistingRules(claudeMdContent: string): string[] {
  const rules: string[] = [];
  for (const line of claudeMdContent.split("\n")) {
    const match = line.match(/^- \*\*[^:]+:\*\*\s*(.+)$/);
    if (match) {
      rules.push(match[1]);
    }
  }
  return rules;
}
