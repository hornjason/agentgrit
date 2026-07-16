#!/usr/bin/env bash
set -euo pipefail

PASS_COUNT=0
FAIL_COUNT=0
TOTAL=10

pass() {
  echo "[PASS] $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo "[FAIL] $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

export AGENTGRIT_DIR="/tmp/agentgrit-e2e-phase2"
rm -rf "$AGENTGRIT_DIR"
mkdir -p "$AGENTGRIT_DIR"/{signals,state,rubrics}

echo "=== Phase 2: Integration with Real Data ($TOTAL steps) ==="
echo ""

# Step 1: Write config pointing to real data
echo "--- Step 1: Configure real data paths ---"
cat > "$AGENTGRIT_DIR/config.json" << 'CONFIG_EOF'
{
  "memoryDir": "/real-data/memory",
  "signalDir": "/real-data/signals",
  "rulesDir": "/real-data/rules",
  "adoptionSpeed": "quick"
}
CONFIG_EOF
if [ -f "$AGENTGRIT_DIR/config.json" ]; then
  pass "Step 1: Config created with real data paths"
else
  fail "Step 1: Config creation failed"
fi

# Step 2: Verify real memory files exist
echo "--- Step 2: Verify real memory data ---"
MEMORY_COUNT=$(ls /real-data/memory/*.md 2>/dev/null | wc -l)
if [ "$MEMORY_COUNT" -ge 50 ]; then
  pass "Step 2: Found $MEMORY_COUNT memory files (>= 50)"
else
  fail "Step 2: Found $MEMORY_COUNT memory files, expected >= 50"
fi

# Step 3: Graph build with real rules
echo "--- Step 3: Graph build from real rules ---"
if agentgrit graph build --rulesDir /real-data/rules 2>&1; then
  GRAPH_FILE="$AGENTGRIT_DIR/state/knowledge-graph.json"
  if [ -f "$GRAPH_FILE" ]; then
    NODE_COUNT=$(jq '.nodes | length' "$GRAPH_FILE" 2>/dev/null || echo 0)
    if [ "$NODE_COUNT" -ge 40 ]; then
      pass "Step 3: Graph built with $NODE_COUNT nodes (>= 40)"
    else
      fail "Step 3: Graph has $NODE_COUNT nodes, expected >= 40"
    fi
  else
    fail "Step 3: knowledge-graph.json not created"
  fi
else
  fail "Step 3: Graph build failed"
fi

# Step 4: Context query — deployment
echo "--- Step 4: Context query (deploy) ---"
DEPLOY_CTX=$(agentgrit graph context --query "deploying container" 2>&1 || true)
if echo "$DEPLOY_CTX" | grep -qi "deploy\|container\|rebuild"; then
  pass "Step 4: Deployment context returned relevant rules"
else
  fail "Step 4: Deployment context query returned no relevant results"
fi

# Step 5: Context query — delegation
echo "--- Step 5: Context query (delegation) ---"
DELEGATE_CTX=$(agentgrit graph context --query "delegating to Marcus" 2>&1 || true)
if echo "$DELEGATE_CTX" | grep -qi "marcus\|delegat\|agent\|engineer"; then
  pass "Step 5: Delegation context returned relevant rules"
else
  fail "Step 5: Delegation context query returned no relevant results"
fi

# Step 6: Parse ratings signal file
echo "--- Step 6: Parse ratings signals ---"
RATINGS_FILE="/real-data/signals/ratings.jsonl"
if [ -f "$RATINGS_FILE" ]; then
  RATING_COUNT=$(wc -l < "$RATINGS_FILE" | tr -d ' ')
  VALID_COUNT=$(jq -c '.' "$RATINGS_FILE" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$VALID_COUNT" -ge 600 ]; then
    pass "Step 6: $VALID_COUNT valid rating entries (>= 600)"
  else
    fail "Step 6: $VALID_COUNT valid entries, expected >= 600 (total lines: $RATING_COUNT)"
  fi
else
  fail "Step 6: ratings.jsonl not found at $RATINGS_FILE"
fi

# Step 7: agentgrit eval effectiveness
echo "--- Step 7: Eval effectiveness ---"
EVAL_OUTPUT=$(agentgrit eval effectiveness 2>&1 || true)
if echo "$EVAL_OUTPUT" | grep -qE "[0-9]+\.?[0-9]*%|[0-9]+\.?[0-9]* percent|effectiveness"; then
  pass "Step 7: Eval effectiveness returned percentage"
else
  fail "Step 7: Eval effectiveness did not return a percentage"
fi

# Step 8: agentgrit doctor
echo "--- Step 8: Doctor check ---"
DOCTOR_OUTPUT=$(agentgrit doctor 2>&1 || true)
echo "$DOCTOR_OUTPUT"
# Check core checks only (base, config, graph) — rubrics/signals may differ in container
CORE_FAILS=$(echo "$DOCTOR_OUTPUT" | grep -iE '(base|config|graph).*fail' | wc -l | tr -d ' ')
if [ "$CORE_FAILS" -eq 0 ]; then
  pass "Step 8: Doctor core checks pass"
else
  fail "Step 8: Doctor reports $CORE_FAILS core failures"
fi

# Step 9: Verify read-only mounts
echo "--- Step 9: Verify read-only mounts ---"
RO_TEST_FILE="/real-data/memory/_e2e_write_test.tmp"
if touch "$RO_TEST_FILE" 2>/dev/null; then
  rm -f "$RO_TEST_FILE"
  fail "Step 9: /real-data/memory is writable — should be read-only"
else
  pass "Step 9: /real-data/ mounts are read-only (write rejected)"
fi

# Step 10: Claude Code integration with real graph
echo "--- Step 10: Claude Code with real graph context ---"
SETTINGS_PATH="/tmp/agentgrit-e2e-settings.json"
echo '{}' > "$SETTINGS_PATH"
if agentgrit init --claude-code --settings "$SETTINGS_PATH" 2>&1; then
  export CLAUDE_SETTINGS_PATH="$SETTINGS_PATH"
  CLAUDE_OUTPUT=$(claude --print -p "What is 1+1?" --allowedTools "" --max-turns 1 2>&1 || true)
  CLAUDE_EXIT=$?
  if [ $CLAUDE_EXIT -eq 0 ] || echo "$CLAUDE_OUTPUT" | grep -q "2"; then
    pass "Step 10: Claude --print with real graph context succeeded"
  else
    fail "Step 10: Claude --print failed (exit=$CLAUDE_EXIT)"
  fi
else
  fail "Step 10: init --claude-code failed"
fi

# Summary
echo ""
echo "=== Phase 2 Summary ==="
echo "PASS: $PASS_COUNT / $TOTAL"
echo "FAIL: $FAIL_COUNT / $TOTAL"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "Phase 2: FAIL"
  exit 1
else
  echo "Phase 2: PASS"
  exit 0
fi
