/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import type { IOpencodeSessionEvent } from './opencodeSessionsTypes.js';

const eventTypes = new Set<IOpencodeSessionEvent['type']>([
	'created',
	'updated',
	'deleted',
	'idle',
	'status',
]);

const backendEventTypes = new Map<string, IOpencodeSessionEvent['type']>([
	['session.created', 'created'],
	['session.updated', 'updated'],
	['session.deleted', 'deleted'],
	['session.idle', 'idle'],
	['session.status', 'status'],
]);

type SSEField = {
	readonly field: string;
	readonly value: string;
};

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSSEField(line: string): SSEField | undefined {
	if (!line || line.startsWith(':')) {
		return undefined;
	}

	const index = line.indexOf(':');
	if (index === -1) {
		return { field: line, value: '' };
	}

	const value = line.slice(index + 1);
	return {
		field: line.slice(0, index),
		value: value.startsWith(' ') ? value.slice(1) : value,
	};
}

function normalizeType(type: unknown): IOpencodeSessionEvent['type'] | undefined {
	if (typeof type !== 'string') {
		return undefined;
	}

	if (eventTypes.has(type as IOpencodeSessionEvent['type'])) {
		return type as IOpencodeSessionEvent['type'];
	}

	return backendEventTypes.get(type);
}

function parseSSEData(value: string): IOpencodeSessionEvent | undefined {
	let input: unknown;
	try {
		input = JSON.parse(value);
	} catch {
		return undefined;
	}

	if (!record(input)) {
		return undefined;
	}

	const type = normalizeType(input.type);
	if (!type) {
		return undefined;
	}

	return {
		...(record(input.properties) ? input.properties : input),
		type,
	} as IOpencodeSessionEvent;
}

export function parseSSELine(line: string): IOpencodeSessionEvent | undefined {
	const parsed = parseSSEField(line);
	if (parsed?.field !== 'data') {
		return undefined;
	}

	return parseSSEData(parsed.value);
}

function parseSSEMessage(message: string): IOpencodeSessionEvent | undefined {
	const data = message
		.split('\n')
		.map(parseSSEField)
		.filter((field): field is SSEField => field?.field === 'data')
		.map(field => field.value);

	if (!data.length) {
		return undefined;
	}

	return parseSSEData(data.join('\n'));
}

export async function* createSSEStreamReader(stream: ReadableStream<Uint8Array>): AsyncIterable<IOpencodeSessionEvent> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	try {
		while (true) {
			const result = await reader.read();
			if (result.done) {
				return;
			}

			buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

			while (buffer.includes('\n\n')) {
				const index = buffer.indexOf('\n\n');
				const event = parseSSEMessage(buffer.slice(0, index));
				buffer = buffer.slice(index + 2);

				if (event) {
					yield event;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}
