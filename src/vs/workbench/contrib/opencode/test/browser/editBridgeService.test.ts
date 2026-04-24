/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// biome-ignore lint/style/useNodejsImportProtocol: browser unit tests load assert through the test runner bundle.
import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { EditBridgeService } from '../../browser/editBridgeService.js';
import type { ApplyEditRequest, ApplyWriteRequest } from '../../common/editBridgeTypes.js';
import type { DiffEdit } from '../../common/editCodeServiceTypes.js';

type MockZoneWidget = {
	accept(): void | Promise<void>;
	reject(): void | Promise<void>;
	dispose(): void;
};

type MockZoneEntry = {
	editorId: string;
	edits: readonly DiffEdit[];
	options: { status?: 'streaming' | 'pending'; replaceExisting?: boolean } | undefined;
	widgets: MockZoneWidget[];
};

type EditBridgeServiceShape = Pick<EditBridgeService, 'applyEdit' | 'applyWrite' | 'applyPatch' | 'readBuffer' | 'acceptAll' | 'rejectAll' | 'pendingCount'>;

function getZoneEntry(zones: Map<string, MockZoneEntry>, zoneId: string): MockZoneEntry {
	const entry = zones.get(zoneId);
	assert.ok(entry);
	return entry;
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function createHarness() {
	const filePath = '/virtual/hello.txt';
	const originalContent = 'line 1\nline 2\nline 3';
	let modelId = 0;
	let editorId = 0;
	const editorByPath = new Map<string, { getId(): string; getModel(): { id: string; uri: URI; getLineCount(): number; getValue(): string; } }>();
	const createEditor = (resourcePath: string, content: string) => {
		const nextModelId = `model-${++modelId}`;
		const nextEditorId = `editor-${++editorId}`;
		const model = {
			id: nextModelId,
			uri: URI.file(resourcePath),
			getLineCount: () => Math.max(content.split('\n').length, 1),
			getValue: () => content,
		};
		const editor = {
			getId: () => nextEditorId,
			getModel: () => model,
		};
		editorByPath.set(resourcePath, editor);
		return editor;
	};
	const model = createEditor(filePath, originalContent).getModel();
	const writes: { resource: URI; content: string }[] = [];
	const warnings: string[] = [];
	const acceptedZoneIds: string[] = [];
	const rejectedZoneIds: string[] = [];
	const zones = new Map<string, MockZoneEntry>();
	let zoneId = 0;
	const editCodeService = {
		createDiffZone: (editorId: string, edits: readonly DiffEdit[], options?: { status?: 'streaming' | 'pending'; replaceExisting?: boolean }) => {
			const id = `diffzone-${zoneId++}`;
			zones.set(id, {
				editorId,
				edits,
				options,
				widgets: [{
					accept() {},
					reject() {},
					dispose() {},
				}],
			});
			return id;
		},
		acceptDiffZone: (id: string) => { acceptedZoneIds.push(id); },
		rejectDiffZone: (id: string) => { rejectedZoneIds.push(id); },
		disposeDiffZone() {},
		zones,
	};
	const service = new (EditBridgeService as unknown as { new (...args: unknown[]): EditBridgeServiceShape })(
		{ registerChannel() {} },
		{ info() {}, warn(message: string) { warnings.push(message); } },
		{ listCodeEditors: () => [...editorByPath.values()] },
		editCodeService,
		{ writeFile: async (resource: URI, buffer: { toString(): string }) => { writes.push({ resource, content: buffer.toString() }); } },
		{ openEditor: async (input: { resource: URI }) => editorByPath.get(input.resource.fsPath) ?? createEditor(input.resource.fsPath, '') },
	);

	return {
		service,
		filePath,
		model,
		writes,
		warnings,
		acceptedZoneIds,
		rejectedZoneIds,
		zones,
	};
	}

suite('EditBridgeService', () => {
	test('applyEdit creates a pending diff zone and stages the latest buffer content', async () => {
		const { service, filePath, model, zones } = createHarness();
		const req: ApplyEditRequest = {
			filePath,
			newContent: 'line 1\nLINE 2\nline 3',
			edits: [{ originalStartLine: 2, originalEndLine: 2, modifiedText: 'LINE 2' }],
		};

		const response = await service.applyEdit(req);
		const entry = getZoneEntry(zones, response.zoneId);

		assert.strictEqual(entry.editorId, 'editor-1,model-1');
		assert.deepStrictEqual(entry.edits, req.edits);
		assert.deepStrictEqual(entry.options, { status: 'pending', replaceExisting: false });
		assert.strictEqual(model.getValue(), 'line 1\nline 2\nline 3');
		assert.deepStrictEqual(await service.readBuffer(filePath), { dirty: true, content: req.newContent });
		assert.strictEqual(await service.pendingCount(), 1);
	});

	test('a second applyEdit on the same file preserves both zones and stages the newest content', async () => {
		const { service, filePath, zones } = createHarness();
		const first: ApplyEditRequest = {
			filePath,
			newContent: 'line 1\nLINE 2\nline 3',
			edits: [{ originalStartLine: 2, originalEndLine: 2, modifiedText: 'LINE 2' }],
		};
		const second: ApplyEditRequest = {
			filePath,
			newContent: 'line 1\nLINE 2\nLINE 3',
			edits: [{ originalStartLine: 3, originalEndLine: 3, modifiedText: 'LINE 3' }],
		};

		await service.applyEdit(first);
		await service.applyEdit(second);

		assert.strictEqual(zones.size, 2);
		assert.deepStrictEqual(await service.readBuffer(filePath), { dirty: true, content: second.newContent });
		assert.strictEqual(await service.pendingCount(), 2);
	});

	test('accepting a zone writes that staged content to disk and preserves newer pending content', async () => {
		const { service, filePath, writes, zones } = createHarness();
		const first: ApplyEditRequest = {
			filePath,
			newContent: 'line 1\nLINE 2\nline 3',
			edits: [{ originalStartLine: 2, originalEndLine: 2, modifiedText: 'LINE 2' }],
		};
		const second: ApplyEditRequest = {
			filePath,
			newContent: 'line 1\nLINE 2\nLINE 3',
			edits: [{ originalStartLine: 3, originalEndLine: 3, modifiedText: 'LINE 3' }],
		};

		const firstResponse = await service.applyEdit(first);
		await service.applyEdit(second);
		await Promise.resolve(getZoneEntry(zones, firstResponse.zoneId).widgets[0].accept());
		await settle();

		assert.deepStrictEqual(writes, [{ resource: URI.file(filePath), content: first.newContent }]);
		assert.deepStrictEqual(await service.readBuffer(filePath), { dirty: true, content: second.newContent });
		assert.strictEqual(await service.pendingCount(), 1);
	});

	test('rejecting the last pending zone clears the staged buffer without writing to disk', async () => {
		const { service, filePath, writes, zones } = createHarness();
		const req: ApplyEditRequest = {
			filePath,
			newContent: 'line 1\nLINE 2\nline 3',
			edits: [{ originalStartLine: 2, originalEndLine: 2, modifiedText: 'LINE 2' }],
		};

		const response = await service.applyEdit(req);
		await Promise.resolve(getZoneEntry(zones, response.zoneId).widgets[0].reject());
		await settle();

		assert.deepStrictEqual(writes, []);
		assert.deepStrictEqual(await service.readBuffer(filePath), { dirty: false });
		assert.strictEqual(await service.pendingCount(), 0);
	});

	test('applyWrite creates a single full-file replacement zone', async () => {
		const { service, filePath, zones } = createHarness();
		const req: ApplyWriteRequest = {
			filePath,
			newContent: 'replacement\ncontent\nblock',
		};

		const response = await service.applyWrite(req);
		const entry = getZoneEntry(zones, response.zoneId);

		assert.deepStrictEqual(entry.edits, [{
			originalStartLine: 1,
			originalEndLine: 3,
			modifiedText: req.newContent,
		}]);
		assert.deepStrictEqual(entry.options, { status: 'pending', replaceExisting: false });
		assert.deepStrictEqual(await service.readBuffer(filePath), { dirty: true, content: req.newContent });
	});

	test('applyPatch creates zones for add and update changes and skips unsupported kinds', async () => {
		const { service, warnings, zones } = createHarness();
		const response = await service.applyPatch({
			files: [
				{ filePath: '/virtual/hello.txt', type: 'update', newContent: 'line 1\nLINE 2\nline 3', diff: '@@ -2,1 +2,1 @@\n-line 2\n+LINE 2' },
				{ filePath: '/virtual/new.txt', type: 'add', newContent: 'brand new', diff: '@@ -0,0 +1,1 @@\n+brand new' },
				{ filePath: '/virtual/old.txt', type: 'delete', newContent: '', diff: '' },
				{ filePath: '/virtual/move.txt', type: 'move', newContent: 'moved', diff: '', movePath: '/virtual/moved.txt' },
			],
		});

		assert.strictEqual(response.zoneIds.length, 2);
		assert.strictEqual(zones.size, 2);
		assert.strictEqual(warnings.length, 2);
	});

	test('acceptAll accepts every pending zone exactly once and clears staged content', async () => {
		const { service, filePath, writes, acceptedZoneIds } = createHarness();
		const first: ApplyEditRequest = {
			filePath,
			newContent: 'line 1\nLINE 2\nline 3',
			edits: [{ originalStartLine: 2, originalEndLine: 2, modifiedText: 'LINE 2' }],
		};
		const second: ApplyEditRequest = {
			filePath,
			newContent: 'line 1\nLINE 2\nLINE 3',
			edits: [{ originalStartLine: 3, originalEndLine: 3, modifiedText: 'LINE 3' }],
		};

		await service.applyEdit(first);
		await service.applyEdit(second);
		await service.acceptAll();
		await settle();

		assert.deepStrictEqual(acceptedZoneIds, ['diffzone-0', 'diffzone-1']);
		assert.deepStrictEqual(writes, [
			{ resource: URI.file(filePath), content: first.newContent },
			{ resource: URI.file(filePath), content: second.newContent },
		]);
		assert.deepStrictEqual(await service.readBuffer(filePath), { dirty: false });
		assert.strictEqual(await service.pendingCount(), 0);
	});

	test('rejectAll rejects every pending zone and clears staged content without writing', async () => {
		const { service, filePath, writes, rejectedZoneIds } = createHarness();
		const first: ApplyEditRequest = {
			filePath,
			newContent: 'line 1\nLINE 2\nline 3',
			edits: [{ originalStartLine: 2, originalEndLine: 2, modifiedText: 'LINE 2' }],
		};
		const second: ApplyEditRequest = {
			filePath,
			newContent: 'line 1\nLINE 2\nLINE 3',
			edits: [{ originalStartLine: 3, originalEndLine: 3, modifiedText: 'LINE 3' }],
		};

		await service.applyEdit(first);
		await service.applyEdit(second);
		await service.rejectAll();
		await settle();

		assert.deepStrictEqual(rejectedZoneIds, ['diffzone-0', 'diffzone-1']);
		assert.deepStrictEqual(writes, []);
		assert.deepStrictEqual(await service.readBuffer(filePath), { dirty: false });
		assert.strictEqual(await service.pendingCount(), 0);
	});

	test('pendingCount tracks pending zones across apply and reject flows', async () => {
		const { service, filePath, zones } = createHarness();
		const first: ApplyEditRequest = {
			filePath,
			newContent: 'line 1\nLINE 2\nline 3',
			edits: [{ originalStartLine: 2, originalEndLine: 2, modifiedText: 'LINE 2' }],
		};
		const second: ApplyEditRequest = {
			filePath,
			newContent: 'line 1\nline 2\nLINE 3',
			edits: [{ originalStartLine: 3, originalEndLine: 3, modifiedText: 'LINE 3' }],
		};

		assert.strictEqual(await service.pendingCount(), 0);

		const firstResponse = await service.applyEdit(first);
		assert.strictEqual(await service.pendingCount(), 1);

		const secondResponse = await service.applyEdit(second);
		assert.strictEqual(await service.pendingCount(), 2);

		await Promise.resolve(getZoneEntry(zones, firstResponse.zoneId).widgets[0].reject());
		await settle();
		assert.strictEqual(await service.pendingCount(), 1);

		await Promise.resolve(getZoneEntry(zones, secondResponse.zoneId).widgets[0].reject());
		await settle();
		assert.strictEqual(await service.pendingCount(), 0);
	});
});
