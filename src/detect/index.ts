export {
  detectFailurePatterns, clusterFailureEntries, classifyFailureType,
  scoreSeverity, stepToSkill, generatePatchProposals,
  detectIncidentPatterns, pruneOldIncidents,
  type FailureEntry, type FailureCluster, type FailureRouting,
  type PatchProposal, type IncidentRecord,
} from "./failures";

export {
  minePatterns, synthesizePatterns, convertReportPatterns,
  buildMiningPayload, slugify,
  FRUSTRATION_PATTERNS, SUCCESS_PATTERNS,
  type PatternGroup, type SynthesisResult,
  type NewGapPattern, type AnnotatedPattern,
} from "./patterns";

export {
  addTrajectory, addQualifiedTrajectory, queryTrajectories,
  queryByAgent, listTrajectories, trajectoryStats,
  gcTrajectories, generateTrajectoryId,
  isQualifiedRating, parseAgentId,
  RATING_THRESHOLD, VALID_AGENT_IDS,
  type AgentId, type TrajectoryStoreStats,
} from "./trajectories";

export {
  buildCohorts, generateAntiRationalizations,
  buildWeightedAntiRationalizations, assignNodeToCohort,
  analyzeCohortHealth, classifyFailureByRegex, recencyWeight,
  COHORT_DEFINITIONS, NODE_COHORT_DEFINITIONS,
  EXTENDED_ANTI_RAT_TEMPLATES, PATTERN_MATCHERS,
  type ThemeCohort, type AntiRationalization,
  type CohortDefinition, type CohortHealth, type NodeCohortDefinition,
} from "./theme-cohorts";
