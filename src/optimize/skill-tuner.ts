/**
 * skill-tuner.ts — Skill evaluation and tuning via hill-climb
 *
 * Consolidated from:
 *   - PAI Tools/SkillEvaluator.ts — behavioral scoring with LLM-as-judge
 *   - PAI Tools/SkillEvaluatorFast.ts — deterministic regex-based scoring
 *   - PAI Tools/SkillOptimizer.ts — skill-specific hill-climb logic
 *
 * Two evaluation modes:
 *   - evaluateSkill(): LLM-as-judge with per-criterion pass/fail
 *   - fastEvaluate(): Deterministic regex patterns, zero LLM variance
 *
 * Both feed into tuneSkill() which uses the hill-climb engine.
 */

import { hillClimb } from "./hill-climb";
import type { HillClimbResult } from "./hill-climb";

// ── Interfaces ──

export interface SkillEvaluator {
  evaluate(skillText: string): Promise<SkillEvalResult>;
}

export interface SkillEvalResult {
  compositeScore: number;
  behavioralScore: number;
  taskSuccessProxy: number;
  perCriteria: { name: string; passed: boolean }[];
}

export interface SkillProposer {
  propose(skillText: string, lowestCriteria: string[]): Promise<string>;
}

export interface SkillTuneConfig {
  skillText: string;
  evaluator: SkillEvaluator;
  proposer: SkillProposer;
  rounds: number;
  stateDir: string;
  maxChangeRatio?: number;
}

export interface SkillTuneResult {
  originalText: string;
  bestText: string;
  initialScore: number;
  finalScore: number;
  totalDelta: number;
  roundsKept: number;
  hillClimbResult: HillClimbResult;
  lowestCriteria: string[];
}

// ── Deterministic Criterion ──

export interface Criterion {
  label: string;
  patterns: RegExp[];
  minMatches: number;
  precedes?: {
    anchor: RegExp;
    target: RegExp;
  };
}

// ── Task Success Proxy (Pearson correlation) ──

function pearsonCorrelation(scores: number[], ratings: number[]): number {
  if (scores.length < 2) return 0;
  const n = scores.length;
  const meanScore = scores.reduce((a, b) => a + b, 0) / n;
  const meanRating = ratings.reduce((a, b) => a + b, 0) / n;
  let cov = 0, varScore = 0, varRating = 0;
  for (let i = 0; i < n; i++) {
    const ds = scores[i] - meanScore;
    const dr = ratings[i] - meanRating;
    cov += ds * dr;
    varScore += ds * ds;
    varRating += dr * dr;
  }
  if (varScore === 0 || varRating === 0) return 0;
  return (cov / Math.sqrt(varScore * varRating) + 1) / 2;
}

// ── Deterministic Scoring (regex-based) ──

export function scoreDeterministic(agentResponse: string, criteria: Criterion[]): boolean[] {
  return criteria.map((criterion) => {
    const matchCount = criterion.patterns.filter((p) => p.test(agentResponse)).length;
    const patternPass = matchCount >= criterion.minMatches;

    if (!criterion.precedes) return patternPass;

    // PRECEDES: anchor must appear before target in text
    const anchorMatch = criterion.precedes.anchor.exec(agentResponse);
    const targetMatch = criterion.precedes.target.exec(agentResponse);
    if (!anchorMatch || !targetMatch) return false;
    return patternPass && anchorMatch.index < targetMatch.index;
  });
}

// ── Fast Evaluate (deterministic, no LLM judge) ──

export interface FastEvalConfig {
  criteria: Criterion[];
  simulate: (skillText: string, taskPrompt: string) => Promise<string>;
  tasks: Array<{ id: string; task: string; rating: number }>;
  samples?: number;
}

export interface FastEvalResult {
  compositeScore: number;
  behavioralScore: number;
  taskSuccessProxy: number;
  perCriteria: { name: string; passed: boolean }[];
  taskResults: Array<{
    taskId: string;
    behavioralScore: number;
    criteriaAnswers: boolean[];
  }>;
}

export async function fastEvaluate(
  skillText: string,
  config: FastEvalConfig,
): Promise<FastEvalResult> {
  const { criteria, simulate, tasks, samples = 1 } = config;
  const taskResults: FastEvalResult["taskResults"] = [];

  for (const task of tasks) {
    const sampleAnswers: boolean[][] = [];

    for (let s = 0; s < samples; s++) {
      const response = await simulate(skillText, task.task);
      sampleAnswers.push(scoreDeterministic(response, criteria));
    }

    // Majority vote per criterion across samples
    const avgAnswers = criteria.map((_, ci) => {
      const trueCount = sampleAnswers.filter((a) => a[ci]).length;
      return trueCount > samples / 2;
    });

    const behavioralScore = avgAnswers.filter(Boolean).length / criteria.length;
    taskResults.push({ taskId: task.id, behavioralScore, criteriaAnswers: avgAnswers });
  }

  const behavioralScore = taskResults.reduce((sum, r) => sum + r.behavioralScore, 0) / taskResults.length;
  const taskSuccessProxy = pearsonCorrelation(
    taskResults.map((r) => r.behavioralScore),
    tasks.map((t) => t.rating),
  );

  // Aggregate per-criteria pass rates
  const perCriteria = criteria.map((c, ci) => {
    const passCount = taskResults.filter((r) => r.criteriaAnswers[ci]).length;
    return { name: c.label, passed: passCount > taskResults.length / 2 };
  });

  return {
    compositeScore: behavioralScore,
    behavioralScore,
    taskSuccessProxy,
    perCriteria,
    taskResults,
  };
}

// ── LLM-based Evaluate ──

export interface LLMEvalConfig {
  criteria: string[];
  simulate: (skillText: string, taskPrompt: string) => Promise<string>;
  judge: (agentResponse: string, criteria: string[]) => Promise<boolean[]>;
  tasks: Array<{ id: string; task: string; rating: number }>;
}

export async function evaluateSkill(
  skillText: string,
  config: LLMEvalConfig,
): Promise<SkillEvalResult> {
  const { criteria, simulate, judge, tasks } = config;
  const allScores: number[] = [];
  const allRatings: number[] = [];
  const criteriaPassCounts = new Array(criteria.length).fill(0);

  for (const task of tasks) {
    const response = await simulate(skillText, task.task);
    const answers = await judge(response, criteria);
    const score = answers.filter(Boolean).length / criteria.length;
    allScores.push(score);
    allRatings.push(task.rating);
    answers.forEach((passed, i) => { if (passed) criteriaPassCounts[i]++; });
  }

  const behavioralScore = allScores.reduce((a, b) => a + b, 0) / allScores.length;
  const taskSuccessProxy = pearsonCorrelation(allScores, allRatings);
  const compositeScore = behavioralScore * 0.75 + taskSuccessProxy * 0.25;

  const perCriteria = criteria.map((name, i) => ({
    name,
    passed: criteriaPassCounts[i] > tasks.length / 2,
  }));

  return { compositeScore, behavioralScore, taskSuccessProxy, perCriteria };
}

// ── Criteria Registries ──

export const FAST_CRITERIA_DEBUGGING: Criterion[] = [
  {
    label: "Environment verification",
    patterns: [
      /\b(port|container|environment|env)\b.*\b(verify|confirm|check|which)\b/i,
      /\b(verify|confirm|check)\b.*\b(port|container|environment|env)\b/i,
      /\bwhich (port|environment|container)\b/i,
      /\benvironment verification\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Batch diagnostic reads",
    patterns: [
      /\b(batch|single pass|one pass)\b/i,
      /\b(logs|state|cache|source).{0,40}(together|simultaneously|one pass|batch|at once)\b/i,
      /\bread all.{0,30}(logs|files|sources|at once)\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Single hypothesis",
    patterns: [
      /\b(one|single|1)\s+hypothesis\b/i,
      /\bhypothes[ie][sz]\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Single change",
    patterns: [
      /\b(one|single|1)\s+(change|fix|modification|edit|patch)\b/i,
      /\bone change at a time\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Backlog logging",
    patterns: [
      /\bBKL-\w+/,
      /\bBACKLOG\.md\b/i,
      /\b(log|record|add|file).{0,20}(backlog|BACKLOG)\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Regression test",
    patterns: [
      /\bregression test\b/i,
      /\bwrite.{0,20}test\b/i,
      /\badd.{0,20}test\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Full test suite",
    patterns: [
      /\bfull test suite\b/i,
      /\ball tests\b/i,
      /\brun.{0,30}(all|full|complete).{0,30}test/i,
    ],
    minMatches: 1,
  },
  {
    label: "Actionable and specific",
    patterns: [
      /\bread\b/i, /\bcheck\b/i, /\brun\b/i, /\bwrite\b/i,
      /\blog\b/i, /\bverify\b/i, /\bconfirm\b/i, /\bgrep\b/i,
      /\binspect\b/i, /\btest\b/i, /\bfix\b/i, /\bapply\b/i,
    ],
    minMatches: 4,
  },
];

export const FAST_CRITERIA_QA: Criterion[] = [
  {
    label: "Port/environment confirmed",
    patterns: [
      /\b(7776|7777)\b/,
      /\b(port|environment|env)\b.*\b(confirm|check|verify|which|ask)\b/i,
      /\b(confirm|check|verify|ask)\b.*\b(port|environment|env)\b/i,
      /\bwhich (port|environment|env)\b/i,
      /\benvironment.*confirm\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Playwright project matched to port",
    patterns: [
      /\b(ci|test)\s+project\b/i,
      /\bproject.{0,30}(7776|7777)\b/i,
      /\b(7776|7777).{0,30}project\b/i,
      /\bnever.{0,30}(mix|cross|wrong).{0,30}project\b/i,
      /\bci.{0,20}(targets|target|7777)\b/i,
      /\btest.{0,20}(project|7776)\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Endpoints verified before spec writing",
    patterns: [
      /\bcurl\b/i,
      /\bverif.{0,30}endpoint\b/i,
      /\bendpoint.{0,30}verif\b/i,
      /\bverif.{0,30}(path|route|url)\b/i,
      /\bbefore.{0,30}(writing|running|spec)\b/i,
      /\blive state\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Read existing helpers before reimplementing",
    patterns: [
      /\bgrep.{0,30}(helper|function|exist)\b/i,
      /\bread.{0,30}(helper|existing|exist).{0,30}(before|first)\b/i,
      /\bbefore.{0,30}(reimplementing|rewriting|writing new)\b/i,
      /\bexisting.{0,30}(helper|function|test).{0,30}(read|check|grep)\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Browser session hygiene",
    patterns: [
      /\btimestamped.{0,30}session\b/i,
      /\bsession.{0,30}(name|slug|timestamped)\b/i,
      /\bstale.{0,30}(session|profile)\b/i,
      /\b(avoid|prevent).{0,30}session.{0,30}collision\b/i,
      /\bfresh.{0,30}(session|context|browser)\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Red/Green test observation",
    patterns: [
      /\bred.{0,10}green\b/i,
      /\b(observe|confirm|see).{0,30}(fail|failing|red)\b/i,
      /\bfail.{0,30}before.{0,30}(fix|pass|green)\b/i,
      /\btest.{0,30}(must|should).{0,30}fail\b/i,
      /\bregression test.{0,30}(failing|fail)\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Full suite run",
    patterns: [
      /\bfull (test )?suite\b/i,
      /\ball tests\b/i,
      /\bmake test(-up|-rebuild)?\b/i,
      /\bentire.{0,20}suite\b/i,
      /\bcomplete.{0,20}suite\b/i,
      /\bnot just.{0,20}(new|single).{0,20}test\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Both gates before commit",
    patterns: [
      /\b(rook|quinn).{0,40}(rook|quinn)\b/i,
      /\bboth.{0,20}gate\b/i,
      /\bsecurity.{0,30}(qa|quality|validation)\b/i,
      /\b(qa|quality).{0,30}security\b/i,
      /\btwo gate\b/i,
      /\bgate.{0,20}(before|pass|check)\b/i,
      /\bactionable\b/i,
      /\b(check|confirm|verify|run|write|read|grep|curl|test|fix|validate|scan)\b/i,
    ],
    minMatches: 4,
  },
];

export const FAST_CRITERIA_DEV_LOOP: Criterion[] = [
  {
    label: "Backlog state verified before starting",
    patterns: [
      /\bbacklog\b.{0,40}\b(verify|check|read|confirm|state|item|entry)\b/i,
      /\b(verify|check|read|confirm)\b.{0,40}\bbacklog\b/i,
      /\bBACKLOG\.md\b/i,
      /\bIN PROGRESS\b/i,
      /\bbacklog (item|entry|scope)\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Real-data question asked before make target",
    patterns: [
      /\breal.{0,20}(account|data)\b/i,
      /\b(require|need).{0,30}real.{0,20}(data|account)\b/i,
      /\btest-rebuild-live\b/i,
      /\bpreserves?.{0,20}data-test\b/i,
      /\b(seed|wipe).{0,30}(fake|canned|fresh)\b/i,
      /\breal data.{0,20}(needed|required|yes|no)\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Research spawned for non-trivial items",
    patterns: [
      /\b(CodexResearcher|PerplexityResearcher|ClaudeResearcher)\b/i,
      /\bspawn.{0,30}(researcher|research)\b/i,
      /\b(research|gather).{0,30}(API docs?|gotcha|pattern|doc)\b/i,
      /\bAPI docs?\b/i,
      /\bknown gotcha\b/i,
      /\bimplementation brief.{0,30}research\b/i,
      /\bresearch findings\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Container currency verified before tests",
    patterns: [
      /\b(container|image).{0,30}(currency|fresh|stale|build time)\b/i,
      /\b(verify|check|confirm).{0,30}(container|image).{0,30}(fresh|stale|currency|build)\b/i,
      /\bdocker inspect\b/i,
      /\bimage build time\b/i,
      /\bstale (image|container)\b/i,
      /\bbuild time.{0,30}source change\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "DA reads 7776 output and signs off",
    patterns: [
      /\b(DA|Rayford).{0,40}(sign.?off|read|approve|output)\b/i,
      /\bsign.?off\b/i,
      /\bworktree.{0,30}(not|don.t|does not).{0,30}(satisfy|count|qualify)\b/i,
      /\b7776\b/,
      /\bDA reads\b/i,
      /\breport.{0,20}(output|result).{0,20}(to DA|Rayford)\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Regression test written if missing",
    patterns: [
      /\b(do we have|is there).{0,20}(a test|regression test)\b/i,
      /\bwrite.{0,20}(test|regression).{0,20}(if|missing|no)\b/i,
      /\bregression test\b/i,
      /\btest.{0,20}(missing|absent|exist)\b/i,
      /\b(red.{0,10}green|failing.{0,10}passing)\b/i,
      /\bwrite.{0,10}(spec|test)\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "DA runs make rebuild (not Marcus)",
    patterns: [
      /\bDA runs\b/i,
      /\b(only|DA|Rayford).{0,20}(runs|triggers|executes).{0,20}make rebuild\b/i,
      /\bmake rebuild\b/i,
      /\brebuild.{0,20}autonomously\b/i,
      /\bnot Marcus.{0,20}rebuild\b/i,
      /\brebuild.{0,20}(not|never).{0,20}(Marcus|worktree)\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Both gates before commit (Quinn 7777 + Rook)",
    patterns: [
      /\b(quinn|rook).{0,60}(quinn|rook)\b/i,
      /\bboth.{0,20}gate\b/i,
      /\b(quinn).{0,30}(7777|prod)\b/i,
      /\b(rook).{0,30}(scan|changed file)\b/i,
      /\bgate.{0,20}(before|pass|check).{0,20}commit\b/i,
      /\bparallel.{0,30}(quinn|rook)\b/i,
    ],
    minMatches: 1,
  },
];

export const FAST_CRITERIA_SHIP: Criterion[] = [
  {
    label: "All five steps walked",
    patterns: [
      /\b(step\s*1|SCOPE)\b/i,
      /\b(step\s*2|BUILD)\b/i,
      /\b(step\s*3|VERIFY)\b/i,
      /\b(step\s*4|DURABILITY)\b/i,
      /\b(step\s*5|CLOSE)\b/i,
    ],
    minMatches: 5,
  },
  {
    label: "Templates.md read and used",
    patterns: [
      /\bTEMPLATES\.md\b/,
      /\bread.{0,20}TEMPLATES/i,
      /\b##\s+AC-\d/,
      /\b##\s+DISCOVERY\b/,
      /\b##\s+ATTEMPT\s+\d/,
      /\b##\s+Completion Report\b/,
      /\b##\s+Sizing Declaration\b/,
      /\bREPLACE:/,
      /\btemplate.{0,20}(from|in|per|using).{0,20}TEMPLATES/i,
    ],
    minMatches: 2,
  },
  {
    label: "Agent brief from template",
    patterns: [
      /\bBRIEF-TEMPLATES\.md\b/i,
      /\bMarcus.{0,30}(brief|template)\b/i,
      /\b(Context|Task|Git protocol|Files to read|Scope.{0,10}do.?not.?touch)\b/i,
      /\bbypassPermissions\b/i,
      /\bnever freeform\b/i,
      /\bQuinn.{0,20}(brief|template)\b/i,
      /\bRook.{0,20}(brief|template)\b/i,
    ],
    minMatches: 2,
  },
  {
    label: "Posted to GitHub issue",
    patterns: [
      /\bgh issue comment\b/i,
      /\bpost.{0,30}(issue|github)\b/i,
      /\b(issue|github).{0,30}post\b/i,
      /\bsystem of record\b/i,
      /\b(ACs|acceptance criteria).{0,30}(post|issue)\b/i,
      /\b(DISCOVERY|ATTEMPT|Completion Report).{0,20}(post|issue)\b/i,
      /\b(findings|sizing).{0,20}(post|issue)\b/i,
    ],
    minMatches: 2,
  },
  {
    label: "Scope ACs structured",
    patterns: [
      /\bacceptance criter/i,
      /\bAC[-\s]?\d/i,
      /\b(Type|Statement|Metric|Threshold|Evidence Method|Pass Criteria)\b/i,
      /\bstructured template\b/i,
      /\b(CODE|OUTCOME)\s+AC/i,
      /\b7 fields\b/i,
      /\b10 fields\b/i,
    ],
    minMatches: 2,
  },
  {
    label: "TDD red-green",
    patterns: [
      /\bred.{0,10}green\b/i,
      /\bTDD\b/,
      /\bregression test\b/i,
      /\bwrite.{0,20}test.{0,20}first\b/i,
      /\bSkill\(.?tdd.?\)/i,
      /\bfail.{0,20}before.{0,20}fix\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Batch diagnostic for bugs",
    patterns: [
      /\b(batch|single pass|one pass)\b/i,
      /\benvironment.{0,20}(confirm|verify|check|7776|7777)\b/i,
      /\b(7776|7777)\b/,
      /\bbatch diagnostic\b/i,
      /\bhypothes[ie][sz]\b/i,
      /\bsingle.{0,20}(hypothesis|change)\b/i,
    ],
    minMatches: 1,
  },
  {
    label: "Gate scripts run",
    patterns: [
      /\bscope-gate\.sh\b/i,
      /\bverify-gate\.sh\b/i,
      /\bdurability-gate\.sh\b/i,
      /\bclose-gate\.sh\b/i,
      /\bgate.{0,10}(script|bash|run|check)\b/i,
      /\biteration-gate\.sh\b/i,
    ],
    minMatches: 2,
  },
  {
    label: "Verify evidence per AC",
    patterns: [
      /\bevidence.{0,20}(per|every|each|all).{0,20}(AC|criterion|criteria)\b/i,
      /\b(screenshot|curl|test.{0,10}(result|output)|file:line)\b/i,
      /\bconsumer.{0,20}verif/i,
      /\bcompletion.{0,10}(report|template)\b/i,
      /\bno.{0,20}freeform.{0,20}done\b/i,
    ],
    minMatches: 2,
  },
  {
    label: "PRECEDES: Read TEMPLATES.md before writing ACs",
    patterns: [
      /\bTEMPLATES\.md\b/,
      /\bAC[-\s]?\d/i,
    ],
    minMatches: 2,
    precedes: {
      anchor: /\b[Rr]ead.{0,30}TEMPLATES\.md\b/,
      target: /\b(AC-\d|[Ww]rite.{0,20}acceptance|[Pp]ost.{0,20}AC|acceptance criteria.{0,20}(using|from|per))/,
    },
  },
  {
    label: "PRECEDES: Read BRIEF-TEMPLATES.md before agent brief",
    patterns: [
      /\bBRIEF-TEMPLATES\.md\b/i,
      /\b(brief|agent)\b/i,
    ],
    minMatches: 2,
    precedes: {
      anchor: /\b[Rr]ead.{0,30}BRIEF-TEMPLATES\.md\b/,
      target: /\b(##\s*(Context|Task)\b|[Ww]rite.{0,15}brief|[Ss]pawn.{0,15}[Aa]gent|[Ss]end.{0,15}to\b|[Aa]gent\s*\()/,
    },
  },
  {
    label: "PRECEDES: Post ACs to issue before BUILD",
    patterns: [
      /\bgh issue comment\b/i,
      /\bBUILD\b/,
    ],
    minMatches: 2,
    precedes: {
      anchor: /\b(gh issue comment|[Pp]ost.{0,20}(ACs|acceptance).{0,20}issue)\b/,
      target: /\b(Step\s*2\b|##\s*BUILD\b|\bBUILD\b.{0,10}(step|phase|start))/,
    },
  },
  {
    label: "PRECEDES: Read TEMPLATES.md before completion report",
    patterns: [
      /\bTEMPLATES\.md\b/,
      /\b[Cc]ompletion [Rr]eport\b/,
    ],
    minMatches: 2,
    precedes: {
      anchor: /\b[Rr]ead.{0,30}TEMPLATES\.md\b/,
      target: /\b([Pp]ost|[Ww]rite).{0,20}[Cc]ompletion [Rr]eport\b/,
    },
  },
];

export const CRITERIA_REGISTRY: Record<string, Criterion[]> = {
  "debugging-and-bug-fixes": FAST_CRITERIA_DEBUGGING,
  "testing-and-qa-validation": FAST_CRITERIA_QA,
  "dev-loop": FAST_CRITERIA_DEV_LOOP,
  "ship": FAST_CRITERIA_SHIP,
};

export function getCriteriaForSkill(skillName?: string): Criterion[] {
  if (!skillName) return FAST_CRITERIA_DEBUGGING;
  for (const [key, criteria] of Object.entries(CRITERIA_REGISTRY)) {
    if (skillName.includes(key) || key.includes(skillName)) return criteria;
  }
  return FAST_CRITERIA_DEBUGGING;
}

// ── Tune Skill ──

function extractLowestCriteria(evalResult: SkillEvalResult): string[] {
  const failing = evalResult.perCriteria.filter((c) => !c.passed);
  if (failing.length > 0) return failing.map((c) => c.name);
  return evalResult.perCriteria
    .slice()
    .sort(() => Math.random() - 0.5)
    .slice(0, 2)
    .map((c) => c.name);
}

export async function tuneSkill(config: SkillTuneConfig): Promise<SkillTuneResult> {
  const baselineEval = await config.evaluator.evaluate(config.skillText);
  let lowestCriteria = extractLowestCriteria(baselineEval);

  const hillClimbResult = await hillClimb({
    current: config.skillText,
    rounds: config.rounds,
    stateDir: config.stateDir,
    maxChangeRatio: config.maxChangeRatio,
    weakDimension: lowestCriteria[0] ?? "",
    evaluate: async (text: string) => {
      const result = await config.evaluator.evaluate(text);
      lowestCriteria = extractLowestCriteria(result);
      return result.compositeScore;
    },
    propose: async (text: string) => {
      return config.proposer.propose(text, lowestCriteria);
    },
  });

  return {
    originalText: config.skillText,
    bestText: hillClimbResult.finalText,
    initialScore: hillClimbResult.initialScore,
    finalScore: hillClimbResult.finalScore,
    totalDelta: hillClimbResult.totalDelta,
    roundsKept: hillClimbResult.kept,
    hillClimbResult,
    lowestCriteria,
  };
}
