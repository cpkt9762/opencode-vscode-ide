/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// biome-ignore lint/style/useNodejsImportProtocol: browser unit tests load assert through the test runner bundle.
import assert from 'assert';
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
		handleMessage(this: SidebarHarness, message: IOpencodeMessage): Promise<void>;
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
});
