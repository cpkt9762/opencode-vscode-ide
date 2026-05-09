/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// biome-ignore lint/style/useNodejsImportProtocol: vscode test convention
import * as assert from "assert";
import { Event } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../../../base/test/common/utils.js";
import type { ILogService } from "../../../../../platform/log/common/log.js";
import { type IWorkspaceContextService, type IWorkspaceFolder, WorkbenchState } from "../../../../../platform/workspace/common/workspace.js";
import { AgentEditTracker } from "../../browser/agentEditTracker.js";
import type { HunkRange } from "../../common/opencodeSessionsTypes.js";

const workspaceRoot = URI.file("/workspace");
const inWorkspaceUri = URI.file("/workspace/file.ts");
const secondInWorkspaceUri = URI.file("/workspace/second.ts");
const thirdInWorkspaceUri = URI.file("/workspace/nested/third.ts");
const outsideWorkspaceUri = URI.file("/outside/file.ts");
const hunk1: HunkRange = { modifiedStartLine: 3, modifiedLineCount: 2 };
const hunk2: HunkRange = { modifiedStartLine: 9, modifiedLineCount: 4 };

function createWorkspaceContextService(root: URI | undefined = workspaceRoot): IWorkspaceContextService {
	const folder: IWorkspaceFolder | undefined = root ? {
		uri: root,
		name: "workspace",
		index: 0,
		toResource(relativePath) {
			return URI.file(`${root.fsPath}/${relativePath}`);
		},
	} : undefined;
	const workspace = { id: "test-workspace", folders: folder ? [folder] : [] };

	return {
		_serviceBrand: undefined,
		onDidChangeWorkbenchState: Event.None,
		onDidChangeWorkspaceName: Event.None,
		onWillChangeWorkspaceFolders: Event.None,
		onDidChangeWorkspaceFolders: Event.None,
		async getCompleteWorkspace() {
			return workspace;
		},
		getWorkspace() {
			return workspace;
		},
		getWorkbenchState() {
			return folder ? WorkbenchState.FOLDER : WorkbenchState.EMPTY;
		},
		getWorkspaceFolder(resource: URI) {
			if (!folder) {
				return null;
			}

			return resource.fsPath.startsWith(folder.uri.fsPath) ? folder : null;
		},
		isCurrentWorkspace() {
			return true;
		},
		isInsideWorkspace(resource: URI) {
			return Boolean(folder && resource.fsPath.startsWith(folder.uri.fsPath));
		},
		hasWorkspaceData() {
			return Boolean(folder);
		},
	} as unknown as IWorkspaceContextService;
}

function createLogService(): ILogService {
	return {
		trace() { },
		debug() { },
		info() { },
		warn() { },
		error() { },
	} as unknown as ILogService;
}

function sortedUriStrings(uris: readonly URI[]): readonly string[] {
	return uris.map((uri) => uri.toString()).sort();
}

suite("AgentEditTracker", () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createTracker(root: URI | undefined = workspaceRoot): AgentEditTracker {
		return disposables.add(new AgentEditTracker(createWorkspaceContextService(root), createLogService()));
	}

	function collectChanges(tracker: AgentEditTracker): URI[][] {
		const changes: URI[][] = [];
		disposables.add(tracker.onDidChange((uris) => changes.push([...uris])));
		return changes;
	}

	test("markModified with no hunks or timestamp creates a modified entry and fires once", () => {
		const tracker = createTracker();
		const changes = collectChanges(tracker);

		tracker.markModified(inWorkspaceUri);

		assert.deepStrictEqual(tracker.getEntry(inWorkspaceUri), { status: "modified", hunks: [], lastEditedAt: 0 });
		assert.strictEqual(changes.length, 1);
		assert.deepStrictEqual(changes[0], [inWorkspaceUri]);
	});

	test("markModified with hunks and timestamp stores both values", () => {
		const tracker = createTracker();

		tracker.markModified(inWorkspaceUri, [hunk1], 100);

		assert.deepStrictEqual(tracker.getEntry(inWorkspaceUri), { status: "modified", hunks: [hunk1], lastEditedAt: 100 });
	});

	test("markViewed flips modified entries to viewed and preserves edit metadata", () => {
		const tracker = createTracker();
		tracker.markModified(inWorkspaceUri, [hunk1], 100);

		tracker.markViewed(inWorkspaceUri);

		assert.deepStrictEqual(tracker.getEntry(inWorkspaceUri), { status: "viewed", hunks: [hunk1], lastEditedAt: 100 });
	});

	test("markModified reverts a viewed entry back to modified", () => {
		const tracker = createTracker();
		tracker.markModified(inWorkspaceUri, [hunk1], 100);
		tracker.markViewed(inWorkspaceUri);

		tracker.markModified(inWorkspaceUri);

		assert.deepStrictEqual(tracker.getEntry(inWorkspaceUri), { status: "modified", hunks: [hunk1], lastEditedAt: 100 });
	});

	test("markViewed on an untracked URI is a no-op without events", () => {
		const tracker = createTracker();
		const changes = collectChanges(tracker);

		tracker.markViewed(inWorkspaceUri);

		assert.strictEqual(tracker.getEntry(inWorkspaceUri), undefined);
		assert.strictEqual(changes.length, 0);
	});

	test("markViewed on an already-viewed URI is idempotent", () => {
		const tracker = createTracker();
		tracker.markModified(inWorkspaceUri);
		tracker.markViewed(inWorkspaceUri);
		const changes = collectChanges(tracker);

		tracker.markViewed(inWorkspaceUri);

		assert.deepStrictEqual(tracker.getEntry(inWorkspaceUri), { status: "viewed", hunks: [], lastEditedAt: 0 });
		assert.strictEqual(changes.length, 0);
	});

	test("markRemoved deletes tracked entries and fires with the URI", () => {
		const tracker = createTracker();
		tracker.markModified(inWorkspaceUri);
		const changes = collectChanges(tracker);

		tracker.markRemoved(inWorkspaceUri);

		assert.strictEqual(tracker.getEntry(inWorkspaceUri), undefined);
		assert.strictEqual(changes.length, 1);
		assert.deepStrictEqual(changes[0], [inWorkspaceUri]);
	});

	test("attachHunks on an untracked URI creates a modified entry", () => {
		const tracker = createTracker();

		tracker.attachHunks(inWorkspaceUri, [hunk1], 100);

		assert.deepStrictEqual(tracker.getEntry(inWorkspaceUri), { status: "modified", hunks: [hunk1], lastEditedAt: 100 });
	});

	test("attachHunks on a viewed URI updates metadata and preserves status", () => {
		const tracker = createTracker();
		tracker.markModified(inWorkspaceUri, [hunk1], 100);
		tracker.markViewed(inWorkspaceUri);

		tracker.attachHunks(inWorkspaceUri, [hunk2], 200);

		assert.deepStrictEqual(tracker.getEntry(inWorkspaceUri), { status: "viewed", hunks: [hunk2], lastEditedAt: 200 });
	});

	test("clear empties all state and fires one event with all previously tracked URIs", () => {
		const tracker = createTracker();
		tracker.markModified(inWorkspaceUri);
		tracker.markModified(secondInWorkspaceUri);
		const changes = collectChanges(tracker);

		tracker.clear();

		assert.strictEqual(tracker.getEntry(inWorkspaceUri), undefined);
		assert.strictEqual(tracker.getEntry(secondInWorkspaceUri), undefined);
		assert.strictEqual(changes.length, 1);
		assert.deepStrictEqual(sortedUriStrings(changes[0]), sortedUriStrings([inWorkspaceUri, secondInWorkspaceUri]));
	});

	test("markModified silently ignores URIs outside the current workspace", () => {
		const tracker = createTracker();
		const changes = collectChanges(tracker);

		tracker.markModified(outsideWorkspaceUri);

		assert.strictEqual(tracker.getEntry(outsideWorkspaceUri), undefined);
		assert.strictEqual(changes.length, 0);
	});

	test("trackedUris is empty initially", () => {
		const tracker = createTracker();

		assert.deepStrictEqual(tracker.trackedUris, []);
	});

	test("trackedUris contains all distinct modified URIs", () => {
		const tracker = createTracker();
		tracker.markModified(inWorkspaceUri);
		tracker.markModified(secondInWorkspaceUri);
		tracker.markModified(thirdInWorkspaceUri);

		assert.strictEqual(tracker.trackedUris.length, 3);
		assert.deepStrictEqual(sortedUriStrings(tracker.trackedUris), sortedUriStrings([inWorkspaceUri, secondInWorkspaceUri, thirdInWorkspaceUri]));
	});

	test("trackedUris updates after removal and clear", () => {
		const tracker = createTracker();
		tracker.markModified(inWorkspaceUri);
		tracker.markModified(secondInWorkspaceUri);
		tracker.markModified(thirdInWorkspaceUri);

		tracker.markRemoved(secondInWorkspaceUri);

		assert.strictEqual(tracker.trackedUris.length, 2);
		assert.deepStrictEqual(sortedUriStrings(tracker.trackedUris), sortedUriStrings([inWorkspaceUri, thirdInWorkspaceUri]));

		tracker.clear();

		assert.strictEqual(tracker.trackedUris.length, 0);
	});
});
