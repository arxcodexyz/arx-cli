#!/bin/bash
# ArxCode CLI pre-commit hook — scan for API keys before committing.
# Install: ln -sf ../../scripts/pre-commit.sh .git/hooks/pre-commit

set -euo pipefail

RED='\033[0;31m'
NC='\033[0m'

# Patterns that look like API keys
PATTERNS=(
  'sk-[a-zA-Z0-9]{20,}'
  'gsk_[a-zA-Z0-9]{20,}'
  'sk-ant[a-zA-Z0-9_-]{20,}'
  'xai-[a-zA-Z0-9]{20,}'
  'AIzaSy[a-zA-Z0-9_-]{20,}'
  'sk-[a-zA-Z0-9]{48}'
  'pk\.[a-zA-Z0-9_-]{20,}'
  'rk\.[a-zA-Z0-9_-]{20,}'
)

FOUND=0
STAGED=$(git diff --cached --name-only --diff-filter=ACM)

for FILE in $STAGED; do
  # Skip binary files
  if file "$FILE" 2>/dev/null | grep -q 'binary'; then
    continue
  fi

  for PATTERN in "${PATTERNS[@]}"; do
    if git show ":$FILE" 2>/dev/null | grep -qIE "$PATTERN"; then
      echo -e "${RED}⚠️  API KEY LEAK DETECTED in $FILE${NC}"
      echo "   Matched pattern: $PATTERN"
      echo "   This looks like a real API key. Do NOT commit it."
      echo ""
      FOUND=1
    fi
  done
done

if [ "$FOUND" -eq 1 ]; then
  echo -e "${RED}🚫 Commit blocked: potential API key leak.${NC}"
  echo "   If this is a false positive (example/docs only), use:"
  echo "   git commit --no-verify"
  exit 1
fi

echo "✅ No API keys detected in staged files."
exit 0
