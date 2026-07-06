import { existsSync, readFileSync, readdirSync, createReadStream } from "fs";
import { join, basename } from "path";
import { createInterface } from "readline";
import { getBaseDir, loadConfig, resolveSignalDir, resolveSignalFile, resolveTranscriptDir } from "../../src/adapters/paths";
import { loadRubric } from "../../src/evaluate/rubric";
import { tunePrompt } from "../../src/optimize/prompt-tuner";
import type { TraceFetcher, PromptProposer, ContentGenerator, TraceWithScore } from "../../src/optimize/prompt-tuner";
import { tuneSkill } from "../../src/optimize/skill-tuner";
import type { SkillEvaluator, SkillProposer, SkillEvalResult } from "../../src/optimize/skill-tuner";
import { fastEvaluate, getCriteriaForSkill } from "../../src/optimize/skill-tuner";
import { inference } from "../../src/adapters/inference";
import { loadBenchmark } from "../../src/optimize/benchmark";
import type { JudgeConfig } from "../../src/evaluate/judge";
import type { RubricConfig } from "../../src/adapters/types";

interface QualityScore {
  session_file: string;
  scores: Record<string, number>;
}

function loadQualityScores(signalDir: string): QualityScore[] {
  const scoresFile = resolveSignalFile(signalDir, "quality-scores.jsonl");
  if (!existsSync(scoresFile)) return [];
  const lines = readFileSync(scoresFile, "utf-8").split("\n").filter((l) => l.trim());
  const results: QualityScore[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.session_file && entry.scores) {
        results.push({ session_file: entry.session_file, scores: entry.scores });
      }
    } catch {}
  }
  return results;
}

type TraceEntry = { id: string; input: string; output: string; systemPrompt: string };

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
        return String(block.text);
      }
    }
  }
  return "";
}

async function loadTraceFromTranscript(filePath: string): Promise<TraceEntry | null> {
  let userMsg = "";
  let assistantMsg = "";
  let systemMsg = "";
  let found = 0;

  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (found >= 3) break;
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!userMsg && entry.type === "user" && entry.message?.content) {
        const text = extractTextContent(entry.message.content);
        if (text) { userMsg = truncate(text, 2000); found++; }
      } else if (!assistantMsg && entry.type === "assistant" && entry.message?.content) {
        const text = extractTextContent(entry.message.content);
        if (text) { assistantMsg = truncate(text, 2000); found++; }
      } else if (!systemMsg && entry.type === "system" && entry.message?.content) {
        const text = extractTextContent(entry.message.content);
        if (text) { systemMsg = truncate(text, 2000); found++; }
      }
    } catch {}
  }
  rl.close();

  if (!userMsg && !assistantMsg) return null;
  const id = basename(filePath, ".jsonl");
  return {
    id,
    input: userMsg || "(no user message)",
    output: assistantMsg || "(no assistant message)",
    systemPrompt: systemMsg || "You are a helpful assistant.",
  };
}

async function loadTracesFromTranscripts(transcriptDir: string, sessionFiles?: Set<string>): Promise<TraceEntry[]> {
  if (!existsSync(transcriptDir)) return [];
  const files = readdirSync(transcriptDir).filter((f) => f.endsWith(".jsonl"));
  const subset = sessionFiles
    ? files.filter((f) => sessionFiles.has(f))
    : files.slice(-50);

  const traces: TraceEntry[] = [];
  for (const file of subset) {
    const trace = await loadTraceFromTranscript(join(transcriptDir, file));
    if (trace) traces.push(trace);
  }
  return traces;
}

function loadTracesFromReflections(signalDir: string): TraceEntry[] {
  const reflFile = resolveSignalFile(signalDir, "algorithm-reflections.jsonl");
  if (!existsSync(reflFile)) return [];
  const lines = readFileSync(reflFile, "utf-8").split("\n").filter((l) => l.trim());
  const traces: TraceEntry[] = [];
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
      const qualityScores = loadQualityScores(signalDir);

      const reflTraces = loadTracesFromReflections(signalDir);
      let traces: TraceEntry[];

      if (reflTraces.length > 0) {
        traces = reflTraces;
      } else {
        const transcriptDir = resolveTranscriptDir();
        if (!transcriptDir) {
          console.log("  No transcript directory found. Set transcriptDir in config.json.");
          return [];
        }
        const scoredFiles = new Set(qualityScores.map((s) => s.session_file));
        traces = await loadTracesFromTranscripts(transcriptDir, scoredFiles.size > 0 ? scoredFiles : undefined);
      }

      if (traces.length === 0) return [];

      console.log(`  Traces loaded: ${traces.length}`);

      const scoreMap = new Map<string, number>();
      for (const qs of qualityScores) {
        const sessionId = qs.session_file.replace(/\.jsonl$/, "");
        const dimScore = qs.scores[dimension] ?? qs.scores["overall"];
        if (dimScore !== undefined) scoreMap.set(sessionId, dimScore);
      }

      const withScores: TraceWithScore[] = traces.map((t) => ({
        trace: { input: t.input, output: t.output, id: t.id },
        score: scoreMap.get(t.id) ?? 2.5,
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

function loadBenchmarkTasks(benchmarkPath?: string): Array<{ id: string; task: string; rating: number }> {
  const defaultPath = join(getBaseDir(), "state", "skill-benchmark.json");
  const pathToTry = benchmarkPath ?? defaultPath;

  try {
    const benchmark = loadBenchmark(pathToTry);
    return benchmark.tasks.map((t) => ({ id: t.id, task: t.task, rating: t.rating }));
  } catch {
    return [
      { id: "debug-1", task: "A container is returning 502 errors after a deploy. Diagnose and fix.", rating: 8 },
      { id: "debug-2", task: "Tests pass locally but fail in CI with a timeout error.", rating: 7 },
      { id: "debug-3", task: "The API endpoint returns stale data even after a database update.", rating: 6 },
    ];
  }
}

function createSkillEvaluator(skillName?: string, benchmarkPath?: string): SkillEvaluator {
  const criteria = getCriteriaForSkill(skillName);
  const tasks = loadBenchmarkTasks(benchmarkPath);
  return {
    async evaluate(skillText: string): Promise<SkillEvalResult> {
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
    console.log("    agentgrit optimize skills [--skill <name>] [--rounds <n>] [--benchmark <path>]");
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
    const benchIdx = args.indexOf("--benchmark");
    const benchmarkPath = benchIdx !== -1 ? args[benchIdx + 1] : undefined;

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
    const benchmarkTasks = loadBenchmarkTasks(benchmarkPath);

    console.log(`  Target: skills`);
    console.log(`  Rounds: ${rounds}`);
    if (skillName) console.log(`  Skill: ${skillName}`);
    console.log(`  Tasks: ${benchmarkTasks.length} (${benchmarkPath ? "custom" : existsSync(join(base, "state", "skill-benchmark.json")) ? "benchmark" : "default"})`);
    console.log(`  State: ${stateDir}\n`);

    try {
      const result = await tuneSkill({
        skillText,
        evaluator: createSkillEvaluator(skillName, benchmarkPath),
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
