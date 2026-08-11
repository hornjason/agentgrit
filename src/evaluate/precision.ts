import { readGraph } from "../graph/builder";
import { buildIndexFromDir } from "../graph/bm25";
import { getContextRules, initHybridDetection, detectDomains, retrieveByEmbeddingSeed, type RetrievalStrategy } from "../graph/context";
import { loadVectorCache } from "../graph/embeddings";
import { resolveMemoryDir, resolveSignalDir } from "../adapters/paths";
import { join } from "path";

export interface EvalTask {
  id: number;
  description: string;
  expectedDomains: string[];
  expectedRuleIds: string[];
}

export interface TaskResult {
  id: number;
  description: string;
  expectedDomains: string[];
  retrievedIds: string[];
  expectedRuleIds: string[];
  precision5: number;
  precision10: number;
  hits5: string[];
  hits10: string[];
}

export interface PrecisionEvalResult {
  tasks: TaskResult[];
  meanPrecision5: number;
  meanPrecision10: number;
  timestamp: string;
}

export function computePrecisionAtK(retrieved: string[], expected: string[], k: number): number {
  if (retrieved.length === 0) return 0;
  const topK = retrieved.slice(0, k);
  const expectedSet = new Set(expected);
  const hits = topK.filter(id => expectedSet.has(id));
  return hits.length / Math.min(k, retrieved.length);
}

export const EVAL_TASKS: EvalTask[] = [
  {
    id: 1,
    description: "Optimize the BM25 retrieval scoring algorithm for better recall",
    expectedDomains: ["algorithm"],
    expectedRuleIds: [
      "feedback_design_complete_before_building",
      "feedback_no_false_completions",
      "feedback_spec_fidelity_gap",
    ],
  },
  {
    id: 2,
    description: "Add CSRF protection to the login endpoint",
    expectedDomains: ["security"],
    expectedRuleIds: [
      "steering_check_git_remote_before_push",
      "feedback_no_notion",
      "feedback_no_gemini_api",
    ],
  },
  {
    id: 3,
    description: "Fix Docker container failing to start on Mac Mini",
    expectedDomains: ["deployment"],
    expectedRuleIds: [
      "reference_ghcr_credentials",
      "feedback_portability_check",
      "reference_dailybrief_project_path",
    ],
  },
  {
    id: 4,
    description: "Playwright test for new user onboarding flow keeps timing out",
    expectedDomains: ["ui-testing"],
    expectedRuleIds: [
      "feedback_condition-driven-waits-browser-automation",
      "feedback_read_templates_before_acs",
      "feedback_template_compliance_live",
    ],
  },
  {
    id: 5,
    description: "Refactor the rule promotion pipeline to use deep modules",
    expectedDomains: ["architecture"],
    expectedRuleIds: [
      "feedback_design_for_least_complexity",
      "feedback_architecture_in_mandatory_read_path",
      "project_signal_index_architecture",
    ],
  },
  {
    id: 6,
    description: "Signal capture drops ratings when JSONL file exceeds 100MB",
    expectedDomains: ["data"],
    expectedRuleIds: [
      "feedback_signal_to_output_trace",
      "feedback_measure_before_optimizing",
      "success_verify-data-state-diagnose-root-cause",
    ],
  },
  {
    id: 7,
    description: "Ship the precision eval instrumentation for context retrieval",
    expectedDomains: ["delivery"],
    expectedRuleIds: [
      "feedback_ac_garbage_test",
      "feedback_docs_always_current",
      "success_4_layer_consumer_verification",
    ],
  },
  {
    id: 8,
    description: "Investigation: why did the production deploy fail silently last week",
    expectedDomains: ["escalation"],
    expectedRuleIds: [
      "success_adversarial_e2e_testing",
      "feedback_slow_down_regroup",
      "success_council_then_research_then_ship",
    ],
  },
  {
    id: 9,
    description: "Add memory staleness detection to the daemon weekly cycle",
    expectedDomains: ["memory"],
    expectedRuleIds: [
      "feedback_flag_rule_conflicts",
      "project_memory_loop",
      "feedback_consolidate-corrections-before-stating",
    ],
  },
  {
    id: 10,
    description: "Fix broken domain propagation in knowledge graph builder",
    expectedDomains: ["algorithm", "deployment"],
    expectedRuleIds: [
      "success_audit_then_architecture_then_ship",
      "project_unified_ship_workflow",
      "feedback_design_complete_before_building",
    ],
  },
];

export async function evaluatePrecision(
  strategy: RetrievalStrategy = "current",
): Promise<PrecisionEvalResult> {
  const graph = readGraph();
  initHybridDetection(graph);
  const memoryDir = resolveMemoryDir();
  const signalDir = resolveSignalDir();
  const index = buildIndexFromDir(memoryDir);

  let vectorCache: Map<string, number[]> | null = null;
  if (strategy === "embeddings") {
    const { getBaseDir } = await import("../adapters/paths");
    const vectorCachePath = join(getBaseDir(), "state", "vector-cache.json");
    vectorCache = loadVectorCache(vectorCachePath);
  }

  const tasks: TaskResult[] = [];

  for (const task of EVAL_TASKS) {
    const domains = task.expectedDomains.length > 0
      ? task.expectedDomains
      : detectDomains(task.description);

    let retrievedIds: string[];

    if (strategy === "embeddings" && vectorCache && vectorCache.size > 0) {
      const rules = retrieveByEmbeddingSeed(
        task.description, graph, index, vectorCache, 15,
      );
      retrievedIds = rules.map(r => r.id);
    } else {
      const rules = await getContextRules(
        graph, index, domains, 15, signalDir, task.description,
      );
      retrievedIds = rules.map(r => r.id);
    }

    const expectedSet = new Set(task.expectedRuleIds);
    const top5 = retrievedIds.slice(0, 5);
    const top10 = retrievedIds.slice(0, 10);
    const hits5 = top5.filter(id => expectedSet.has(id));
    const hits10 = top10.filter(id => expectedSet.has(id));

    tasks.push({
      id: task.id,
      description: task.description,
      expectedDomains: task.expectedDomains,
      retrievedIds,
      expectedRuleIds: task.expectedRuleIds,
      precision5: computePrecisionAtK(retrievedIds, task.expectedRuleIds, 5),
      precision10: computePrecisionAtK(retrievedIds, task.expectedRuleIds, 10),
      hits5,
      hits10,
    });
  }

  const meanP5 = tasks.length > 0
    ? tasks.reduce((s, t) => s + t.precision5, 0) / tasks.length
    : 0;
  const meanP10 = tasks.length > 0
    ? tasks.reduce((s, t) => s + t.precision10, 0) / tasks.length
    : 0;

  return {
    tasks,
    meanPrecision5: meanP5,
    meanPrecision10: meanP10,
    timestamp: new Date().toISOString(),
  };
}
