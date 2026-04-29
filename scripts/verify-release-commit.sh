#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <expected-commit-sha>"
  exit 2
fi

EXPECTED="$1"
ACTUAL="$(git rev-parse HEAD)"

echo "expected: $EXPECTED"
echo "actual:   $ACTUAL"

if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "ERROR: current checkout does not match expected release commit"
  exit 1
fi

echo "OK: release commit matches expected hash"
