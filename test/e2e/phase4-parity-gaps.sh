#!/usr/bin/env bash
set -uo pipefail

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

export AGENTGRIT_DIR="/tmp/agentgrit-e2e-parity"
SIGNAL_DIR="$AGENTGRIT_DIR/signals"
SETTINGS_PATH="$HOME/.claude/settings.json"
rm -rf "$AGENTGRIT_DIR"
mkdir -p "$HOME/.claude"

echo "=== Phase 4: Parity Gap Features ($TOTAL steps) ==="
echo ""

# Setup: init + seed rules + graph build (same as Phase 1 Steps 1-4)
echo "--- Setup: Init + seed rules + graph build ---"
agentgrit init --quick 2>&1
RULES_DIR="$AGENTGRIT_DIR/rules"
mkdir -p "$RULES_DIR"
cp /test/test-data/rules/*.md "$RULES_DIR/"
jq --arg rd "$RULES_DIR" '. + {memoryDir: $rd}' "$AGENTGRIT_DIR/config.json" > "$AGENTGRIT_DIR/config.tmp" && mv "$AGENTGRIT_DIR/config.tmp" "$AGENTGRIT_DIR/config.json"
agentgrit graph build 2>&1
echo ""

# Step 1: Hook count — init --claude-code installs exactly 12 hooks
echo "--- Step 1: Hook count (12 hooks) ---"
rm -f "$SETTINGS_PATH"
agentgrit init --claude-code --settings "$SETTINGS_PATH" 2>&1
HOOK_COUNT=$(grep -o 'agentgrit' "$SETTINGS_PATH" 2>/dev/null | wc -l | tr -d ' ')
if [ "$HOOK_COUNT" -eq 12 ]; then
  pass "Step 1: init --claude-code installed exactly 12 hooks"
else
  fail "Step 1: Expected 12 hooks, found $HOOK_COUNT"
fi

# Step 2: Capture rating — explicit /rate
echo "--- Step 2: Capture rating (explicit) ---"
echo '{"session_id":"e2e-s1","message":{"content":"/rate M:8 S:8 Q:9"}}' | npx agentgrit capture rating 2>&1
RATINGS_FILE="$SIGNAL_DIR/ratings.jsonl"
if [ -f "$RATINGS_FILE" ] && grep -q '"source":"explicit"' "$RATINGS_FILE" 2>/dev/null; then
  pass "Step 2: Explicit rating captured with source=explicit"
else
  fail "Step 2: No explicit rating in ratings.jsonl"
fi

# Step 3: Capture rating — bare number
echo "--- Step 3: Capture rating (bare number) ---"
echo '{"session_id":"e2e-s2","message":{"content":"8"}}' | npx agentgrit capture rating 2>&1
if grep -q '"source":"implicit"' "$RATINGS_FILE" 2>/dev/null; then
  pass "Step 3: Bare number rating captured with source=implicit"
else
  fail "Step 3: No implicit rating in ratings.jsonl"
fi

# Step 4: Capture session-score
echo "--- Step 4: Capture session-score ---"
SESSION_SCORES_FILE="$SIGNAL_DIR/session-scores.jsonl"
echo '{"session_id":"e2e-s1","transcript_path":"/dev/null"}' | npx agentgrit capture session-score 2>&1
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  pass "Step 4: capture session-score exited cleanly (exit=$EXIT_CODE)"
else
  fail "Step 4: capture session-score crashed (exit=$EXIT_CODE)"
fi

# Step 5: Capture debrief
echo "--- Step 5: Capture debrief ---"
echo '{"session_id":"e2e-s1","transcript_path":"/dev/null"}' | npx agentgrit capture debrief 2>&1
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  pass "Step 5: capture debrief exited cleanly (exit=$EXIT_CODE)"
else
  fail "Step 5: capture debrief crashed (exit=$EXIT_CODE)"
fi

# Step 6: Capture work-completion
echo "--- Step 6: Capture work-completion ---"
echo '{"session_id":"e2e-s3","transcript_path":"/dev/null"}' | npx agentgrit capture work-completion 2>&1
EXIT_CODE=$?
if [ "$EXIT_CODE" -eq 0 ]; then
  pass "Step 6: capture work-completion exited cleanly (exit=$EXIT_CODE)"
else
  fail "Step 6: capture work-completion crashed (exit=$EXIT_CODE)"
fi

# Step 7: Capture incident + incident-analysis
echo "--- Step 7: Capture incident + incident-analysis ---"
INCIDENTS_FILE="$SIGNAL_DIR/incidents.jsonl"
echo '{"session_id":"e2e-s4","tool_response":{"output":"Error: ENOENT: no such file or directory"},"tool_input":{"command":"cat missing.txt"}}' | npx agentgrit capture incident 2>&1
if [ -f "$INCIDENTS_FILE" ] && grep -q '"error_type"' "$INCIDENTS_FILE" 2>/dev/null; then
  # Now run incident-analysis
  echo '{"session_id":"e2e-s4"}' | npx agentgrit capture incident-analysis 2>&1
  ANALYSIS_EXIT=$?
  if [ "$ANALYSIS_EXIT" -eq 0 ]; then
    pass "Step 7: Incident captured + incident-analysis ran cleanly"
  else
    fail "Step 7: Incident captured but incident-analysis crashed (exit=$ANALYSIS_EXIT)"
  fi
else
  fail "Step 7: No incident recorded in incidents.jsonl"
fi

# Step 8: Enriched context — Performance Signals
echo "--- Step 8: Enriched context (Performance Signals) ---"
mkdir -p "$SIGNAL_DIR"
cat > "$SIGNAL_DIR/ratings.jsonl" << 'SEED_EOF'
{"id":"seed-1","type":"rating","timestamp":"2026-07-10T10:00:00Z","session_id":"seed-s1","rating":7,"source":"explicit"}
{"id":"seed-2","type":"rating","timestamp":"2026-07-15T10:00:00Z","session_id":"seed-s2","rating":5,"source":"explicit"}
{"id":"seed-3","type":"rating","timestamp":"2026-07-20T10:00:00Z","session_id":"seed-s3","rating":9,"source":"explicit"}
{"id":"seed-4","type":"rating","timestamp":"2026-07-25T10:00:00Z","session_id":"seed-s4","rating":3,"source":"implicit"}
{"id":"seed-5","type":"rating","timestamp":"2026-07-30T10:00:00Z","session_id":"seed-s5","rating":8,"source":"explicit"}
SEED_EOF
CONTEXT_OUTPUT=$(agentgrit graph context --query "test" 2>&1 || true)
if echo "$CONTEXT_OUTPUT" | grep -q "Performance Signals"; then
  pass "Step 8: graph context includes Performance Signals section"
else
  fail "Step 8: graph context missing Performance Signals section"
fi

# Step 9: Enriched context — Failure Patterns
echo "--- Step 9: Enriched context (Failure Patterns) ---"
cat > "$SIGNAL_DIR/incidents.jsonl" << 'INCIDENT_SEED_EOF'
{"timestamp":"2026-07-28T10:00:00Z","session_id":"seed-s1","error_snippet":"TypeError: undefined","error_type":"TypeError","command_preview":"bun test"}
{"timestamp":"2026-07-29T10:00:00Z","session_id":"seed-s2","error_snippet":"ENOENT: no such file","error_type":"ENOENT","command_preview":"cat missing.txt"}
{"timestamp":"2026-07-30T10:00:00Z","session_id":"seed-s3","error_snippet":"Permission denied","error_type":"PermissionDenied","command_preview":"rm /etc/hosts"}
INCIDENT_SEED_EOF
CONTEXT_OUTPUT2=$(agentgrit graph context --query "test" 2>&1 || true)
if echo "$CONTEXT_OUTPUT2" | grep -qi "Failure Patterns"; then
  pass "Step 9: graph context includes Failure Patterns section"
else
  fail "Step 9: graph context missing Failure Patterns section"
fi

# Step 10: Subcommand count — all 11 capture subcommands exist
echo "--- Step 10: Subcommand count (11 subcommands) ---"
CAPTURE_HELP=$(agentgrit capture 2>&1 || true)
EXPECTED_SUBS="rating correction tool skill sentiment harvest incident session-score debrief incident-analysis work-completion"
MISSING=""
for sub in $EXPECTED_SUBS; do
  if ! echo "$CAPTURE_HELP" | grep -q "$sub"; then
    MISSING="$MISSING $sub"
  fi
done
if [ -z "$MISSING" ]; then
  pass "Step 10: All 11 capture subcommands present"
else
  fail "Step 10: Missing subcommands:$MISSING"
fi

# Summary
echo ""
echo "=== Phase 4 Summary ==="
echo "PASS: $PASS_COUNT / $TOTAL"
echo "FAIL: $FAIL_COUNT / $TOTAL"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "Phase 4: FAIL"
  exit 1
else
  echo "Phase 4: PASS"
  exit 0
fi
