/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// biome-ignore lint/style/useNodejsImportProtocol: browser unit tests load assert through the test runner bundle.
import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import type { IOpencodeMessage } from '../../browser/messageBridge.js';
import { OpencodeSidebarPane } from '../../browser/sidebarPane.js';
import type { DiffEdit } from '../../common/editCodeServiceTypes.js';

type SidebarHarness = {
	messageBridge: { send(message: IOpencodeMessage): void };
	opencodeEditorService: { sendLLMRequest(prompt: string): Promise<string> };
	editCodeService: { createDiffZone(editorId: string, edits: readonly DiffEdit[]): string };
};

suite('OpencodeSidebarPane', () => {
	const methods = OpencodeSidebarPane.prototype as unknown as {
		handleMessage(this: unknown, message: IOpencodeMessage): Promise<void>;
		getDropPromptText(this: unknown, event: DragEvent): Promise<string | undefined>;
		startProxy(this: unknown, workspaceDir: string): Promise<string>;
		toPromptPath(this: unknown, resource: URI): string | undefined;
	};

	test('handles apply-diff-edit by creating a diff zone and replying with the zone id', async () => {
		const createCalls: { editorId: string; edits: readonly DiffEdit[] }[] = [];
		const sent: IOpencodeMessage[] = [];
		const edits: DiffEdit[] = [
			{
				originalStartLine: 3,
				originalEndLine: 4,
				modifiedText: 'const value = 1;',
			},
		];
		const harness: SidebarHarness = {
			messageBridge: { send: message => sent.push(message) },
			opencodeEditorService: {
				sendLLMRequest: async () => {
					throw new Error('llm should not be called');
				},
			},
			editCodeService: {
				createDiffZone: (editorId, incomingEdits) => {
					createCalls.push({ editorId, edits: incomingEdits });
					return 'zone-1';
				},
			},
		};

		await methods.handleMessage.call(harness, {
			type: 'apply-diff-edit',
			id: 'req-1',
			payload: { editorId: 'editor-1', edits },
		});

		assert.deepStrictEqual(createCalls, [{ editorId: 'editor-1', edits }]);
		assert.deepStrictEqual(sent, [{ type: 'diff-zone-created', id: 'req-1', payload: { zoneId: 'zone-1' } }]);
	});

	test('handles llm-request by forwarding only the LLM response payload', async () => {
		const prompts: string[] = [];
		const sent: IOpencodeMessage[] = [];
		const harness: SidebarHarness = {
			messageBridge: { send: message => sent.push(message) },
			opencodeEditorService: {
				sendLLMRequest: async prompt => {
					prompts.push(prompt);
					return `stub:${prompt}`;
				},
			},
			editCodeService: {
				createDiffZone: () => {
					throw new Error('diff zone should not be created');
				},
			},
		};

		await methods.handleMessage.call(harness, {
			type: 'llm-request',
			id: 'req-2',
			payload: { prompt: 'hello world' },
		});

		assert.deepStrictEqual(prompts, ['hello world']);
		assert.deepStrictEqual(sent, [{ type: 'llm-response', id: 'req-2', payload: { response: 'stub:hello world' } }]);
	});

	test('persists and clears session ids from iframe messages', async () => {
		const storageService = new TestStorageService();

		await methods.handleMessage.call({ storageService } as unknown, {
			type: 'opencode-web.session-changed',
			sessionId: 'session-123',
		} as IOpencodeMessage);

		assert.strictEqual(storageService.get('opencode.lastSessionId', StorageScope.WORKSPACE), 'session-123');

		await methods.handleMessage.call({ storageService } as unknown, {
			type: 'opencode-web.session-changed',
			sessionId: '',
		} as IOpencodeMessage);

		assert.strictEqual(storageService.get('opencode.lastSessionId', StorageScope.WORKSPACE), undefined);
	});

	test('appends stored session id to proxy url', async () => {
		const storageService = new TestStorageService();
		storageService.store('opencode.lastSessionId', 'session value', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const starts: { dist: string }[] = [];

		const url = await methods.startProxy.call({
			spaProxyService: {
				async start(options: { dist: string }) {
					starts.push(options);
					return { port: 4096 };
				},
				async url() {
					return 'http://127.0.0.1:4096/workspace';
				},
			},
			storageService,
		}, '/tmp/workspace');

		assert.strictEqual(url, 'http://127.0.0.1:4096/workspace/session/session%20value');
		assert.strictEqual(starts.length, 1);
		assert.ok(starts[0].dist.endsWith('vs/workbench/contrib/opencode/media/spa'));
	});

	test('builds prompt references from dropped workspace files', async () => {
		const workspace = URI.file('/workspace');
		const resource = URI.file('/workspace/src/app.ts');
		const text = await methods.getDropPromptText.call({
			contextService: {
				getWorkspaceFolder() {
					return { uri: workspace };
				},
			},
			instantiationService: {
				async invokeFunction() {
					return [{ resource }];
				},
			},
			toPromptPath: methods.toPromptPath,
		}, {
			dataTransfer: {
				getData() {
					return '';
				},
			},
		} as unknown as DragEvent);

		assert.strictEqual(text, '@src/app.ts');
	});
});
