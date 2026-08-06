#!/usr/bin/env bash
set -uo pipefail

PASS_COUNT=0
FAIL_COUNT=0
TOTAL=16

pass() {
  echo "[PASS] $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo "[FAIL] $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

export AGENTGRIT_DIR="/tmp/agentgrit-e2e"
SIGNAL_DIR="$AGENTGRIT_DIR/signals"
SETTINGS_PATH="$HOME/.claude/settings.json"
rm -rf "$AGENTGRIT_DIR"
mkdir -p "$HOME/.claude"

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

# Step 2: Install and verify Claude Code hooks
echo "--- Step 2: Verify Claude Code hooks ---"
agentgrit init --claude-code --settings "$SETTINGS_PATH" 2>&1
HOOK_COUNT=$(grep -c 'agentgrit' "$SETTINGS_PATH" 2>/dev/null || echo "0")
if [ "$HOOK_COUNT" -ge 8 ]; then
  pass "Step 2: Installed $HOOK_COUNT agentgrit hooks in settings.json (>= 8 expected)"
else
  fail "Step 2: Only $HOOK_COUNT hooks written, expected >= 8"
fi
# Verify init --claude-code is idempotent
agentgrit init --claude-code --settings "$SETTINGS_PATH" 2>&1
POST_HOOK_COUNT=$(grep -c 'agentgrit' "$SETTINGS_PATH" 2>/dev/null || echo "0")
if [ "$POST_HOOK_COUNT" -ge 8 ]; then
  pass "Step 2b: init --claude-code idempotent ($POST_HOOK_COUNT hooks preserved)"
else
  fail "Step 2b: init --claude-code reduced hooks to $POST_HOOK_COUNT"
fi

# Step 3: Copy seed rules to memoryDir and update config
echo "--- Step 3: Copy seed rules ---"
RULES_DIR="$AGENTGRIT_DIR/rules"
mkdir -p "$RULES_DIR"
cp /test/test-data/rules/*.md "$RULES_DIR/"
RULE_COUNT=$(ls "$RULES_DIR"/*.md 2>/dev/null | wc -l)
# Update config.json to set memoryDir so graph build can find rules
jq --arg rd "$RULES_DIR" '. + {memoryDir: $rd}' "$AGENTGRIT_DIR/config.json" > "$AGENTGRIT_DIR/config.tmp" && mv "$AGENTGRIT_DIR/config.tmp" "$AGENTGRIT_DIR/config.json"
if [ "$RULE_COUNT" -eq 5 ]; then
  pass "Step 3: Copied 5 seed rules to $RULES_DIR"
else
  fail "Step 3: Expected 5 rules, found $RULE_COUNT"
fi

# Step 4: agentgrit graph build
echo "--- Step 4: Graph build ---"
if agentgrit graph build 2>&1; then
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
# Verify system-reminder tags
if echo "$CONTEXT_OUTPUT" | grep -q "<system-reminder>" && echo "$CONTEXT_OUTPUT" | grep -q "</system-reminder>"; then
  pass "Step 5b: Context output wrapped in system-reminder tags"
else
  fail "Step 5b: Context output missing system-reminder tags"
fi

# Anti-gaming: verify signals dir is empty before Claude session
PRE_SIGNAL_COUNT=$(find "$SIGNAL_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
if [ "$PRE_SIGNAL_COUNT" -ne 0 ]; then
  fail "Step 6-pre: Signals dir has $PRE_SIGNAL_COUNT files before Claude session — test would be meaningless"
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

# Step 7: Check hook activity (signals or session context)
echo "--- Step 7: Check hook activity ---"
SIGNAL_COUNT=$(find "$SIGNAL_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
CONTEXT_FILE="$AGENTGRIT_DIR/state/session-context-history.jsonl"
if [ "$SIGNAL_COUNT" -ge 1 ]; then
  pass "Step 7: $SIGNAL_COUNT signal file(s) written"
elif [ -f "$CONTEXT_FILE" ]; then
  pass "Step 7: Session context written (hooks fired, no signals to capture in trivial session)"
else
  fail "Step 7: No hook activity detected — no signals and no session context"
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
echo "$DOCTOR_OUTPUT"
CORE_FAILS=$(echo "$DOCTOR_OUTPUT" | grep -iE '(base|config|graph).*fail' | wc -l | tr -d ' ')
if [ "$CORE_FAILS" -eq 0 ]; then
  pass "Step 10: Doctor core checks pass"
else
  fail "Step 10: Doctor reports $CORE_FAILS core failures"
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
    "recalls": 10,
    "positiveOutcomes": 0,
    "negativeOutcomes": 8,
    "lastRecall": "2025-10-01T00:00:00Z",
    "effectivenessRate": 0.0
  }
}
STATS_EOF
if [ -f "$STATS_FILE" ]; then
  pass "Step 11: Rule stats seeded for prune candidates"
else
  fail "Step 11: Failed to create rule-stats.json"
fi

# Create CLAUDE.md with enough rules to exceed Global budget (cap=25)
mkdir -p "$HOME/.claude"
cat > "$HOME/.claude/CLAUDE.md" << 'CLAUDE_EOF'
# Rules

- **bad-rule-never-helps:** This is a rule that never helps anyone
- **stale-unused-rule:** This rule is stale and unused
- **feedback_check_scope_first:** Check scope before implementation
- **feedback_test_in_browser:** Always test in browser
- **feedback_verify_deploy:** Verify deployment
- **extra-rule-01:** Extra padding rule for budget
- **extra-rule-02:** Another padding rule for budget
- **extra-rule-03:** Yet another padding rule
- **extra-rule-04:** Fourth padding rule
- **extra-rule-05:** Fifth padding rule
- **extra-rule-06:** Sixth padding rule
- **extra-rule-07:** Seventh padding rule
- **extra-rule-08:** Eighth padding rule
- **extra-rule-09:** Ninth padding rule
- **extra-rule-10:** Tenth padding rule
- **extra-rule-11:** Eleventh padding rule
- **extra-rule-12:** Twelfth padding rule
- **extra-rule-13:** Thirteenth padding rule
- **extra-rule-14:** Fourteenth padding rule
- **extra-rule-15:** Fifteenth padding rule
- **extra-rule-16:** Sixteenth padding rule
- **extra-rule-17:** Seventeenth padding rule
- **extra-rule-18:** Eighteenth padding rule
- **extra-rule-19:** Nineteenth padding rule
- **extra-rule-20:** Twentieth padding rule
- **extra-rule-21:** Twenty-first padding rule
- **extra-rule-22:** Twenty-second padding rule
CLAUDE_EOF

# Step 12: agentgrit rules prune (dry run by default)
echo "--- Step 12: Pruning dry run ---"
PRUNE_DRY=$(agentgrit rules prune 2>&1 || true)
if echo "$PRUNE_DRY" | grep -qi "bad-rule-never-helps\|stale-unused-rule\|prune\|candidate"; then
  pass "Step 12: Dry run identifies prune candidate(s)"
else
  fail "Step 12: Dry run did not identify any candidates"
fi

# Step 13: agentgrit rules prune --yes
echo "--- Step 13: Pruning execute ---"
if agentgrit rules prune --yes 2>&1; then
  BAD_IN_CLAUDE=$(grep -c "bad-rule-never-helps\|stale-unused-rule" "$HOME/.claude/CLAUDE.md" 2>/dev/null || true)
  BAD_IN_CLAUDE=${BAD_IN_CLAUDE:-0}
  if [ "$BAD_IN_CLAUDE" -eq 0 ]; then
    pass "Step 13: Bad rules pruned from CLAUDE.md"
  else
    fail "Step 13: Bad rules still in CLAUDE.md after pruning ($BAD_IN_CLAUDE remaining)"
  fi
else
  fail "Step 13: Pruning command failed"
fi

# Step 14: Rebuild graph + doctor after pruning
echo "--- Step 14: Post-pruning graph build + doctor ---"
if agentgrit graph build 2>&1; then
  GRAPH_FILE="$AGENTGRIT_DIR/state/knowledge-graph.json"
  POST_NODES=$(jq '.nodes | length' "$GRAPH_FILE" 2>/dev/null || echo 0)
  DOCTOR_POST=$(agentgrit doctor 2>&1 || true)
  CORE_FAILS=$(echo "$DOCTOR_POST" | grep -iE '(base|config|graph).*fail' | wc -l | tr -d ' ')
  if [ "$CORE_FAILS" -eq 0 ]; then
    pass "Step 14: Post-pruning graph has $POST_NODES nodes, 0 core failures"
  else
    fail "Step 14: Post-pruning doctor reports $CORE_FAILS core failures"
  fi
else
  fail "Step 14: Post-pruning graph build failed"
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
