#!/usr/bin/env bash
# Print how origin/main, origin/staging, and the Safari fix branch relate.
# Run from repo root after: git fetch origin

set -euo pipefail

cd "$(dirname "$0")/.."

git fetch origin main staging fix/safari-polymarket-links-overview 2>/dev/null || git fetch origin

echo "=== Branch tips ==="
for b in main staging fix/safari-polymarket-links-overview; do
  if git rev-parse "origin/$b" >/dev/null 2>&1; then
    echo "origin/$b: $(git log -1 --oneline "origin/$b")"
  else
    echo "origin/$b: (missing — fetch failed)"
  fi
done

echo ""
echo "=== Counts (left=only first, right=only second) ==="
if git rev-parse origin/staging >/dev/null 2>&1 && git rev-parse origin/fix/safari-polymarket-links-overview >/dev/null 2>&1; then
  read -r left right < <(git rev-list --left-right --count origin/staging...origin/fix/safari-polymarket-links-overview)
  echo "origin/staging ... origin/fix/safari-polymarket-links-overview: ${left} ${right}"
  if [[ "$right" != "0" ]]; then
    echo "Commits on fix branch not in staging:"
    git log origin/staging..origin/fix/safari-polymarket-links-overview --oneline
  fi
fi

if git rev-parse origin/main >/dev/null 2>&1 && git rev-parse origin/fix/safari-polymarket-links-overview >/dev/null 2>&1; then
  read -r mleft mright < <(git rev-list --left-right --count origin/main...origin/fix/safari-polymarket-links-overview)
  echo "origin/main ... origin/fix/safari-polymarket-links-overview: ${mleft} ${mright}"
fi

echo ""
echo "Open PR #86 targets branch: staging (see: gh pr view 86)"
