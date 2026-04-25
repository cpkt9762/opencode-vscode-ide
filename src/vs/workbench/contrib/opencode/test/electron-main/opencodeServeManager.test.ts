/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// biome-ignore lint/style/useNodejsImportProtocol: electron-main unit tests use node builtins directly.
import * as assert from 'assert';
// biome-ignore lint/style/useNodejsImportProtocol: electron-main unit tests use node builtins directly.
import type { ChildProcess, SpawnOptions } from 'child_process';
// biome-ignore lint/style/useNodejsImportProtocol: electron-main unit tests use node builtins directly.
import { EventEmitter } from 'events';
// biome-ignore lint/style/useNodejsImportProtocol: electron-main unit tests use node builtins directly.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: electron-main unit tests use node builtins directly.
import { createServer, type Server } from 'http';
// biome-ignore lint/style/useNodejsImportProtocol: electron-main unit tests use node builtins directly.
import { tmpdir } from 'os';
// biome-ignore lint/style/useNodejsImportProtocol: electron-main unit tests use node builtins directly.
import { join } from 'path';
import { OpencodeServeManager } from '../../electron-main/opencodeServeManager.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';

type MockBackend = { port: number; close: () => Promise<void>; getRequests: () => number };
type HealthResult = { body?: unknown; delay?: number; healthy?: boolean; status?: number };
type MockBackendOptions = {
	delay?: number;
	healthy?: boolean;
	onHealth?: (request: number, authorization: string | undefined) => HealthResult;
	password?: string;
	status?: number;
};
type FakeChildProcess = EventEmitter & {
	exitCode: number | null;
	killSignals: (NodeJS.Signals | undefined)[];
	kill(signal?: NodeJS.Signals | number): boolean;
	pid: number;
	signalCode: NodeJS.Signals | null;
	stderr: EventEmitter;
	stdout: EventEmitter;
	simulateExit(code: number | null, signal: NodeJS.Signals | null): void;
};
type ManagerInternals = {
	findBinaryPath(): string | undefined;
	isHealthy(url: string, password: string | undefined): Promise<boolean>;
	waitForHealthy(url: string, deadline: number, password: string | undefined): Promise<void>;
};

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function mockBackend(opts: MockBackendOptions = {}): Promise<MockBackend> {
	let requests = 0;
	const server = createServer((request, response) => {
		if (request.url !== '/global/health') {
			response.writeHead(404);
			response.end();
			return;
		}

		requests++;
		const result = opts.onHealth?.(requests, request.headers.authorization) ?? {};
		const reply = () => {
			if (opts.password) {
				const expected = `Basic ${Buffer.from(`opencode:${opts.password}`).toString('base64')}`;
				if (request.headers.authorization !== expected) {
					response.writeHead(401);
					response.end();
					return;
				}
			}

			const status = result.status ?? opts.status ?? 200;
			if (status === 401) {
				response.writeHead(401);
				response.end();
				return;
			}

			response.writeHead(status, { 'content-type': 'application/json' });
			response.end(JSON.stringify(result.body ?? { healthy: result.healthy ?? opts.healthy ?? true, version: '1.3.0' }));
		};

		const delay = result.delay ?? opts.delay ?? 0;
		if (delay > 0) {
			setTimeout(reply, delay);
			return;
		}

		reply();
	});

	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (typeof address !== 'object' || !address) {
		throw new Error('mockBackend did not bind to a port');
	}

	return {
		port: address.port,
		close: () => closeServer(server),
		getRequests: () => requests,
	};
}

function fakeSpawn(opts: { exitOnSigterm?: boolean } = {}) {
	const calls: { args: readonly string[]; command: string; options: SpawnOptions }[] = [];
	const process = new EventEmitter() as FakeChildProcess;
	process.stdout = new EventEmitter();
	process.stderr = new EventEmitter();
	process.killSignals = [];
	process.pid = 99_999;
	process.exitCode = null;
	process.signalCode = null;
	process.kill = signal => {
		const normalizedSignal = typeof signal === 'string' ? signal : undefined;
		process.killSignals.push(normalizedSignal);
		if (normalizedSignal === 'SIGKILL' || (normalizedSignal === 'SIGTERM' && opts.exitOnSigterm !== false)) {
			setTimeout(() => process.simulateExit(null, normalizedSignal), 0);
		}
		return true;
	};
	process.simulateExit = (code, signal) => {
		process.exitCode = code;
		process.signalCode = signal;
		process.emit('exit', code, signal);
	};

	return {
		calls,
		fn: (command: string, args: readonly string[], options: SpawnOptions) => {
			calls.push({ command, args, options });
			return process;
		},
		process,
	};
}

class TestableOpencodeServeManager extends OpencodeServeManager {
	spawnCalls: { command: string; args: readonly string[]; options: SpawnOptions }[] = [];
	nextProcess: ChildProcess | FakeChildProcess | undefined;
	protected override spawnProcess(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
		this.spawnCalls.push({ command, args, options });
		if (!this.nextProcess) {
			throw new Error('test forgot to set nextProcess');
		}

		return this.nextProcess as unknown as ChildProcess;
	}
	protected override async killStaleServer(_port: number): Promise<void> {
		// No-op in tests: real lsof/netstat lookup would find the mock HTTP backend in this process.
	}
	protected override async findProcessOnPort(_port: number): Promise<number | undefined> {
		return undefined;
	}
	get testState() { return this._testState; }
	get testWeStarted() { return this._testWeStarted; }
}

class TestLogService extends NullLogService {
	readonly warnings: unknown[][] = [];
	override warn(message: string, ...args: unknown[]): void {
		this.warnings.push([message, ...args]);
	}
}

function configuration(values: Record<string, unknown> = {}) {
	return new TestConfigurationService({
		'opencode.autoStart': false,
		'opencode.binaryPath': process.execPath,
		...values,
	});
}

function internals(manager: TestableOpencodeServeManager) {
	return manager as unknown as ManagerInternals;
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCondition(predicate: () => boolean, message: string, timeout = 3_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}

		await sleep(10);
	}

	throw new Error(message);
}

async function startSpawned(manager: TestableOpencodeServeManager, process: FakeChildProcess, url: string): Promise<string> {
	const task = manager.start();
	await waitForCondition(() => manager.spawnCalls.length > 0 && manager.testState === 'starting', 'manager did not spawn');
	await sleep(0);
	process.stdout.emit('data', `opencode listening at ${url}\n`);
	return task;
}

function createTempDir(tempDirs: string[]) {
	const dir = mkdtempSync(join(tmpdir(), 'opencode-serve-manager-'));
	tempDirs.push(dir);
	return dir;
}

function writeExecutable(dir: string, name = 'opencode') {
	const file = join(dir, name);
	writeFileSync(file, '#!/bin/sh\nexit 0\n');
	chmodSync(file, 0o755);
	return file;
}

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (typeof address !== 'object' || !address) {
		throw new Error('unusedPort did not bind to a port');
	}

	await closeServer(server);
	return address.port;
}

suite('OpencodeServeManager / lifecycle', () => {
	let backend: MockBackend | undefined;
	let manager: TestableOpencodeServeManager | undefined;

	teardown(async () => {
		if (manager) {
			await manager.stop().catch(() => undefined);
			manager.dispose();
			manager = undefined;
		}
		if (backend) {
			await backend.close();
			backend = undefined;
		}
	});

	test('start() returns immediately if backend is already healthy (orphan adoption)', async () => {
		backend = await mockBackend({ healthy: true });
		manager = new TestableOpencodeServeManager(configuration({
			'opencode.autoStart': false,
			'opencode.port': backend.port,
		}), new NullLogService());

		const url = await manager.start();

		assert.strictEqual(manager.testState, 'running');
		assert.strictEqual(manager.testWeStarted, false);
		assert.strictEqual(manager.spawnCalls.length, 0);
		assert.match(url, /127\.0\.0\.1/);
		assert.strictEqual(manager.backendUrl, url);
	});

	test('start() spawns when no healthy orphan is present', async () => {
		backend = await mockBackend({ onHealth: request => request === 1 ? { healthy: false } : { healthy: true } });
		const spawn = fakeSpawn();
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.port': backend.port }), new NullLogService());
		manager.nextProcess = spawn.process;

		const url = await startSpawned(manager, spawn.process, `http://127.0.0.1:${backend.port}`);

		assert.strictEqual(url, `http://127.0.0.1:${backend.port}`);
		assert.strictEqual(manager.spawnCalls.length, 1);
		assert.deepStrictEqual(manager.spawnCalls[0].args, ['serve', '--hostname', '127.0.0.1', '--port', String(backend.port)]);
		assert.strictEqual(manager.spawnCalls[0].options.env?.OPENCODE_SERVER_PASSWORD, manager.getPassword());
		assert.deepStrictEqual(manager.spawnCalls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
		assert.strictEqual(spawn.calls.length, 0);
	});

	test('concurrent start() calls return the same promise (no double spawn)', async () => {
		backend = await mockBackend({ onHealth: request => request === 1 ? { delay: 150, healthy: false } : { healthy: true } });
		const spawn = fakeSpawn();
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.port': backend.port }), new NullLogService());
		manager.nextProcess = spawn.process;

		const first = manager.start();
		const second = manager.start();
		assert.strictEqual(first, second);
		await waitForCondition(() => manager?.spawnCalls.length === 1 && manager.testState === 'starting', 'manager did not enter starting');
		await sleep(0);
		spawn.process.stdout.emit('data', `ready at http://127.0.0.1:${backend.port}\n`);

		assert.strictEqual(await first, await second);
		assert.strictEqual(manager.spawnCalls.length, 1);
	});

	test('start() uses configured password from opencode.serverPassword', async () => {
		backend = await mockBackend({ onHealth: request => request === 1 ? { healthy: false } : { healthy: true } });
		const spawn = fakeSpawn();
		manager = new TestableOpencodeServeManager(configuration({
			'opencode.port': backend.port,
			'opencode.serverPassword': 'cfg-pwd',
		}), new NullLogService());
		manager.nextProcess = spawn.process;

		await startSpawned(manager, spawn.process, `http://127.0.0.1:${backend.port}`);

		assert.strictEqual(manager.getPassword(), 'cfg-pwd');
		assert.strictEqual(manager.spawnCalls[0].options.env?.OPENCODE_SERVER_PASSWORD, 'cfg-pwd');
	});

	test('start() generates random password if not configured', async () => {
		backend = await mockBackend({ onHealth: request => request === 1 ? { healthy: false } : { healthy: true } });
		const spawn = fakeSpawn();
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.port': backend.port }), new NullLogService());
		manager.nextProcess = spawn.process;

		await startSpawned(manager, spawn.process, `http://127.0.0.1:${backend.port}`);

		assert.match(manager.getPassword() ?? '', /^[0-9a-f]{32}$/);
		assert.strictEqual(manager.getPassword(), manager.spawnCalls[0].options.env?.OPENCODE_SERVER_PASSWORD);
		assert.strictEqual(manager.getPassword(), manager.getPassword());
	});

	test('start() respects opencode.port configuration', async () => {
		backend = await mockBackend({ onHealth: request => request === 1 ? { healthy: false } : { healthy: true } });
		const spawn = fakeSpawn();
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.port': backend.port }), new NullLogService());
		manager.nextProcess = spawn.process;

		await startSpawned(manager, spawn.process, `http://127.0.0.1:${backend.port}`);

		assert.deepStrictEqual(manager.spawnCalls[0].args.slice(2, 5), ['127.0.0.1', '--port', String(backend.port)]);
		assert.ok(manager.spawnCalls[0].args.includes(String(backend.port)));
	});

	test('start() falls back to default port 5888 when config is invalid', async function () {
		this.timeout(5_000);
		const spawn = fakeSpawn({ exitOnSigterm: false });
		manager = new TestableOpencodeServeManager(configuration({
			'opencode.autoStart': false,
			'opencode.port': 65_999,
		}), new NullLogService());
		manager.nextProcess = spawn.process;
		const isHealthy = internals(manager).isHealthy.bind(manager);
		internals(manager).isHealthy = async (url, password) => url === 'http://127.0.0.1:5888'
			? false
			: isHealthy(url, password);

		const task = manager.start();
		await waitForCondition(() => manager?.spawnCalls.length === 1 && manager.testState === 'starting', 'manager did not spawn');
		await sleep(0);
		spawn.process.simulateExit(1, null);

		await assert.rejects(task, /exited before ready/);
		assert.ok(manager.spawnCalls[0].args.includes('5888'));
	});

	test('stop() sends SIGTERM, waits 2s grace, then SIGKILL', async function () {
		this.timeout(5_000);
		backend = await mockBackend({ onHealth: request => request === 1 ? { healthy: false } : { healthy: true } });
		const spawn = fakeSpawn({ exitOnSigterm: false });
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.port': backend.port }), new NullLogService());
		manager.nextProcess = spawn.process;
		await startSpawned(manager, spawn.process, `http://127.0.0.1:${backend.port}`);

		const started = Date.now();
		await manager.stop();
		const elapsed = Date.now() - started;

		assert.deepStrictEqual(spawn.process.killSignals, ['SIGTERM', 'SIGKILL']);
		assert.ok(elapsed >= 1_900, `expected stop() to wait at least 1900ms, got ${elapsed}`);
		assert.ok(elapsed < 3_200, `expected stop() to finish before 3200ms, got ${elapsed}`);
	});

	test('stop() returns immediately if process already exited', async () => {
		backend = await mockBackend({ onHealth: request => request === 1 ? { healthy: false } : { healthy: true } });
		const spawn = fakeSpawn();
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.port': backend.port }), new NullLogService());
		manager.nextProcess = spawn.process;
		await startSpawned(manager, spawn.process, `http://127.0.0.1:${backend.port}`);

		spawn.process.simulateExit(0, null);
		await manager.stop();

		assert.deepStrictEqual(spawn.process.killSignals, []);
		assert.strictEqual(manager.testState, 'stopped');
	});

	test('start() normalizes localhost READY_URL_PATTERN matches to 127.0.0.1', async () => {
		backend = await mockBackend({ onHealth: request => request === 1 ? { healthy: false } : { healthy: true } });
		const spawn = fakeSpawn();
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.port': backend.port }), new NullLogService());
		manager.nextProcess = spawn.process;

		const url = await startSpawned(manager, spawn.process, `http://localhost:${backend.port}`);

		assert.strictEqual(url, `http://127.0.0.1:${backend.port}`);
		assert.strictEqual(manager.backendUrl, `http://127.0.0.1:${backend.port}`);
	});
});

suite('OpencodeServeManager / health checks', () => {
	let backend: MockBackend | undefined;
	let manager: TestableOpencodeServeManager | undefined;

	teardown(async () => {
		if (manager) {
			await manager.stop().catch(() => undefined);
			manager.dispose();
			manager = undefined;
		}
		if (backend) {
			await backend.close();
			backend = undefined;
		}
	});

	test('isHealthy returns true on HTTP 200 with {healthy:true}', async () => {
		backend = await mockBackend({ healthy: true });
		manager = new TestableOpencodeServeManager(configuration(), new NullLogService());

		assert.strictEqual(await internals(manager).isHealthy(`http://127.0.0.1:${backend.port}`, undefined), true);
	});

	test('isHealthy returns false on HTTP 401 (auth required but wrong credentials)', async () => {
		backend = await mockBackend({ status: 401 });
		manager = new TestableOpencodeServeManager(configuration(), new NullLogService());

		assert.strictEqual(await internals(manager).isHealthy(`http://127.0.0.1:${backend.port}`, undefined), false);
	});

	test('isHealthy returns false on HTTP 500', async () => {
		backend = await mockBackend({ status: 500 });
		manager = new TestableOpencodeServeManager(configuration(), new NullLogService());

		assert.strictEqual(await internals(manager).isHealthy(`http://127.0.0.1:${backend.port}`, undefined), false);
	});

	test('isHealthy returns false on connection refused (ECONNREFUSED)', async () => {
		manager = new TestableOpencodeServeManager(configuration(), new NullLogService());

		assert.strictEqual(await internals(manager).isHealthy(`http://127.0.0.1:${await unusedPort()}`, undefined), false);
	});

	test('isHealthy times out at HEALTH_TIMEOUT (2s)', async function () {
		this.timeout(5_000);
		const server = createServer(() => undefined);
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (typeof address !== 'object' || !address) {
			throw new Error('timeout server did not bind to a port');
		}
		manager = new TestableOpencodeServeManager(configuration(), new NullLogService());

		try {
			const started = Date.now();
			assert.strictEqual(await internals(manager).isHealthy(`http://127.0.0.1:${address.port}`, undefined), false);
			const elapsed = Date.now() - started;
			assert.ok(elapsed >= 1_900, `expected health timeout after at least 1900ms, got ${elapsed}`);
			assert.ok(elapsed < 3_200, `expected health timeout before 3200ms, got ${elapsed}`);
		} finally {
			await closeServer(server);
		}
	});

	test('waitForHealthy retries every 250ms within the deadline', async () => {
		backend = await mockBackend({ onHealth: request => request < 3 ? { status: 500 } : { healthy: true } });
		manager = new TestableOpencodeServeManager(configuration(), new NullLogService());

		const started = Date.now();
		await internals(manager).waitForHealthy(`http://127.0.0.1:${backend.port}`, Date.now() + 5_000, undefined);

		assert.strictEqual(backend.getRequests(), 3);
		assert.ok(Date.now() - started >= 450);
	});

	test('waitForHealthy throws when the deadline expires if never healthy', async () => {
		backend = await mockBackend({ status: 500 });
		manager = new TestableOpencodeServeManager(configuration(), new NullLogService());

		await assert.rejects(
			internals(manager).waitForHealthy(`http://127.0.0.1:${backend.port}`, Date.now() + 300, undefined),
			/Timed out waiting for http:\/\/127\.0\.0\.1:\d+\/global\/health to report healthy=true\./,
		);
	});
});

suite('OpencodeServeManager / state machine', () => {
	let backend: MockBackend | undefined;
	let manager: TestableOpencodeServeManager | undefined;

	teardown(async () => {
		if (manager) {
			await manager.stop().catch(() => undefined);
			manager.dispose();
			manager = undefined;
		}
		if (backend) {
			await backend.close();
			backend = undefined;
		}
	});

	test('initial state is "stopped"', () => {
		manager = new TestableOpencodeServeManager(configuration(), new NullLogService());

		assert.strictEqual(manager.testState, 'stopped');
		assert.strictEqual(manager.backendUrl, undefined);
	});

	test('state transitions are reflected in testState getter (stopped → starting → running)', async () => {
		backend = await mockBackend({ onHealth: request => request === 1 ? { healthy: false } : { healthy: true } });
		const spawn = fakeSpawn();
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.port': backend.port }), new NullLogService());
		manager.nextProcess = spawn.process;

		assert.strictEqual(manager.testState, 'stopped');
		const task = manager.start();
		await waitForCondition(() => manager?.testState === 'starting', 'manager did not enter starting');
		assert.strictEqual(manager.testState, 'starting');
		await sleep(0);
		spawn.process.stdout.emit('data', `ready http://127.0.0.1:${backend.port}\n`);
		await task;

		assert.strictEqual(manager.testState, 'running');
	});

	test('stop() transitions running → stopped', async () => {
		backend = await mockBackend({ onHealth: request => request === 1 ? { healthy: false } : { healthy: true } });
		const spawn = fakeSpawn();
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.port': backend.port }), new NullLogService());
		manager.nextProcess = spawn.process;
		await startSpawned(manager, spawn.process, `http://127.0.0.1:${backend.port}`);

		await manager.stop();

		assert.strictEqual(manager.testState, 'stopped');
		assert.strictEqual(manager.backendUrl, undefined);
		assert.strictEqual(manager.testWeStarted, false);
	});

	test('crash transitions running → stopped and clears backendUrl', async () => {
		backend = await mockBackend({ onHealth: request => request === 1 ? { healthy: false } : { healthy: true } });
		const spawn = fakeSpawn();
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.port': backend.port }), new NullLogService());
		manager.nextProcess = spawn.process;
		await startSpawned(manager, spawn.process, `http://127.0.0.1:${backend.port}`);

		spawn.process.simulateExit(1, null);

		assert.strictEqual(manager.testState, 'stopped');
		assert.strictEqual(manager.backendUrl, undefined);
	});
});

suite('OpencodeServeManager / respawn', () => {
	let backend: MockBackend | undefined;
	let manager: TestableOpencodeServeManager | undefined;

	teardown(async () => {
		if (manager) {
			await manager.stop().catch(() => undefined);
			manager.dispose();
			manager = undefined;
		}
		if (backend) {
			await backend.close();
			backend = undefined;
		}
	});

	test('crash with weStarted=true triggers respawn after 1s', async function () {
		this.timeout(5_000);
		backend = await mockBackend({ onHealth: request => request === 1 || request === 3 ? { healthy: false } : { healthy: true } });
		const backendUrl = `http://127.0.0.1:${backend.port}`;
		const first = fakeSpawn();
		const second = fakeSpawn();
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.port': backend.port }), new NullLogService());
		manager.nextProcess = first.process;
		await startSpawned(manager, first.process, backendUrl);

		manager.nextProcess = second.process;
		const crashed = Date.now();
		first.process.simulateExit(1, null);
		await waitForCondition(() => manager?.spawnCalls.length === 2, 'manager did not respawn');
		await sleep(0);
		second.process.stdout.emit('data', `respawned http://127.0.0.1:${backend.port}\n`);
		await waitForCondition(() => manager?.testState === 'running', 'manager did not finish respawn');

		assert.ok(Date.now() - crashed >= 950);
		assert.strictEqual(manager.spawnCalls.length, 2);
	});

	test('crash with weStarted=false does not trigger respawn (orphan adoption)', async function () {
		this.timeout(3_000);
		backend = await mockBackend({ healthy: true });
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.port': backend.port }), new NullLogService());

		await manager.start();
		await sleep(1_100);

		assert.strictEqual(manager.testWeStarted, false);
		assert.strictEqual(manager.spawnCalls.length, 0);
	});

	test('stop() during pending respawn cancels the respawnTimer', async function () {
		this.timeout(4_000);
		backend = await mockBackend({ onHealth: request => request === 1 ? { healthy: false } : { healthy: true } });
		const spawn = fakeSpawn();
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.port': backend.port }), new NullLogService());
		manager.nextProcess = spawn.process;
		await startSpawned(manager, spawn.process, `http://127.0.0.1:${backend.port}`);

		spawn.process.simulateExit(1, null);
		await manager.stop();
		await sleep(1_100);

		assert.strictEqual(manager.spawnCalls.length, 1);
		assert.strictEqual(manager.testState, 'stopped');
	});

	test('respawn invokes start() again with a fresh process', async function () {
		this.timeout(5_000);
		backend = await mockBackend({ onHealth: request => request === 1 || request === 3 ? { healthy: false } : { healthy: true } });
		const backendUrl = `http://127.0.0.1:${backend.port}`;
		const first = fakeSpawn();
		const second = fakeSpawn();
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.port': backend.port }), new NullLogService());
		manager.nextProcess = first.process;
		await startSpawned(manager, first.process, backendUrl);

		manager.nextProcess = second.process;
		first.process.simulateExit(1, null);
		await waitForCondition(() => manager?.spawnCalls.length === 2, 'manager did not spawn again');
		await sleep(0);
		second.process.stdout.emit('data', `ready ${backendUrl}\n`);
		await waitForCondition(() => manager?.backendUrl === backendUrl, 'manager did not restore backendUrl');

		assert.strictEqual(manager.testState, 'running');
		assert.notStrictEqual(first.process, second.process);
	});

	test('respawn loop is bounded by stopRequested flag', async function () {
		this.timeout(4_000);
		// KNOWN LIMITATION: no respawn count cap; tracked in §1.3 deferral.
		backend = await mockBackend({ onHealth: request => request === 1 ? { healthy: false } : { healthy: true } });
		const spawn = fakeSpawn({ exitOnSigterm: false });
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.port': backend.port }), new NullLogService());
		manager.nextProcess = spawn.process;
		await startSpawned(manager, spawn.process, `http://127.0.0.1:${backend.port}`);

		const stopTask = manager.stop();
		spawn.process.simulateExit(null, 'SIGTERM');
		await stopTask;
		await sleep(1_100);

		assert.strictEqual(manager.spawnCalls.length, 1);
		assert.deepStrictEqual(spawn.process.killSignals, ['SIGTERM']);
	});
});

suite('OpencodeServeManager / binary discovery', () => {
	let manager: TestableOpencodeServeManager | undefined;
	let tempDirs: string[] = [];
	let originalPath: string | undefined;

	teardown(async () => {
		if (manager) {
			await manager.stop().catch(() => undefined);
			manager.dispose();
			manager = undefined;
		}
		process.env.PATH = originalPath;
		for (const dir of tempDirs) {
			rmSync(dir, { force: true, recursive: true });
		}
		tempDirs = [];
	});

	setup(() => {
		originalPath = process.env.PATH;
	});

	test('uses opencode.binaryPath when configured and executable', () => {
		const executable = writeExecutable(createTempDir(tempDirs));
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.binaryPath': executable }), new NullLogService());

		assert.strictEqual(internals(manager).findBinaryPath(), executable);
	});

	test('returns configured executable directories before candidate lookup', () => {
		const dir = createTempDir(tempDirs);
		writeExecutable(dir);
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.binaryPath': dir }), new NullLogService());

		assert.strictEqual(internals(manager).findBinaryPath(), dir);
	});

	test('warns and falls through when configured binaryPath is non-executable', () => {
		const configuredDir = createTempDir(tempDirs);
		const configured = join(configuredDir, 'not-executable');
		writeFileSync(configured, '#!/bin/sh\nexit 0\n');
		chmodSync(configured, 0o644);
		const pathDir = createTempDir(tempDirs);
		const pathBinary = writeExecutable(pathDir);
		process.env.PATH = `${pathDir}:${originalPath ?? ''}`;
		const logService = new TestLogService();
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.binaryPath': configured }), logService);

		assert.strictEqual(internals(manager).findBinaryPath(), pathBinary);
		assert.strictEqual(logService.warnings.length, 1);
		assert.strictEqual(logService.warnings[0][0], '[opencode] configured opencode.binaryPath is not executable');
	});

	test('falls back to PATH lookup when binaryPath is unset', () => {
		const pathDir = createTempDir(tempDirs);
		const pathBinary = writeExecutable(pathDir);
		process.env.PATH = `${pathDir}:${originalPath ?? ''}`;
		manager = new TestableOpencodeServeManager(configuration({ 'opencode.binaryPath': '' }), new NullLogService());

		assert.strictEqual(internals(manager).findBinaryPath(), pathBinary);
	});
});
