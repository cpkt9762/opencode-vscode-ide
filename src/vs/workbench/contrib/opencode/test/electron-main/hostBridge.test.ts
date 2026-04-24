/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// biome-ignore lint/style/useNodejsImportProtocol: electron-main unit tests use node builtins directly.
import assert from 'assert';
// biome-ignore lint/style/useNodejsImportProtocol: electron-main unit tests use node builtins directly.
import { request, type Server } from 'http';
import type { IChannel, IPCServer } from '../../../../../base/parts/ipc/common/ipc.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import type { ActiveWindowManager } from '../../../../../platform/windows/node/windowTracker.js';
import type {
	ApplyEditRequest,
	ApplyPatchRequest,
	ApplyWriteRequest,
	IEditBridgeService,
} from '../../common/editBridgeTypes.js';
import { HostBridgeService } from '../../electron-main/hostBridge.js';
import { stablePort } from '../../electron-main/spaProxy.js';

type ResponseData = {
	body: string;
	status: number;
	type: string;
};

function createChannel(service: Pick<IEditBridgeService, 'applyEdit' | 'applyWrite' | 'applyPatch' | 'readBuffer'>, calls: Array<{ command: string; arg: unknown }>): IChannel {
	return {
		call<T>(command: string, arg?: unknown) {
			const args = Array.isArray(arg) ? arg : arg === undefined ? [] : [arg];
			calls.push({ command, arg: args[0] });

			switch (command) {
				case 'applyEdit':
					return service.applyEdit(args[0] as ApplyEditRequest) as Promise<T>;
				case 'applyWrite':
					return service.applyWrite(args[0] as ApplyWriteRequest) as Promise<T>;
				case 'applyPatch':
					return service.applyPatch(args[0] as ApplyPatchRequest) as Promise<T>;
				case 'readBuffer':
					return service.readBuffer(args[0] as string) as Promise<T>;
				default:
					throw new Error(`Unknown command: ${command}`);
			}
		},
		listen() {
			throw new Error('listen not implemented');
		},
	};
}

function createIpcServer(service: Pick<IEditBridgeService, 'applyEdit' | 'applyWrite' | 'applyPatch' | 'readBuffer'>, calls: Array<{ command: string; arg: unknown }>) {
	return {
		getChannel() {
			return createChannel(service, calls);
		},
	} as unknown as IPCServer<string>;
}

function createActiveWindowManager() {
	return {
		getActiveClientId: async () => 'window:1',
	} as ActiveWindowManager;
}

function send(port: number, options: { body?: unknown; headers?: Record<string, string>; method: 'GET' | 'POST'; path: string }): Promise<ResponseData> {
	return new Promise((resolve, reject) => {
		const outgoing = request(
			{
				headers: options.headers,
				hostname: '127.0.0.1',
				method: options.method,
				path: options.path,
				port,
			},
			response => {
				let body = '';
				response.on('data', chunk => body += chunk.toString());
				response.on('end', () => resolve({
					body,
					status: response.statusCode ?? 0,
					type: response.headers['content-type'] ?? '',
				}));
			},
		);

		outgoing.on('error', reject);
		if (options.body !== undefined) {
			outgoing.write(JSON.stringify(options.body));
		}
		outgoing.end();
	});
}

function getServer(service: HostBridgeService) {
	return (service as unknown as { server?: Server }).server;
}

suite('HostBridgeService', () => {
	test('health endpoint responds with ok', async () => {
		const calls: Array<{ command: string; arg: unknown }> = [];
		const service = new HostBridgeService(new NullLogService());
		await service.initialize(
			createIpcServer({
				applyEdit: async () => ({ zoneId: 'unused' }),
				applyPatch: async () => ({ zoneIds: [] }),
				applyWrite: async () => ({ zoneId: 'unused' }),
				readBuffer: async () => ({ dirty: false }),
			}, calls),
			createActiveWindowManager(),
		);

		try {
			const response = await send(service.getPort(), { method: 'GET', path: '/health' });
			assert.strictEqual(response.status, 200);
			assert.deepStrictEqual(JSON.parse(response.body), { ok: true });
			assert.match(response.type, /application\/json/);
			assert.deepStrictEqual(calls, []);
		} finally {
			await service.stop();
		}
	});

	test('apply-edit forwards request and returns not implemented error from bridge', async () => {
		const calls: Array<{ command: string; arg: unknown }> = [];
		const service = new HostBridgeService(new NullLogService());
		const body = {
			edits: [{ modifiedText: 'LINE2', originalEndLine: 2, originalStartLine: 2 }],
			filePath: '/tmp/example.txt',
			newContent: 'line1\nLINE2\nline3\n',
		};

		await service.initialize(
			createIpcServer({
				applyEdit: async () => {
					throw new Error('EditBridgeService not implemented');
				},
				applyPatch: async () => ({ zoneIds: [] }),
				applyWrite: async () => ({ zoneId: 'unused' }),
				readBuffer: async () => ({ dirty: false }),
			}, calls),
			createActiveWindowManager(),
		);

		try {
			const response = await send(service.getPort(), {
				body,
				headers: { 'content-type': 'application/json' },
				method: 'POST',
				path: '/apply-edit',
			});

			assert.strictEqual(response.status, 501);
			assert.deepStrictEqual(JSON.parse(response.body), { error: 'EditBridgeService not implemented' });
			assert.deepStrictEqual(calls, [{ arg: body, command: 'applyEdit' }]);
		} finally {
			await service.stop();
		}
	});

	test('binds to 127.0.0.1 explicitly', async () => {
		const service = new HostBridgeService(new NullLogService());
		await service.initialize(
			createIpcServer({
				applyEdit: async () => ({ zoneId: 'unused' }),
				applyPatch: async () => ({ zoneIds: [] }),
				applyWrite: async () => ({ zoneId: 'unused' }),
				readBuffer: async () => ({ dirty: false }),
			}, []),
			createActiveWindowManager(),
		);

		try {
			const address = getServer(service)?.address();
			assert.ok(address && typeof address === 'object');
			assert.strictEqual(address.address, '127.0.0.1');
		} finally {
			await service.stop();
		}
	});

	test('stablePort is deterministic for host bridge backend id', () => {
		const port = stablePort('opencode-edit-bridge');
		assert.strictEqual(stablePort('opencode-edit-bridge'), port);
		assert.ok(port >= 49152 && port <= 65535);
	});

	test('rejects requests with non-loopback host header', async () => {
		const service = new HostBridgeService(new NullLogService());
		await service.initialize(
			createIpcServer({
				applyEdit: async () => ({ zoneId: 'unused' }),
				applyPatch: async () => ({ zoneIds: [] }),
				applyWrite: async () => ({ zoneId: 'unused' }),
				readBuffer: async () => ({ dirty: false }),
			}, []),
			createActiveWindowManager(),
		);

		try {
			const port = service.getPort();
			const response = await send(port, {
				headers: { host: `evil.com:${port}` },
				method: 'GET',
				path: '/health',
			});

			assert.strictEqual(response.status, 403);
		} finally {
			await service.stop();
		}
	});
});
