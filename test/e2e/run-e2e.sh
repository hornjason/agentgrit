#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

echo "========================================"
echo " AgentGrit E2E Test Suite"
echo "========================================"
echo ""

# Build the image
echo "--- Building E2E image ---"
if ! docker compose -f "$COMPOSE_FILE" build 2>&1; then
  echo "[FAIL] Docker image build failed"
  exit 1
fi
echo "[PASS] Docker image built"
echo ""

# Phase 1
echo "--- Running Phase 1: Clean Install ---"
PHASE1_EXIT=0
docker compose -f "$COMPOSE_FILE" run --rm e2e-phase1 || PHASE1_EXIT=$?
echo ""

# Phase 2
echo "--- Running Phase 2: Integration ---"
PHASE2_EXIT=0
docker compose -f "$COMPOSE_FILE" run --rm e2e-phase2 || PHASE2_EXIT=$?
echo ""

# Summary
echo "========================================"
echo " E2E Summary"
echo "========================================"
if [ "$PHASE1_EXIT" -eq 0 ]; then
  echo "  Phase 1: PASS"
else
  echo "  Phase 1: FAIL (exit $PHASE1_EXIT)"
fi

if [ "$PHASE2_EXIT" -eq 0 ]; then
  echo "  Phase 2: PASS"
else
  echo "  Phase 2: FAIL (exit $PHASE2_EXIT)"
fi
echo "========================================"

if [ "$PHASE1_EXIT" -ne 0 ] || [ "$PHASE2_EXIT" -ne 0 ]; then
  exit 1
fi
exit 0
