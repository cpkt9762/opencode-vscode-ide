# OpenCode Agent Edit Decorations

When the OpenCode agent edits a file via Edit, Write, MultiEdit, or ApplyPatch, the file gets highlighted in the VS Code Explorer with a colored label and an `A` badge so you can see at a glance what changed.

## How it looks

![Modified state — saturated teal A badge](images/agent-edit-decorations-modified.png)

*(Screenshot pending — see [manual QA checklist](../.sisyphus/plans/opencode-agent-edit-decorations-plan.md) for capture instructions.)*

![Viewed state — dimmed teal A badge](images/agent-edit-decorations-viewed.png)

*(Screenshot pending — see [manual QA checklist](../.sisyphus/plans/opencode-agent-edit-decorations-plan.md) for capture instructions.)*

The placeholder paths above are reserved for the Task 13 manual QA captures:

- `docs/images/agent-edit-decorations-modified.png`
- `docs/images/agent-edit-decorations-viewed.png`

Do not replace them with generated images. They should be captured from a real launched IDE session.

## Lifecycle

Agent edit decorations move through three states: `modified`, `viewed`, and `cleared`.

1. The OpenCode backend publishes a `file.edited` SSE event after an agent edit changes a file.
   The Explorer entry is marked `modified`, uses the saturated teal label color, and shows an `A` badge.
2. When available, completed tool-part metadata from `message.part.updated` adds hunk ranges for the edit.
   This lets the editor reveal the latest hunk when you open the file.
3. When you open a modified file, the editor scrolls to the last known hunk and the state changes to `viewed`.
   The Explorer keeps the `A` badge but dims the label color so you know you already inspected it.
4. When SCM reports the file is clean after a commit, revert, stash, or undo, the highlight is automatically cleared.
5. You can also run `OpenCode: Clear Agent Edit Highlights` to clear all current highlights immediately.

Opening a viewed file again does not re-scroll unless the agent edits it again. A later `file.edited` event moves the file back to the `modified` state.

## Color tokens

The feature uses theme color tokens so teams can tune the Explorer label colors without changing code:

- `list.opencodeAgentModifiedForeground` — saturated teal for files modified by the agent and not yet viewed.
- `list.opencodeAgentViewedForeground` — dimmed teal for files modified by the agent and already viewed.

To override the colors, open **Settings → User → JSON** and add them under `workbench.colorCustomizations`:

```json
{
  "workbench.colorCustomizations": {
    "list.opencodeAgentModifiedForeground": "#00bfa5",
    "list.opencodeAgentViewedForeground": "#6aaea4"
  }
}
```

## Palette command

Use **OpenCode: Clear Agent Edit Highlights** to remove all current Explorer highlights manually.

- Command id: `opencode.clearAgentEditHighlights`
- Discoverable from F1 / Command Palette
- Applies regardless of SCM state

This is useful when you intentionally reviewed changes outside the normal open-file flow, or when a file is outside an SCM repository and cannot be auto-cleared.

## Known limitations

- **`OPENCODE_DIFF_BRIDGE_URL` mode**: when the diff bridge is active, the upstream backend does not publish `file.edited` events, so highlights will be incomplete. This is opt-in, controlled by an environment variable, and not the default mode.
- **No persistence**: highlights live in memory only. Reloading the window or switching workspaces resets them.
- **High-contrast theme**: the color tokens use default values only; there are no theme-tuned high-contrast overrides yet.
- **Cross-workspace persistence of viewed state**: viewed state is not retained after changing workspaces.
- **Inline editor decorations**: gutter markers, glyph-margin icons, and inline editor highlights are not included. Only Explorer file-tree decorations are shown.
- **`apply_patch` per-file hunks**: aggregated multi-file diffs cannot be cleanly split per file in v1.4. Files edited by `apply_patch` get the `A` badge, but no auto-reveal hunk. This is deferred to v2.

## v2 roadmap

Future work may add per-hunk timestamps for smarter auto-reveal, persistence across restarts, gutter decorations, a status bar indicator, and theme-specific palettes for high-contrast and custom themes.
