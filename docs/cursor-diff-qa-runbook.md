# Cursor-style Diff Preview — QA Runbook

## Prerequisites
- OpenCode IDE fork built and running
- Test fixture: `printf 'line1\nline2\nline3\n' > /tmp/diff-qa-fixture.txt`
- Expected original md5: `a00ff37ae8db4f2e2b08dab488dcf27b`

## Step 0 — Embedded Binary Verification
**Action**: Launch fork, open any file to create a session.
**Verify**:
1. `lsof -p $(pgrep -f 'opencode serve' | head -1) 2>/dev/null | awk '/REG.*opencode-bin/ {print $NF; exit}'` → path starts with `/Applications/OpenCode IDE.app/Contents/Resources/opencode-bin/opencode-`
2. `codesign --verify --deep --strict /Applications/OpenCode\ IDE.app && echo SIGNED` → prints `SIGNED`

## Step 1 — Agent edit creates diff zone (no disk write)
**Setup**: Open `/tmp/diff-qa-fixture.txt`
**Action**: Ask agent: "change line2 to LINE2"
**Verify**: Diff decorations appear; `md5 /tmp/diff-qa-fixture.txt` unchanged

## Step 2 — Accept zone writes to disk
**Action**: Click "Accept" on diff zone
**Verify**: `md5 /tmp/diff-qa-fixture.txt` matches expected (LINE2 version)

## Step 3 — Reject zone preserves disk
**Setup**: `printf 'line1\nline2\nline3\n' > /tmp/diff-qa-fixture.txt`
**Action**: Create edit, click "Reject"
**Verify**: `md5 /tmp/diff-qa-fixture.txt` equals `a00ff37ae8db4f2e2b08dab488dcf27b`

## Step 4 — Multi-zone coexistence
**Setup**: Reset fixture
**Action**: Two edits to same file in one chain
**Verify**: Both diff zones visible simultaneously

## Step 5 — readBuffer returns staged content
**Action**: With pending zones, ask agent to read the file
**Verify**: Agent sees staged content, not original disk content

## Step 6 — Accept with pending sibling
**Action**: Accept zone 1 while zone 2 pending
**Verify**: Zone 1 written to disk; zone 2 still visible

## Step 7 — Reject last zone clears staged content
**Action**: Reject zone 2
**Verify**: readBuffer returns disk content (dirty=false)

## Step 8 — Save Modal: Accept All
**Setup**: Reset fixture, create 2 pending zones
**Action**: `Cmd+S` → click "Accept All"
**Verify**: Both edits applied; md5 matches expected

## Step 9 — Save Modal: Reject All
**Setup**: Reset fixture, create 2 pending zones
**Action**: `Cmd+S` → click "Reject All"
**Verify**: md5 equals original; buffer reverts

## Step 10 — Save Modal: Cancel Save
**Setup**: Reset fixture, create 2 pending zones
**Action**: `Cmd+S` → click "Cancel Save"
**Verify**: Modal closes; dirty indicator shown; disk unchanged; zones present

## Step 11 — Command Palette
**Setup**: Reset fixture, create 2 pending zones
**Action**: `Cmd+Shift+P` → "OpenCode: Accept All Pending Edits"
**Verify**: Zones disappear; disk updated
**Reject test**: Reset, create zones, run "OpenCode: Reject All Pending Edits" → zones gone, disk unchanged
