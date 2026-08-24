import type { OutcomeEvent, OutcomeType } from "../capture/outcomes";
import type { RuleSnapshot } from "../capture/rule-snapshots";

export interface TurnAttribution {
  turnIndex: number;
  outcomeType: OutcomeType;
  activeRuleIds: string[];
  weight: number;
}

export interface RuleAttribution {
  ruleId: string;
  positiveSignals: number;
  negativeSignals: number;
  totalTurns: number;
  attributionScore: number;
}

const OUTCOME_WEIGHTS: Record<OutcomeType, number> = {
  "commit-merged": 1.0,
  "tests-pass": 0.8,
  "issue-closed": 1.0,
  "pr-merged": 0.8,
  "no-regressions": 0.5,
  "correction": -0.3,
  "reprompt": -0.5,
  "healthy-iteration": 0.0,
};

function findActiveRulesAtTurn(turn: number, snapshots: RuleSnapshot[]): string[] {
  let result: string[] = [];
  for (const snap of snapshots) {
    if (snap.turn <= turn) {
      result = snap.activeRules;
    } else {
      break;
    }
  }
  return result;
}

export function attributeOutcomesToRules(
  events: OutcomeEvent[],
  snapshots: RuleSnapshot[],
): TurnAttribution[] {
  const sorted = [...snapshots].sort((a, b) => a.turn - b.turn);

  return events.map(event => ({
    turnIndex: event.turn,
    outcomeType: event.type,
    activeRuleIds: findActiveRulesAtTurn(event.turn, sorted),
    weight: OUTCOME_WEIGHTS[event.type] ?? 0,
  }));
}

export function computeRuleAttributions(
  attributions: TurnAttribution[],
): Map<string, RuleAttribution> {
  const map = new Map<string, RuleAttribution>();

  for (const attr of attributions) {
    for (const ruleId of attr.activeRuleIds) {
      let entry = map.get(ruleId);
      if (!entry) {
        entry = { ruleId, positiveSignals: 0, negativeSignals: 0, totalTurns: 0, attributionScore: 0 };
        map.set(ruleId, entry);
      }

      entry.totalTurns++;

      if (attr.weight > 0) {
        entry.positiveSignals++;
      } else if (attr.weight < 0) {
        entry.negativeSignals++;
      }

      entry.attributionScore += attr.weight;
    }
  }

  for (const entry of map.values()) {
    entry.attributionScore = Math.round(entry.attributionScore * 1000) / 1000;
  }

  return map;
}
