import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { getBaseDir, loadConfig, resolveSignalDir, resolveSignalFile } from "../../src/adapters/paths";
import { loadRubric } from "../../src/evaluate/rubric";
import { tunePrompt } from "../../src/optimize/prompt-tuner";
import type { TraceFetcher, PromptProposer, ContentGenerator, TraceWithScore } from "../../src/optimize/prompt-tuner";
import { tuneSkill } from "../../src/optimize/skill-tuner";
import type { SkillEvaluator, SkillProposer, SkillEvalResult } from "../../src/optimize/skill-tuner";
import { fastEvaluate, getCriteriaForSkill } from "../../src/optimize/skill-tuner";
import { inference } from "../../src/adapters/inference";
import type { JudgeConfig } from "../../src/evaluate/judge";
import type { RubricConfig, Score } from "../../src/adapters/types";

function loadScoresFromSignals(signalDir: string): Score[] {
  const scoresFile = resolveSignalFile(signalDir, "quality-scores.jsonl");
  if (!existsSync(scoresFile)) return [];
  const lines = readFileSync(scoresFile, "utf-8").split("\n").filter((l) => l.trim());
  const scores: Score[] = [];
  for (const line of lines) {
    try { scores.push(JSON.parse(line) as Score); } catch {}
  }
  return scores;
}

function loadTracesFromSignals(signalDir: string): Array<{ id: string; input: string; output: string; systemPrompt: string }> {
  const reflFile = resolveSignalFile(signalDir, "algorithm-reflections.jsonl");
  if (!existsSync(reflFile)) return [];
  const lines = readFileSync(reflFile, "utf-8").split("\n").filter((l) => l.trim());
  const traces: Array<{ id: string; input: string; output: string; systemPrompt: string }> = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      traces.push({
        id: entry.session_id ?? `trace-${traces.length}`,
        input: entry.task_description ?? "",
        output: entry.reflection_q1 ?? "",
        systemPrompt: entry.system_prompt ?? "You are a helpful assistant.",
      });
    } catch {}
  }
  return traces;
}

function createTraceFetcher(signalDir: string): TraceFetcher {
  return {
    async fetchLowestScoring(dimension: string, count: number): Promise<TraceWithScore[]> {
      const scores = loadScoresFromSignals(signalDir);
      const traces = loadTracesFromSignals(signalDir);
      if (traces.length === 0) return [];

      const scoresByTrace = new Map<string, number>();
      for (const s of scores) {
        if (s.dimension === dimension) {
          scoresByTrace.set(s.traceId, s.value);
        }
      }

      const withScores: TraceWithScore[] = traces.map((t) => ({
        trace: { input: t.input, output: t.output, id: t.id },
        score: scoresByTrace.get(t.id) ?? 2.5,
        systemPrompt: t.systemPrompt,
        userPrompt: t.input,
      }));

      withScores.sort((a, b) => a.score - b.score);
      return withScores.slice(0, count);
    },
  };
}

function createPromptProposer(): PromptProposer {
  return {
    async propose(currentPrompt: string, targetDimension, badOutputs: string[]): Promise<string> {
      const result = await inference({
        systemPrompt: "You are a prompt engineer. Given a system prompt and examples of poor outputs, propose an improved version of the system prompt that addresses the weak dimension. Return ONLY the improved prompt text, nothing else.",
        userPrompt: `Current prompt:\n${currentPrompt}\n\nWeak dimension: ${targetDimension.name} — ${targetDimension.rubric}\n\nExamples of poor outputs:\n${badOutputs.slice(0, 3).join("\n---\n")}\n\nReturn the improved prompt:`,
        level: "standard",
      });
      return result.success ? result.output.trim() : currentPrompt;
    },
  };
}

function createContentGenerator(): ContentGenerator {
  return {
    async generate(systemPrompt: string, userPrompt: string): Promise<string | null> {
      const result = await inference({ systemPrompt, userPrompt, level: "fast" });
      return result.success ? result.output : null;
    },
  };
}

function createSkillEvaluator(skillName?: string): SkillEvaluator {
  const criteria = getCriteriaForSkill(skillName);
  return {
    async evaluate(skillText: string): Promise<SkillEvalResult> {
      const tasks = [
        { id: "debug-1", task: "A container is returning 502 errors after a deploy. Diagnose and fix.", rating: 8 },
        { id: "debug-2", task: "Tests pass locally but fail in CI with a timeout error.", rating: 7 },
        { id: "debug-3", task: "The API endpoint returns stale data even after a database update.", rating: 6 },
      ];
      return fastEvaluate(skillText, {
        criteria,
        simulate: async (skill: string, taskPrompt: string) => {
          const result = await inference({
            systemPrompt: skill,
            userPrompt: taskPrompt,
            level: "fast",
          });
          return result.success ? result.output : "";
        },
        tasks,
      });
    },
  };
}

function createSkillProposer(): SkillProposer {
  return {
    async propose(skillText: string, lowestCriteria: string[]): Promise<string> {
      const result = await inference({
        systemPrompt: "You are a skill instruction optimizer. Given a skill definition and the criteria it scores lowest on, propose an improved version. Return ONLY the improved skill text, nothing else.",
        userPrompt: `Current skill:\n${skillText}\n\nLowest-scoring criteria:\n${lowestCriteria.map((c) => `- ${c}`).join("\n")}\n\nReturn the improved skill text:`,
        level: "standard",
      });
      return result.success ? result.output.trim() : skillText;
    },
  };
}

function findRubric(base: string): RubricConfig | null {
  const config = loadConfig();
  if (config.rubrics && config.rubrics.length > 0) {
    for (const rubricRef of config.rubrics) {
      const rubricFile = rubricRef.endsWith(".json") ? rubricRef : `${rubricRef}.json`;
      const fullPath = join(base, "rubrics", rubricFile);
      if (existsSync(fullPath)) {
        try { return loadRubric(fullPath); } catch {}
      }
    }
  }
  const rubricsPath = join(base, "rubrics");
  if (existsSync(rubricsPath)) {
    const files = readdirSync(rubricsPath).filter((f) => f.endsWith(".json"));
    if (files.length > 0) {
      try { return loadRubric(join(rubricsPath, files[0])); } catch {}
    }
  }
  return null;
}

function getJudgeConfig(base: string): JudgeConfig | null {
  const config = loadConfig();
  if (config.judge?.provider && config.judge?.model) {
    return {
      provider: config.judge.provider,
      model: config.judge.model,
      apiKey: config.judge.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.ANTHROPIC_API_KEY,
    };
  }
  if (process.env.OPENAI_API_KEY) return { provider: "openai", model: "gpt-4o", apiKey: process.env.OPENAI_API_KEY };
  if (process.env.GEMINI_API_KEY) return { provider: "gemini", model: "gemini-2.0-flash", apiKey: process.env.GEMINI_API_KEY };
  return null;
}

export async function optimizeCommand(args: string[]): Promise<void> {
  const base = getBaseDir();
  const sub = args[0];

  console.log("\nagentgrit optimize\n");

  if (!sub || sub === "--help") {
    console.log("  Usage:");
    console.log("    agentgrit optimize prompts [--dimension <name>] [--rounds <n>]");
    console.log("    agentgrit optimize skills [--skill <name>] [--rounds <n>]");
    console.log("    agentgrit optimize prompts --auto");
    console.log("");
    console.log("  Runs hill-climbing optimization on the specified target.");
    console.log("  Requires judge API key (standard or full mode).\n");
    return;
  }

  if (!existsSync(base)) {
    console.log("  agentgrit not initialized. Run 'agentgrit init' first.\n");
    return;
  }

  const roundsIdx = args.indexOf("--rounds");
  const rounds = roundsIdx !== -1 && args[roundsIdx + 1] ? parseInt(args[roundsIdx + 1], 10) : 3;

  if (sub === "prompts") {
    const dimIdx = args.indexOf("--dimension");
    const dimension = dimIdx !== -1 ? args[dimIdx + 1] : undefined;

    const rubric = findRubric(base);
    if (!rubric) {
      console.error("  No rubric found. Create one in ~/.agentgrit/rubrics/ or configure in config.json.");
      return;
    }

    const targetDim = dimension ?? rubric.dimensions[0]?.name;
    if (!targetDim) {
      console.error("  No dimension specified and rubric has no dimensions.");
      return;
    }

    const judgeConfig = getJudgeConfig(base);
    if (!judgeConfig) {
      console.error("  No judge configured. Set judge in config.json or set OPENAI_API_KEY / GEMINI_API_KEY.");
      return;
    }

    const signalDir = resolveSignalDir();
    const stateDir = join(base, "state", "optimize");

    console.log(`  Target: prompts`);
    console.log(`  Dimension: ${targetDim}`);
    console.log(`  Rounds: ${rounds}`);
    console.log(`  Judge: ${judgeConfig.provider}/${judgeConfig.model}`);
    console.log(`  State: ${stateDir}\n`);

    try {
      const result = await tunePrompt({
        dimension: targetDim,
        rubric,
        judgeConfig,
        fetcher: createTraceFetcher(signalDir),
        proposer: createPromptProposer(),
        generator: createContentGenerator(),
        testSize: 5,
        rounds,
        stateDir,
      });

      console.log(`  Baseline weighted: ${result.baselineWeighted.toFixed(4)}`);
      console.log(`  Final weighted:    ${result.finalWeighted.toFixed(4)}`);
      console.log(`  Delta:             ${result.totalDelta >= 0 ? "+" : ""}${result.totalDelta.toFixed(4)}`);
      console.log(`  Rounds kept:       ${result.roundsKept}`);
      console.log(`\n  Best prompt written to ${stateDir}/experiments.jsonl\n`);
    } catch (err) {
      console.error(`  Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  } else if (sub === "skills") {
    const skillIdx = args.indexOf("--skill");
    const skillName = skillIdx !== -1 ? args[skillIdx + 1] : undefined;

    let skillText: string;
    if (skillName) {
      const skillPath = join(base, "skills", `${skillName}.md`);
      if (!existsSync(skillPath)) {
        console.error(`  Skill file not found: ${skillPath}`);
        return;
      }
      skillText = readFileSync(skillPath, "utf-8");
    } else {
      const skillsDir = join(base, "skills");
      if (!existsSync(skillsDir)) {
        console.error("  No skills directory found. Specify --skill <name>.");
        return;
      }
      const skillFiles = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
      if (skillFiles.length === 0) {
        console.error("  No skill files found in skills directory.");
        return;
      }
      skillText = readFileSync(join(skillsDir, skillFiles[0]), "utf-8");
      console.log(`  Auto-selected skill: ${skillFiles[0]}`);
    }

    const stateDir = join(base, "state", "optimize");

    console.log(`  Target: skills`);
    console.log(`  Rounds: ${rounds}`);
    if (skillName) console.log(`  Skill: ${skillName}`);
    console.log(`  State: ${stateDir}\n`);

    try {
      const result = await tuneSkill({
        skillText,
        evaluator: createSkillEvaluator(skillName),
        proposer: createSkillProposer(),
        rounds,
        stateDir,
      });

      console.log(`  Initial score: ${result.initialScore.toFixed(4)}`);
      console.log(`  Final score:   ${result.finalScore.toFixed(4)}`);
      console.log(`  Delta:         ${result.totalDelta >= 0 ? "+" : ""}${result.totalDelta.toFixed(4)}`);
      console.log(`  Rounds kept:   ${result.roundsKept}`);

      if (result.lowestCriteria.length > 0) {
        console.log(`  Lowest criteria: ${result.lowestCriteria.join(", ")}`);
      }
      console.log(`\n  Results written to ${stateDir}/experiments.jsonl\n`);
    } catch (err) {
      console.error(`  Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  } else {
    console.log(`  Unknown optimize target: ${sub}`);
    console.log(`  Valid targets: prompts, skills\n`);
  }
}
