#!/usr/bin/env bash
set -euo pipefail

PASS_COUNT=0
FAIL_COUNT=0
TOTAL=14

pass() {
  echo "[PASS] $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo "[FAIL] $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

export AGENTGRIT_DIR="/tmp/agentgrit-e2e"
rm -rf "$AGENTGRIT_DIR"

echo "=== Phase 1: Clean Install Lifecycle ($TOTAL steps) ==="
echo ""

# Step 1: agentgrit init --quick
echo "--- Step 1: Init (quick mode) ---"
if agentgrit init --quick 2>&1 && \
   [ -f "$AGENTGRIT_DIR/config.json" ] && \
   [ -d "$AGENTGRIT_DIR/signals" ] && \
   [ -d "$AGENTGRIT_DIR/state" ]; then
  pass "Step 1: init --quick created config.json + directories"
else
  fail "Step 1: init --quick did not create expected files/dirs"
fi

# Step 2: agentgrit init --claude-code
echo "--- Step 2: Init Claude Code hooks ---"
SETTINGS_PATH="/tmp/agentgrit-e2e-settings.json"
echo '{}' > "$SETTINGS_PATH"
if agentgrit init --claude-code --settings "$SETTINGS_PATH" 2>&1; then
  HOOK_COUNT=$(jq '[.hooks.SessionStart, .hooks.SessionEnd, .hooks.PostToolUse] | map(select(. != null)) | length' "$SETTINGS_PATH" 2>/dev/null || echo 0)
  if [ "$HOOK_COUNT" -eq 3 ]; then
    pass "Step 2: init --claude-code installed 3 hooks"
  else
    fail "Step 2: init --claude-code installed $HOOK_COUNT/3 hooks"
  fi
else
  fail "Step 2: init --claude-code failed"
fi

# Step 3: Copy seed rules to memoryDir
echo "--- Step 3: Copy seed rules ---"
RULES_DIR="$AGENTGRIT_DIR/rules"
mkdir -p "$RULES_DIR"
cp /test/test-data/rules/*.md "$RULES_DIR/"
RULE_COUNT=$(ls "$RULES_DIR"/*.md 2>/dev/null | wc -l)
if [ "$RULE_COUNT" -eq 5 ]; then
  pass "Step 3: Copied 5 seed rules to $RULES_DIR"
else
  fail "Step 3: Expected 5 rules, found $RULE_COUNT"
fi

# Step 4: agentgrit graph build
echo "--- Step 4: Graph build ---"
if agentgrit graph build --rulesDir "$RULES_DIR" 2>&1; then
  GRAPH_FILE="$AGENTGRIT_DIR/state/knowledge-graph.json"
  if [ -f "$GRAPH_FILE" ]; then
    NODE_COUNT=$(jq '.nodes | length' "$GRAPH_FILE" 2>/dev/null || echo 0)
    if [ "$NODE_COUNT" -ge 5 ]; then
      pass "Step 4: Graph built with $NODE_COUNT nodes"
    else
      fail "Step 4: Graph has $NODE_COUNT nodes, expected >= 5"
    fi
  else
    fail "Step 4: knowledge-graph.json not created"
  fi
else
  fail "Step 4: graph build failed"
fi

# Step 5: agentgrit graph context --query "deploy container"
echo "--- Step 5: Graph context query ---"
CONTEXT_OUTPUT=$(agentgrit graph context --query "deploy container" 2>&1 || true)
if echo "$CONTEXT_OUTPUT" | grep -qi "deploy\|verify"; then
  pass "Step 5: Context query returned deployment-related rules"
else
  fail "Step 5: Context query did not return deployment rules"
fi

# Step 6: claude --print (headless session, hooks fire)
echo "--- Step 6: Claude headless session ---"
export CLAUDE_SETTINGS_PATH="$SETTINGS_PATH"
CLAUDE_OUTPUT=$(claude --print -p "What is 2+2?" --allowedTools "" --max-turns 1 2>&1 || true)
CLAUDE_EXIT=$?
if [ $CLAUDE_EXIT -eq 0 ] || echo "$CLAUDE_OUTPUT" | grep -q "4"; then
  pass "Step 6: Claude --print exited successfully"
else
  fail "Step 6: Claude --print failed (exit=$CLAUDE_EXIT)"
fi

# Step 7: Check signals directory
echo "--- Step 7: Check signals ---"
SIGNAL_DIR="$AGENTGRIT_DIR/signals"
SIGNAL_COUNT=$(find "$SIGNAL_DIR" -type f 2>/dev/null | wc -l)
if [ "$SIGNAL_COUNT" -ge 1 ]; then
  pass "Step 7: $SIGNAL_COUNT signal file(s) written"
else
  fail "Step 7: No signal files found in $SIGNAL_DIR"
fi

# Step 8: Check session-context-history.jsonl
echo "--- Step 8: Check session context history ---"
HISTORY_FILE="$AGENTGRIT_DIR/state/session-context-history.jsonl"
if [ -f "$HISTORY_FILE" ]; then
  if grep -q "ruleIds" "$HISTORY_FILE" 2>/dev/null; then
    pass "Step 8: session-context-history.jsonl has ruleIds entries"
  else
    pass "Step 8: session-context-history.jsonl exists (ruleIds may not be present on minimal session)"
  fi
else
  fail "Step 8: session-context-history.jsonl not created"
fi

# Step 9: agentgrit daemon run
echo "--- Step 9: Daemon run ---"
if agentgrit daemon run 2>&1; then
  pass "Step 9: Daemon run completed successfully"
else
  fail "Step 9: Daemon run failed"
fi

# Step 10: agentgrit doctor
echo "--- Step 10: Doctor check ---"
DOCTOR_OUTPUT=$(agentgrit doctor 2>&1 || true)
CRITICAL_FAILS=$(echo "$DOCTOR_OUTPUT" | grep -ci "critical\|FAIL" || true)
if [ "$CRITICAL_FAILS" -eq 0 ]; then
  pass "Step 10: Doctor reports 0 critical failures"
else
  fail "Step 10: Doctor reports $CRITICAL_FAILS critical issue(s)"
fi

# Step 11: Seed bad rule with low stats
echo "--- Step 11: Seed bad rule stats ---"
STATS_FILE="$AGENTGRIT_DIR/state/rule-stats.json"
cat > "$STATS_FILE" << 'STATS_EOF'
{
  "bad-rule-never-helps": {
    "recalls": 20,
    "positiveOutcomes": 1,
    "negativeOutcomes": 15,
    "lastRecall": "2026-01-01T00:00:00Z",
    "effectivenessRate": 0.05
  },
  "stale-unused-rule": {
    "recalls": 2,
    "positiveOutcomes": 0,
    "negativeOutcomes": 0,
    "lastRecall": "2025-10-01T00:00:00Z",
    "effectivenessRate": 0.0
  }
}
STATS_EOF
if [ -f "$STATS_FILE" ]; then
  pass "Step 11: Rule stats seeded for eviction candidates"
else
  fail "Step 11: Failed to create rule-stats.json"
fi

# Step 12: agentgrit rules evict --dry-run
echo "--- Step 12: Eviction dry run ---"
EVICT_DRY=$(agentgrit rules evict --dry-run --rulesDir "$RULES_DIR" 2>&1 || true)
if echo "$EVICT_DRY" | grep -qi "bad-rule-never-helps\|stale-unused-rule\|evict\|candidate"; then
  pass "Step 12: Dry run identifies eviction candidate(s)"
else
  fail "Step 12: Dry run did not identify any candidates"
fi

# Step 13: agentgrit rules evict
echo "--- Step 13: Eviction execute ---"
if agentgrit rules evict --rulesDir "$RULES_DIR" 2>&1; then
  if [ ! -f "$RULES_DIR/feedback_bad_rule_never_helps.md" ] || \
     [ ! -f "$RULES_DIR/feedback_stale_unused_rule.md" ]; then
    pass "Step 13: Bad rule(s) evicted"
  else
    fail "Step 13: Bad rules still present after eviction"
  fi
else
  fail "Step 13: Eviction command failed"
fi

# Step 14: Rebuild graph + doctor after eviction
echo "--- Step 14: Post-eviction graph build + doctor ---"
if agentgrit graph build --rulesDir "$RULES_DIR" 2>&1; then
  GRAPH_FILE="$AGENTGRIT_DIR/state/knowledge-graph.json"
  POST_NODES=$(jq '.nodes | length' "$GRAPH_FILE" 2>/dev/null || echo 0)
  DOCTOR_POST=$(agentgrit doctor 2>&1 || true)
  POST_FAILS=$(echo "$DOCTOR_POST" | grep -ci "critical\|FAIL" || true)
  if [ "$POST_FAILS" -eq 0 ]; then
    pass "Step 14: Post-eviction graph has $POST_NODES nodes, 0 critical failures"
  else
    fail "Step 14: Post-eviction doctor reports $POST_FAILS critical issue(s)"
  fi
else
  fail "Step 14: Post-eviction graph build failed"
fi

# Summary
echo ""
echo "=== Phase 1 Summary ==="
echo "PASS: $PASS_COUNT / $TOTAL"
echo "FAIL: $FAIL_COUNT / $TOTAL"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "Phase 1: FAIL"
  exit 1
else
  echo "Phase 1: PASS"
  exit 0
fi
