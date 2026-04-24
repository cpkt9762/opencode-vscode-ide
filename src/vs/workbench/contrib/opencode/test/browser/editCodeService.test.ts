/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// biome-ignore lint/style/useNodejsImportProtocol: browser unit tests load assert through the test runner bundle.
import assert from 'assert';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { EditCodeService } from '../../browser/editCodeService.js';
import type { DiffEdit } from '../../common/editCodeServiceTypes.js';

function getZonesSize(service: EditCodeService): number {
	return (service as unknown as { zones: Map<string, unknown> }).zones.size;
}

function createHarness() {
	const lines = ['line 1', 'line 2', 'line 3'];
	let viewZoneId = 0;
	const model = {
		id: 'model-1',
		getVersionId: () => 1,
		getLineCount: () => lines.length,
		getValueInRange: (range: { startLineNumber: number; endLineNumber: number; startColumn: number; endColumn: number }) => {
			const value = lines.slice(range.startLineNumber - 1, range.endLineNumber).join('\n');
			return value.slice(range.startColumn - 1, range.endColumn - 1);
		},
		getLineMaxColumn: (lineNumber: number) => lines[lineNumber - 1].length + 1,
		pushEditOperations: () => null,
	};
	const editor = {
		getId: () => 'editor-1',
		getModel: () => model,
		onDidDispose: () => ({ dispose() {} }),
		onDidChangeModel: () => ({ dispose() {} }),
		getOption: (option: EditorOption) => option === EditorOption.fontInfo ? { fontFamily: 'monospace', fontSize: 12 } : 20,
		changeViewZones: (callback: (accessor: { addZone(viewZone: unknown): string; removeZone(id: string): void }) => void) => callback({
			addZone: () => `view-zone-${viewZoneId++}`,
			removeZone: () => {},
		}),
	};
	const codeEditorService = {
		listCodeEditors: () => [editor],
	};

	return {
		service: new EditCodeService(codeEditorService as unknown as ConstructorParameters<typeof EditCodeService>[0]),
	};
}

suite('EditCodeService', () => {
	test('default mode replaces existing zones for same editor', () => {
		const { service } = createHarness();
		const edits: DiffEdit[] = [{ originalStartLine: 2, originalEndLine: 2, modifiedText: 'line 2 changed' }];

		service.createDiffZone('editor-1', edits);
		service.createDiffZone('editor-1', edits);

		assert.strictEqual(getZonesSize(service), 1);
	});

	test('additive mode preserves existing zones for same editor', () => {
		const { service } = createHarness();
		const edits: DiffEdit[] = [{ originalStartLine: 2, originalEndLine: 2, modifiedText: 'line 2 changed' }];

		service.createDiffZone('editor-1', edits, { replaceExisting: false });
		service.createDiffZone('editor-1', edits, { replaceExisting: false });

		assert.strictEqual(getZonesSize(service), 2);
	});
});
