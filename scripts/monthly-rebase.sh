#!/usr/bin/env bash
# monthly-rebase.sh — Rebase opencode-ide-fork on latest upstream VSCode stable release
set -euo pipefail

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
FORK_BRANCH="${FORK_BRANCH:-main-fork}"

echo "=== OpenCode IDE Monthly Rebase ==="
echo "Upstream remote: $UPSTREAM_REMOTE"
echo "Fork branch: $FORK_BRANCH"

git fetch "$UPSTREAM_REMOTE" --tags

LATEST_TAG=$(git tag --sort=-creatordate | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
echo "Latest stable tag: $LATEST_TAG"

echo ""
echo "Will rebase $FORK_BRANCH onto $LATEST_TAG"
echo "Press Ctrl+C to abort, Enter to continue..."
read -r

git checkout "$FORK_BRANCH"

BACKUP_TAG="pre-rebase-$(date +%Y%m%d)"
git tag "$BACKUP_TAG"
echo "Backup tag created: $BACKUP_TAG"

git rebase "$LATEST_TAG"

echo ""
echo "=== Rebase complete ==="
echo "Previous state saved as: $BACKUP_TAG"
echo "Now on: $(git describe --tags --always)"
echo ""
echo "Next steps:"
echo "  1. Run: npm ci && npm run compile"
echo "  2. Test the build"
echo "  3. If conflicts occurred, resolve and: git rebase --continue"
echo "  4. Tag the new state: git tag poc-vX"
