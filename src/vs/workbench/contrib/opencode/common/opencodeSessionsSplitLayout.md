## Chosen pattern

Mirror `src/vs/workbench/browser/parts/editor/sideBySideEditor.ts` for the OpenCode sessions panel: it is an existing workbench two-pane `SplitView` owner (`new SplitView(parent, { orientation: this.orientation })`) that keeps both panes registered while the container controls orientation and sizing, matching the chat/sessions layout better than editor- or terminal-specific dynamic group management.

## View definitions

The SidebarPane refactor should wrap the existing chat iframe container and the new sessions list container as two stable `IView` entries. Use horizontal orientation for SideBySide, keep the same view instances for Stacked, and let visibility decide whether the sessions side is active.

```ts
const chatView: IView = {
	element: chatElement,
	minimumSize: 320,
	maximumSize: Number.POSITIVE_INFINITY,
	layout(width, height): void {
		chatElement.style.width = `${width}px`;
		chatElement.style.height = `${height}px`;
	},
	onDidChange: Event.None as Event<void>,
};

const sessionsView: IView = {
	element: sessionsElement,
	minimumSize: 240,
	maximumSize: Number.POSITIVE_INFINITY,
	layout(width, height): void {
		sessionsElement.style.width = `${width}px`;
		sessionsElement.style.height = `${height}px`;
	},
	onDidChange: Event.None as Event<void>,
};
```

Initial SideBySide sizing uses the persisted ratio or the default split of 65/35: chat gets `Math.round(totalWidth * 0.65)`, sessions gets the remaining width, with the SplitView enforcing the chat minimum of 320px and sessions minimum of 240px.

## Visibility toggling approach

Choose `splitView.setViewVisible(1, false)` for Stacked mode and `splitView.setViewVisible(1, true)` for SideBySide mode; do not remove the sessions view.

Rationale:

1. Hidden-but-registered preserves the sessions DOM, list selection, scroll position, and child disposables across orientation toggles.
2. The sash and proportional state remain attached to the same two view indices, so persisted ratio math stays stable.
3. `removeView` would force re-add ordering, re-layout churn, and extra cleanup/recreation paths that are unnecessary for a reversible Stacked/SideBySide toggle.

## Sash position persistence

Use profile-scoped user storage with the existing key `opencode.sessions.sashPosition`. On construction, read the ratio with:

```ts
const sashRatio = storageService.getNumber('opencode.sessions.sashPosition', StorageScope.PROFILE, 0.65);
```

When the pane lays out at `totalWidth`, compute chat and sessions sizes from that ratio and clamp through SplitView constraints. Persist only user sash movement, debounced by 500ms from `splitView.onDidSashChange`, and write the first view ratio:

```ts
const ratio = splitView.getViewSize(0) / totalWidth;
storageService.store('opencode.sessions.sashPosition', ratio, StorageScope.PROFILE, StorageTarget.USER);
```

If `totalWidth <= 0`, skip writes. If storage is empty or invalid, fall back to `0.65`, preserving the default split of 65/35. The double-click sash reset should restore the same default ratio rather than clearing the view.

## Auto-widen on first SideBySide toggle

Follow the chat agent-sessions action pattern: decide the new orientation first, return early when the container is already wide enough, leave maximized auxiliary-bar state when needed, compute a target width, apply it through `layoutService.setSize`, then maximize only if constraints prevent the requested size.

For OpenCode sessions, when toggling from Stacked to SideBySide and the current pane width is below 600px, request:

```ts
const targetWidth = Math.max(600, Math.min(layoutService.mainContainerDimension.width / 2, 800));
layoutService.setSize(part, { width: targetWidth, height: currentSize.height });
```

This keeps the concrete auto-widen target capped at 800px, never requests less than the 600px threshold, and leaves the sash default at 65/35 after resize. Only perform this once for the first SideBySide toggle in a narrow pane; later toggles should respect the user's persisted pane width and the `opencode.sessions.sashPosition` ratio.

## References

- `src/vs/base/browser/ui/splitview/splitview.ts:35-41` defines the `IView` interface used by `SplitView` children.
- `src/vs/base/browser/ui/splitview/splitview.ts:49-60` documents `minimumSize` and `maximumSize`, including `Number.POSITIVE_INFINITY` for no maximum.
- `src/vs/base/browser/ui/splitview/splitview.ts:87-98` documents `onDidChange` as the relayout signal for constraint changes.
- `src/vs/base/browser/ui/splitview/splitview.ts:427-470` defines `SplitView`, its orientation, and `onDidSashChange`.
- `src/vs/workbench/browser/parts/editor/sideBySideEditor.ts:208` is the selected existing workbench reference for constructing a two-pane SplitView.
- `src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsActions.ts:973-984` shows the existing container-size check and early return before auto-resize.
- `src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsActions.ts:993-1002` shows computing and applying a new width through `layoutService.setSize`.
- `src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsActions.ts:1004-1013` shows the post-resize constraint check and auxiliary-bar maximization fallback.
- `src/vs/platform/storage/common/storage.ts:49-50` confirms `StorageScope.PROFILE` is a storage value-change scope.
- `src/vs/platform/storage/common/storage.ts:38-43` shows storage entries carry both `StorageScope` and `StorageTarget`.
