/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// biome-ignore lint/style/useNodejsImportProtocol: vscode test convention
import * as assert from "assert";
import { Emitter, Event } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../../../base/test/common/utils.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { EditorType, type IDiffEditor, type IEditor } from "../../../../../editor/common/editorCommon.js";
import type { EditorInput } from "../../../../common/editor/editorInput.js";
import type { IEditorService } from "../../../../services/editor/common/editorService.js";
import { AgentEditNavigator } from "../../browser/agentEditNavigator.js";
import type { IAgentEditEntry, IAgentEditTracker } from "../../common/agentEditTracker.js";
import type { HunkRange } from "../../common/opencodeSessionsTypes.js";

const trackedUri = URI.file("/workspace/file.ts");
const untrackedUri = URI.file("/workspace/untracked.ts");

class TestEditorService extends Disposable {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidActiveEditorChange = this._register(new Emitter<void>());
	readonly onDidActiveEditorChange = this._onDidActiveEditorChange.event;
	activeEditor: EditorInput | undefined;
	activeTextEditorControl: IEditor | IDiffEditor | undefined;

	fireActiveEditorChange(): void {
		this._onDidActiveEditorChange.fire();
	}
}

class TestAgentEditTracker implements IAgentEditTracker {
	declare readonly _serviceBrand: undefined;

	readonly onDidChange = Event.None;
	readonly entries = new Map<string, IAgentEditEntry>();
	readonly viewedUris: URI[] = [];

	constructor(private readonly operations: string[]) { }

	get trackedUris(): readonly URI[] {
		return [];
	}

	markModified(_uri: URI, _hunks?: readonly HunkRange[], _editedAt?: number): void { }

	attachHunks(_uri: URI, _hunks: readonly HunkRange[], _editedAt: number): void { }

	markViewed(uri: URI): void {
		this.viewedUris.push(uri);
		this.operations.push("markViewed");
	}

	markRemoved(_uri: URI): void { }

	clear(): void { }

	getEntry(uri: URI): IAgentEditEntry | undefined {
		return this.entries.get(uri.toString());
	}
}

class TestEditorControl {
	readonly revealedRanges: Range[] = [];

	constructor(
		private readonly operations: string[],
		private readonly editorType = EditorType.ICodeEditor,
	) { }

	getEditorType(): string {
		return this.editorType;
	}

	revealRangeInCenter(range: Range): void {
		this.revealedRanges.push(range);
		this.operations.push("reveal");
	}
}

function createEditorInput(resource: URI | undefined, preview = false): EditorInput {
	return { resource, preview } as unknown as EditorInput;
}

function hunk(modifiedStartLine: number, modifiedLineCount: number): HunkRange {
	return { modifiedStartLine, modifiedLineCount };
}

suite("AgentEditNavigator", () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createHarness() {
		const operations: string[] = [];
		const editorService = disposables.add(new TestEditorService());
		const tracker = new TestAgentEditTracker(operations);
		const codeEditor = new TestEditorControl(operations);
		editorService.activeEditor = createEditorInput(trackedUri);
		editorService.activeTextEditorControl = codeEditor as unknown as IEditor;
		disposables.add(new AgentEditNavigator(editorService as unknown as IEditorService, tracker));
		return { codeEditor, editorService, operations, tracker };
	}

	test("active editor URI not in tracker skips reveal and markViewed", () => {
		const harness = createHarness();
		harness.editorService.activeEditor = createEditorInput(untrackedUri);

		harness.editorService.fireActiveEditorChange();

		assert.deepStrictEqual(harness.codeEditor.revealedRanges, []);
		assert.deepStrictEqual(harness.tracker.viewedUris, []);
		assert.deepStrictEqual(harness.operations, []);
	});

	test("viewed tracker entry skips reveal and state change", () => {
		const harness = createHarness();
		const entry: IAgentEditEntry = { status: "viewed", hunks: [hunk(4, 2)], lastEditedAt: 100 };
		harness.tracker.entries.set(trackedUri.toString(), entry);

		harness.editorService.fireActiveEditorChange();

		assert.deepStrictEqual(harness.codeEditor.revealedRanges, []);
		assert.deepStrictEqual(harness.tracker.viewedUris, []);
		assert.deepStrictEqual(harness.tracker.getEntry(trackedUri), entry);
		assert.deepStrictEqual(harness.operations, []);
	});

	test("modified tracker entry with one hunk reveals range before markViewed", () => {
		const harness = createHarness();
		harness.tracker.entries.set(trackedUri.toString(), { status: "modified", hunks: [hunk(10, 2)], lastEditedAt: 100 });

		harness.editorService.fireActiveEditorChange();

		assert.deepStrictEqual(harness.codeEditor.revealedRanges, [new Range(10, 1, 12, 1)]);
		assert.deepStrictEqual(harness.tracker.viewedUris, [trackedUri]);
		assert.deepStrictEqual(harness.operations, ["reveal", "markViewed"]);
	});

	test("modified tracker entry with multiple hunks reveals the last hunk", () => {
		const harness = createHarness();
		harness.tracker.entries.set(trackedUri.toString(), {
			status: "modified",
			hunks: [hunk(2, 1), hunk(8, 4), hunk(21, 3)],
			lastEditedAt: 100,
		});

		harness.editorService.fireActiveEditorChange();

		assert.deepStrictEqual(harness.codeEditor.revealedRanges, [new Range(21, 1, 24, 1)]);
		assert.deepStrictEqual(harness.tracker.viewedUris, [trackedUri]);
		assert.deepStrictEqual(harness.operations, ["reveal", "markViewed"]);
	});

	test("modified tracker entry with no hunks marks viewed without reveal", () => {
		const harness = createHarness();
		harness.tracker.entries.set(trackedUri.toString(), { status: "modified", hunks: [], lastEditedAt: 100 });

		harness.editorService.fireActiveEditorChange();

		assert.deepStrictEqual(harness.codeEditor.revealedRanges, []);
		assert.deepStrictEqual(harness.tracker.viewedUris, [trackedUri]);
		assert.deepStrictEqual(harness.operations, ["markViewed"]);
	});

	test("preview active editor skips reveal and markViewed", () => {
		const harness = createHarness();
		harness.editorService.activeEditor = createEditorInput(trackedUri, true);
		harness.tracker.entries.set(trackedUri.toString(), { status: "modified", hunks: [hunk(10, 2)], lastEditedAt: 100 });

		harness.editorService.fireActiveEditorChange();

		assert.deepStrictEqual(harness.codeEditor.revealedRanges, []);
		assert.deepStrictEqual(harness.tracker.viewedUris, []);
		assert.deepStrictEqual(harness.operations, []);
	});

	test("diff active editor skips reveal and markViewed", () => {
		const harness = createHarness();
		harness.editorService.activeTextEditorControl = new TestEditorControl(harness.operations, EditorType.IDiffEditor) as unknown as IDiffEditor;
		harness.tracker.entries.set(trackedUri.toString(), { status: "modified", hunks: [hunk(10, 2)], lastEditedAt: 100 });

		harness.editorService.fireActiveEditorChange();

		assert.deepStrictEqual(harness.codeEditor.revealedRanges, []);
		assert.deepStrictEqual(harness.tracker.viewedUris, []);
		assert.deepStrictEqual(harness.operations, []);
	});

	test("non-code active editor skips reveal", () => {
		const harness = createHarness();
		harness.editorService.activeTextEditorControl = { getEditorType: () => "test.output" } as unknown as IEditor;
		harness.tracker.entries.set(trackedUri.toString(), { status: "modified", hunks: [hunk(10, 2)], lastEditedAt: 100 });

		harness.editorService.fireActiveEditorChange();

		assert.deepStrictEqual(harness.codeEditor.revealedRanges, []);
		assert.deepStrictEqual(harness.tracker.viewedUris, []);
		assert.deepStrictEqual(harness.operations, []);
	});
});
