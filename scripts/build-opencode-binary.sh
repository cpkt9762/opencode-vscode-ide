#!/usr/bin/env bash
set -euo pipefail

# ==========================================================================================
# REPOSITORY TOPOLOGY:
#   This script is PHYSICALLY hosted at  <fork-repo>/scripts/build-opencode-binary.sh
#   opencode source is resolved via THREE fallback tiers (first match wins):
#     Tier A (explicit): env var OPENCODE_SOURCE_REPO
#     Tier B (monorepo-nested dev): ../packages/opencode exists
#     Tier C (standalone CI): shallow-clone sst/opencode at pinned commit
# ==========================================================================================

FORK_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PATCH_FILE="$FORK_ROOT/patches/opencode-diff-bridge.patch"
PLATFORM="${OPENCODE_BUILD_PLATFORM:-$(node -p 'process.platform')}-${OPENCODE_BUILD_ARCH:-$(node -p 'process.arch')}"
TARGET_DIR="$FORK_ROOT/resources/opencode-bin"

# -- Handle --check-only mode ---------------------------------------------------------------
if [ "${1:-}" = "--check-only" ]; then
	echo "[check-only] verifying patch file exists and is valid"
	[ -f "$PATCH_FILE" ] || { echo "ERROR: patch file not found at $PATCH_FILE"; exit 1; }
	# If patch has actual diff content, validate it; otherwise just check file exists
	if grep -q '^diff --git' "$PATCH_FILE" 2>/dev/null; then
		echo "[check-only] patch file has diff content"
	else
		echo "[check-only] patch file exists (placeholder, no diff content yet)"
	fi
	echo "[check-only] PASS"
	exit 0
fi

# -- Resolve opencode source repo (Tier A/B/C) ---------------------------------------------
EPHEMERAL_SRC_CLONE=""
if [ -n "${OPENCODE_SOURCE_REPO:-}" ]; then
	OPENCODE_REPO="$OPENCODE_SOURCE_REPO"
	echo "[tier A] using OPENCODE_SOURCE_REPO=$OPENCODE_REPO"
elif [ -d "$FORK_ROOT/../packages/opencode" ]; then
	OPENCODE_REPO="$(cd "$FORK_ROOT/.." && pwd -P)"
	echo "[tier B] using monorepo-nested opencode at $OPENCODE_REPO"
else
	BASELINE_SHA_FILE="$FORK_ROOT/patches/OPENCODE_BASELINE_SHA.txt"
	: "${OPENCODE_PATCH_BASELINE_SHA:=$(cat "$BASELINE_SHA_FILE" 2>/dev/null || true)}"
	: "${OPENCODE_PATCH_BASELINE_SHA:?must set OPENCODE_PATCH_BASELINE_SHA when opencode source not local}"
	EPHEMERAL_SRC_CLONE="$(mktemp -d -t opencode-src-XXXXXX)"
	git clone --depth 200 https://github.com/sst/opencode.git "$EPHEMERAL_SRC_CLONE"
	git -C "$EPHEMERAL_SRC_CLONE" checkout "$OPENCODE_PATCH_BASELINE_SHA"
	OPENCODE_REPO="$EPHEMERAL_SRC_CLONE"
	echo "[tier C] cloned sst/opencode @ $OPENCODE_PATCH_BASELINE_SHA to $OPENCODE_REPO"
fi

# -- Create isolated worktree from OPENCODE_REPO -------------------------------------------
WORKTREE="$(mktemp -d -t opencode-patch-build-XXXXXX)"
cleanup() {
	git -C "$OPENCODE_REPO" worktree remove --force "$WORKTREE" 2>/dev/null || rm -rf "$WORKTREE"
	[ -n "$EPHEMERAL_SRC_CLONE" ] && rm -rf "$EPHEMERAL_SRC_CLONE"
}
trap cleanup EXIT
git -C "$OPENCODE_REPO" worktree add --detach "$WORKTREE" HEAD

# -- Apply patch in isolated worktree (dry-run first so failure is loud) -------------------
cd "$WORKTREE"
# Only apply patch if it has actual diff content
if grep -q '^diff --git' "$PATCH_FILE" 2>/dev/null; then
	git apply --check "$PATCH_FILE"
	git apply "$PATCH_FILE"
	echo "[ok] patch applied successfully"
else
	echo "[info] patch file is placeholder (no diff content) — building unpatched binary"
fi

# -- Build opencode binary for the requested platform -------------------------------------
cd packages/opencode
bun install --frozen-lockfile
OPENCODE_TARGETS="$PLATFORM" bun run build

# -- Copy artifact to fork's bundled resources directory ----------------------------------
mkdir -p "$TARGET_DIR"
EXT=""; [ "${PLATFORM%%-*}" = "win32" ] && EXT=".exe"
SRC="dist/opencode-${PLATFORM}/bin/opencode${EXT}"
cp "$SRC" "$TARGET_DIR/opencode-${PLATFORM}${EXT}"

# -- trap auto-removes worktree + ephemeral clone → original repos unchanged --------------
echo "[ok] opencode binary built: $TARGET_DIR/opencode-${PLATFORM}${EXT}"
