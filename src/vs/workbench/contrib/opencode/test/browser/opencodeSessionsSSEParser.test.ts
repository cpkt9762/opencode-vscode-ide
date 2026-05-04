/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// biome-ignore lint/style/useNodejsImportProtocol: browser unit tests load assert through the test runner bundle.
import * as assert from 'assert';
import { createSSEStreamReader, parseSSELine } from '../../common/opencodeSessionsSSEParser.js';

const session = {
	id: 'ses_1',
	title: 'Session 1',
	time: { created: 1, updated: 2 },
};

function streamFromParts(parts: string[]) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			parts.map(part => controller.enqueue(new TextEncoder().encode(part)));
			controller.close();
		},
	});
}

suite('SSEParser', () => {
	test('well-formed data event yields parsed object', () => {
		assert.deepStrictEqual(parseSSELine(`data: ${JSON.stringify({ type: 'created', session })}`), { type: 'created', session });
	});

	test('malformed JSON returns undefined', () => {
		assert.strictEqual(parseSSELine('data: invalid'), undefined);
	});

	test('unknown event type returns undefined', () => {
		assert.strictEqual(parseSSELine(`data: ${JSON.stringify({ type: 'server.connected' })}`), undefined);
	});

	test('comment lines are skipped', () => {
		assert.strictEqual(parseSSELine(': heartbeat'), undefined);
	});

	test('multi-line data fields are concatenated correctly', async () => {
		const events = [];
		const stream = streamFromParts([
			'data: {"type":"status",\n',
			'data: "sessionID":"ses_1",\n',
			'data: "status":"idle"}\n\n',
		]);

		for await (const event of createSSEStreamReader(stream)) {
			events.push(event);
		}

		assert.deepStrictEqual(events, [{ type: 'status', sessionID: 'ses_1', status: 'idle' }]);
	});

	test('SSEStreamReader yields events in order from synthetic stream', async () => {
		const events = [];
		const stream = streamFromParts([
			`data: ${JSON.stringify({ type: 'created', session })}\n\n`,
			`data: ${JSON.stringify({ type: 'updated', session: { ...session, title: 'Session 1 renamed' } })}\n`,
			'\n: heartbeat\n\n',
			`data: ${JSON.stringify({ type: 'deleted', sessionID: 'ses_1' })}\n\n`,
		]);

		for await (const event of createSSEStreamReader(stream)) {
			events.push(event);
		}

		assert.deepStrictEqual(events, [
			{ type: 'created', session },
			{ type: 'updated', session: { ...session, title: 'Session 1 renamed' } },
			{ type: 'deleted', sessionID: 'ses_1' },
		]);
	});
});
