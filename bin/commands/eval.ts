import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { getBaseDir, loadConfig, resolveSignalDir, resolveSignalFile } from "../../src/adapters/paths";
import { loadRubric } from "../../src/evaluate/rubric";
import { judgeTrace, judgeBatch } from "../../src/evaluate/judge";
import type { JudgeConfig, Trace } from "../../src/evaluate/judge";
import { scoresToJsonl } from "../../src/evaluate/judge";
import { evaluateRecall, aggregateRecallScores, evaluateSessionRecall } from "../../src/evaluate/recall";
import type { RecallResult, SessionRecallScore } from "../../src/evaluate/recall";
import type { RubricConfig, Score, Rule } from "../../src/adapters/types";
import { writeFileSync, mkdirSync } from "fs";

function getJudgeConfig(): JudgeConfig | null {
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

function loadTracesFromSignals(signalDir: string): Trace[] {
  const reflFile = resolveSignalFile(signalDir, "algorithm-reflections.jsonl");
  if (!existsSync(reflFile)) return [];
  const lines = readFileSync(reflFile, "utf-8").split("\n").filter((l) => l.trim());
  const traces: Trace[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      traces.push({
        id: entry.session_id ?? `trace-${traces.length}`,
        input: entry.task_description ?? "",
        output: entry.reflection_q1 ?? "",
      });
    } catch {}
  }
  return traces;
}

function loadGoldSet(base: string): Record<string, { relevantRules: string[]; description: string }> | null {
  const goldPath = join(base, "state", "gold-set.json");
  if (!existsSync(goldPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(goldPath, "utf-8"));
    return raw.labeled ?? null;
  } catch { return null; }
}

function loadGraphRules(base: string): Rule[] {
  const graphPath = join(base, "state", "knowledge-graph.json");
  if (!existsSync(graphPath)) return [];
  try {
    const graph = JSON.parse(readFileSync(graphPath, "utf-8"));
    const nodes = graph.nodes ?? {};
    return Object.values(nodes).map((n: any) => ({
      id: n.id,
      text: n.description ?? "",
      tier: "graph" as any,
      tags: n.domains ?? [],
      created: n.last_updated ?? new Date().toISOString(),
      correlationScore: 0,
      sourceSignals: [],
      schemaVersion: 1,
    }));
  } catch { return []; }
}

function loadRecallScores(base: string): Record<string, string[]> | null {
  const scoresPath = join(base, "state", "recall-scores.json");
  if (!existsSync(scoresPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(scoresPath, "utf-8"));
    return raw.injected ?? null;
  } catch { return null; }
}

export async function evalCommand(args: string[]): Promise<void> {
  const base = getBaseDir();
  const sub = args[0];

  console.log("\nagentgrit eval\n");

  if (!sub || sub === "--help") {
    console.log("  Usage:");
    console.log("    agentgrit eval traces [--backfill] [--local]");
    console.log("    agentgrit eval session");
    console.log("    agentgrit eval recall");
    console.log("");
    console.log("  Evaluates traces, sessions, or recall against rubrics.");
    console.log("  Requires judge API key (standard or full mode).\n");
    return;
  }

  if (!existsSync(base)) {
    console.log("  agentgrit not initialized. Run 'agentgrit init' first.\n");
    return;
  }

  if (sub === "traces") {
    const backfill = args.includes("--backfill");
    const local = args.includes("--local");
    const signalDir = resolveSignalDir();

    const rubric = findRubric(base);
    if (!rubric) {
      console.error("  No rubric found. Create one in ~/.agentgrit/rubrics/ or configure in config.json.");
      return;
    }

    const judgeConfig = getJudgeConfig();
    if (!judgeConfig) {
      console.error("  No judge configured. Set judge in config.json or set OPENAI_API_KEY / GEMINI_API_KEY.");
      return;
    }

    const traces = loadTracesFromSignals(signalDir);
    if (traces.length === 0) {
      console.log("  No traces found in signals directory.");
      console.log(`  Looking in: ${signalDir}\n`);
      return;
    }

    const existingScores = new Set<string>();
    if (!backfill) {
      const scoresFile = resolveSignalFile(signalDir, "quality-scores.jsonl");
      if (existsSync(scoresFile)) {
        const lines = readFileSync(scoresFile, "utf-8").split("\n").filter((l) => l.trim());
        for (const line of lines) {
          try { const s = JSON.parse(line); existingScores.add(s.traceId); } catch {}
        }
      }
    }

    const toEval = backfill ? traces : traces.filter((t) => !existingScores.has(t.id ?? ""));
    console.log(`  Traces found: ${traces.length}`);
    console.log(`  To evaluate: ${toEval.length}${backfill ? " (backfill mode)" : ""}`);
    console.log(`  Judge: ${judgeConfig.provider}/${judgeConfig.model}\n`);

    if (toEval.length === 0) {
      console.log("  All traces already scored. Use --backfill to re-evaluate.\n");
      return;
    }

    const { results, evaluated, failed } = await judgeBatch(toEval, rubric, judgeConfig, {
      delayMs: 2000,
      onProgress: (done, total) => {
        process.stdout.write(`\r  Progress: ${done}/${total}`);
      },
    });

    console.log(`\n\n  Evaluated: ${evaluated}`);
    console.log(`  Failed: ${failed}`);

    const allScores = results.flatMap((r) => r.scores);
    if (allScores.length > 0) {
      const scoresFile = join(signalDir, "quality-scores.jsonl");
      const jsonl = scoresToJsonl(allScores);
      const existing = existsSync(scoresFile) ? readFileSync(scoresFile, "utf-8") : "";
      writeFileSync(scoresFile, existing + jsonl);
      console.log(`  Scores appended to: ${scoresFile}`);

      const byDim = new Map<string, number[]>();
      for (const s of allScores) {
        if (!byDim.has(s.dimension)) byDim.set(s.dimension, []);
        byDim.get(s.dimension)!.push(s.value);
      }
      console.log("\n  Dimension averages:");
      for (const [dim, vals] of byDim) {
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        console.log(`    ${dim}: ${avg.toFixed(2)} (n=${vals.length})`);
      }
    }
    console.log("");
  } else if (sub === "session") {
    console.log(`  Mode: session quality scoring`);
    console.log(`  Aggregates signals from current session.\n`);

    const signalDir = resolveSignalDir();
    const scoresFile = resolveSignalFile(signalDir, "quality-scores.jsonl");

    if (!existsSync(scoresFile)) {
      console.log("  No scores found. Run 'agentgrit eval traces' first.\n");
      return;
    }

    const lines = readFileSync(scoresFile, "utf-8").split("\n").filter((l) => l.trim());
    const scores: Score[] = [];
    for (const line of lines) {
      try { scores.push(JSON.parse(line) as Score); } catch {}
    }

    if (scores.length === 0) {
      console.log("  No valid scores found.\n");
      return;
    }

    const byDim = new Map<string, number[]>();
    for (const s of scores) {
      if (!byDim.has(s.dimension)) byDim.set(s.dimension, []);
      byDim.get(s.dimension)!.push(s.value);
    }

    console.log(`  Total scores: ${scores.length}\n`);
    console.log("  Dimension summary:");
    for (const [dim, vals] of byDim) {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      console.log(`    ${dim}: avg=${avg.toFixed(2)} min=${min} max=${max} n=${vals.length}`);
    }
    console.log("");
  } else if (sub === "recall") {
    console.log(`  Mode: recall accuracy\n`);

    const goldSet = loadGoldSet(base);
    if (!goldSet) {
      console.log("  No gold set found at state/gold-set.json.");
      console.log("  Run 'agentgrit graph build' and label sessions first.\n");
      return;
    }

    const recallData = loadRecallScores(base);
    const allRules = loadGraphRules(base);

    const sessions: SessionRecallScore[] = [];
    for (const [sessionId, entry] of Object.entries(goldSet)) {
      const injectedIds = recallData?.[sessionId] ?? [];
      const score = evaluateSessionRecall(sessionId, entry.description, entry.relevantRules, injectedIds);
      sessions.push(score);
    }

    if (sessions.length === 0) {
      console.log("  No sessions to evaluate in gold set.\n");
      return;
    }

    const result = aggregateRecallScores(sessions);

    console.log(`  Sessions evaluated: ${result.sessionsEvaluated}`);
    console.log(`  Mean Recall@3:  ${result.meanRecall3.toFixed(3)}`);
    console.log(`  Mean Recall@5:  ${result.meanRecall5.toFixed(3)}`);
    console.log(`  Mean Recall@10: ${result.meanRecall10.toFixed(3)}`);
    console.log(`  Mean Recall@15: ${result.meanRecall15.toFixed(3)}`);
    console.log(`  Mean Precision@5: ${result.meanPrecision5.toFixed(3)}`);
    console.log(`  Mean MRR:       ${result.meanMrr.toFixed(3)}`);
    console.log(`  95% CI (R@5):   [${result.ci95Recall5[0].toFixed(3)}, ${result.ci95Recall5[1].toFixed(3)}]`);

    const outputPath = join(base, "state", "recall-eval.json");
    const dir = join(base, "state");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(`\n  Results written to: ${outputPath}\n`);
  } else {
    console.log(`  Unknown eval target: ${sub}`);
    console.log(`  Valid targets: traces, session, recall\n`);
  }
}
