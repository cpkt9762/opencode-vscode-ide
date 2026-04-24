# Changelog

## cursor-diff-v1 (2026-04-23)

### Added
- Cursor-style inline diff preview: agent edits appear as pending diff zones with Accept/Reject
- Accept All / Reject All commands via Command Palette
- Embedded patched opencode binary, no system opencode dependency
- hostBridge HTTP loopback server for opencode-serve ↔ IDE communication
- StagedContentStore for multi-edit chain self-consistency
- Additive DiffZone mode (`replaceExisting: false`)

### Technical
- Feature opt-in via `OPENCODE_DIFF_BRIDGE_URL` env var
- Tool patches env-gated; standalone CLI unaffected
- Rollback: set env var empty to disable without rebuild
