#!/usr/bin/env bash
set -uo pipefail

PASS_COUNT=0
FAIL_COUNT=0
TOTAL=8

pass() {
  echo "[PASS] $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo "[FAIL] $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

export AGENTGRIT_DIR="/tmp/agentgrit-e2e-coexist"
PAI_SIGNAL_DIR="$HOME/.claude/MEMORY/LEARNING/SIGNALS"
rm -rf "$AGENTGRIT_DIR"

echo "=== Phase 3b: PAI Coexistence ($TOTAL steps) ==="
echo ""

# Step 1: Create fake PAI signal directories
echo "--- Step 1: Create PAI signal dirs ---"
mkdir -p "$PAI_SIGNAL_DIR"
echo '{"score":"M:5 S:5 Q:5","sessionId":"fake-001","timestamp":"2026-01-01T00:00:00Z"}' > "$PAI_SIGNAL_DIR/ratings.jsonl"
echo '{"phrase":"no that is wrong","context":"test","sessionId":"fake-001"}' > "$PAI_SIGNAL_DIR/corrections.jsonl"
if [ -d "$PAI_SIGNAL_DIR" ] && [ -f "$PAI_SIGNAL_DIR/ratings.jsonl" ]; then
  pass "Step 1: PAI signal directories created with seed data"
else
  fail "Step 1: Failed to create PAI signal directories"
fi

# Step 2: agentgrit init --quick
echo "--- Step 2: Init agentgrit (quick) ---"
if agentgrit init --quick 2>&1 && \
   [ -f "$AGENTGRIT_DIR/config.json" ] && \
   [ -d "$AGENTGRIT_DIR/signals" ]; then
  pass "Step 2: agentgrit init --quick succeeded"
else
  fail "Step 2: agentgrit init --quick failed"
fi

# Step 3: Install Claude Code hooks
echo "--- Step 3: Install hooks with PAI present ---"
SETTINGS_PATH="$AGENTGRIT_DIR/test-settings.json"
echo '{}' > "$SETTINGS_PATH"
agentgrit init --claude-code --settings "$SETTINGS_PATH" 2>&1
HOOK_COUNT=$(grep -c 'agentgrit' "$SETTINGS_PATH" 2>/dev/null || echo "0")
if [ "$HOOK_COUNT" -ge 8 ]; then
  pass "Step 3: Installed $HOOK_COUNT hooks with PAI coexisting"
else
  fail "Step 3: Only $HOOK_COUNT hooks, expected >= 8"
fi

# Step 4: Verify PAI detected by detectSignalSources
echo "--- Step 4: PAI detection ---"
DETECT_OUTPUT=$(node -e "
  const { detectSignalSources } = require('@agentgrit/core');
  const r = detectSignalSources();
  console.log(JSON.stringify(r));
" 2>&1 || true)
if echo "$DETECT_OUTPUT" | grep -q '"source":"pai"'; then
  pass "Step 4: detectSignalSources reports source=pai"
else
  fail "Step 4: detectSignalSources did not detect PAI (output: $DETECT_OUTPUT)"
fi

# Step 5: Verify agentgrit signals dir is separate from PAI
echo "--- Step 5: Signal dir isolation ---"
AG_SIGNAL_DIR="$AGENTGRIT_DIR/signals"
if [ -d "$AG_SIGNAL_DIR" ] && [ "$AG_SIGNAL_DIR" != "$PAI_SIGNAL_DIR" ]; then
  pass "Step 5: AgentGrit signal dir ($AG_SIGNAL_DIR) separate from PAI ($PAI_SIGNAL_DIR)"
else
  fail "Step 5: Signal directories not isolated"
fi

# Step 6: Verify installed-hooks.json manifest written
echo "--- Step 6: Hook manifest ---"
MANIFEST="$AGENTGRIT_DIR/installed-hooks.json"
if [ -f "$MANIFEST" ]; then
  MANIFEST_COUNT=$(jq '.count' "$MANIFEST" 2>/dev/null || echo 0)
  if [ "$MANIFEST_COUNT" -ge 8 ]; then
    pass "Step 6: installed-hooks.json manifest has count=$MANIFEST_COUNT"
  else
    fail "Step 6: Manifest count=$MANIFEST_COUNT, expected >= 8"
  fi
else
  fail "Step 6: installed-hooks.json not created"
fi

# Step 7: Verify PAI signals are not overwritten
echo "--- Step 7: PAI signal preservation ---"
PAI_RATINGS=$(wc -l < "$PAI_SIGNAL_DIR/ratings.jsonl" 2>/dev/null | tr -d ' ')
PAI_CORRECTIONS=$(wc -l < "$PAI_SIGNAL_DIR/corrections.jsonl" 2>/dev/null | tr -d ' ')
if [ "$PAI_RATINGS" -ge 1 ] && [ "$PAI_CORRECTIONS" -ge 1 ]; then
  pass "Step 7: PAI signal files preserved (ratings=$PAI_RATINGS, corrections=$PAI_CORRECTIONS)"
else
  fail "Step 7: PAI signal files modified or deleted"
fi

# Step 8: Verify hooks reference agentgrit commands, not PAI
echo "--- Step 8: Hook commands reference agentgrit ---"
PAI_REFS=$(grep -c 'pai\|PAI' "$SETTINGS_PATH" 2>/dev/null || echo "0")
AG_REFS=$(grep -c 'agentgrit' "$SETTINGS_PATH" 2>/dev/null || echo "0")
if [ "$AG_REFS" -ge 8 ] && [ "$PAI_REFS" -eq 0 ]; then
  pass "Step 8: All hooks reference agentgrit ($AG_REFS), zero PAI references"
else
  fail "Step 8: Hook references wrong (agentgrit=$AG_REFS, PAI=$PAI_REFS)"
fi

# Cleanup fake PAI signals
rm -rf "$PAI_SIGNAL_DIR"
rm -rf "$AGENTGRIT_DIR"

# Summary
echo ""
echo "=== Phase 3b Summary ==="
echo "PASS: $PASS_COUNT / $TOTAL"
echo "FAIL: $FAIL_COUNT / $TOTAL"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "Phase 3b: FAIL"
  exit 1
else
  echo "Phase 3b: PASS"
  exit 0
fi
