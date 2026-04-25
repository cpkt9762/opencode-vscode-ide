/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fail, strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Application, ApplicationOptions, Logger } from '../../../../automation';
import { createApp, getRandomUserDataDir, suiteCrashPath, suiteLogsPath } from '../../utils';
import {
	findOpencodeServeProcess,
	isOpencodeServeHealthy,
	killOpencodeServeProcess,
	spawnExternalOpencodeServe,
	waitForOpencodeServe,
} from './opencode-test-helpers';

const OPENCODE_PORT = 5888;

type SmokeContext = Mocha.Context & { defaultOptions?: ApplicationOptions };

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function getDefaultOptions(context: SmokeContext): ApplicationOptions {
	if (!context.defaultOptions) {
		throw new Error('default smoke application options are not available');
	}

	return context.defaultOptions;
}

async function writeOpencodeSettings(userDataPath: string | undefined): Promise<void> {
	if (!userDataPath) {
		throw new Error('user data path is required for opencode lifecycle smoke tests');
	}

	await mkdir(join(userDataPath, 'User'), { recursive: true });
	await writeFile(join(userDataPath, 'User', 'settings.json'), `${JSON.stringify({
		'opencode.autoStart': true,
		'opencode.port': OPENCODE_PORT,
	}, undefined, '\t')}\n`);
}

async function createLifecycleApp(context: SmokeContext): Promise<Application> {
	const defaultOptions = getDefaultOptions(context);
	const suiteName = context.currentTest?.parent?.title ?? 'OpenCode Server Lifecycle';
	const app = createApp({
		...defaultOptions,
		userDataDir: defaultOptions.userDataDir ? getRandomUserDataDir(defaultOptions.userDataDir) : defaultOptions.userDataDir,
		logsPath: suiteLogsPath(defaultOptions, suiteName),
		crashesPath: suiteCrashPath(defaultOptions, suiteName),
	});

	await writeOpencodeSettings(app.userDataPath);
	return app;
}

function assertPid(pid: number | undefined, message: string): number {
	if (pid === undefined) {
		fail(message);
	}

	return pid;
}

async function waitForNoOpencodeServe(port: number, deadlineMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < deadlineMs) {
		if ((await findOpencodeServeProcess(port)) === undefined && !(await isOpencodeServeHealthy(port))) {
			return true;
		}

		await sleep(250);
	}

	return (await findOpencodeServeProcess(port)) === undefined && !(await isOpencodeServeHealthy(port));
}

async function waitForNewOpencodeServeProcess(port: number, previousPid: number, deadlineMs: number): Promise<number | undefined> {
	const start = Date.now();
	while (Date.now() - start < deadlineMs) {
		const pid = await findOpencodeServeProcess(port);
		if (pid !== undefined && pid !== previousPid) {
			return pid;
		}

		await sleep(250);
	}

	const pid = await findOpencodeServeProcess(port);
	return pid !== previousPid ? pid : undefined;
}

async function cleanOrSkipStaleServer(context: Mocha.Context, logger: Logger): Promise<void> {
	const stalePid = await findOpencodeServeProcess(OPENCODE_PORT);
	if (stalePid === undefined) {
		return;
	}

	logger.log(`Found stale opencode serve process on port ${OPENCODE_PORT}: ${stalePid}`);
	killOpencodeServeProcess(stalePid);
	if (!(await waitForNoOpencodeServe(OPENCODE_PORT, 5_000))) {
		context.skip();
	}
}

async function stopApp(app: Application | undefined): Promise<void> {
	if (app) {
		await app.stop();
	}
}

async function killRemainingOpencodeServe(): Promise<void> {
	const pid = await findOpencodeServeProcess(OPENCODE_PORT);
	if (pid !== undefined) {
		killOpencodeServeProcess(pid);
	}

	assert.strictEqual(await waitForNoOpencodeServe(OPENCODE_PORT, 5_000), true, 'opencode serve could not be cleaned up');
}

export function setup(logger: Logger): void {
	describe('OpenCode Server Lifecycle (real OpencodeServeManager)', () => {
		before(async function () {
			this.timeout(10_000);
			await cleanOrSkipStaleServer(this, logger);
		});

		after(async function () {
			this.timeout(10_000);
			const pid = await findOpencodeServeProcess(OPENCODE_PORT);
			if (pid !== undefined) {
				killOpencodeServeProcess(pid);
				await waitForNoOpencodeServe(OPENCODE_PORT, 5_000);
			}
		});

		it('OpencodeServeManager spawns opencode serve on app start', async function () {
			this.timeout(60_000);
			let app: Application | undefined;
			try {
				app = await createLifecycleApp(this);
				await app.start();
				await waitForOpencodeServe(undefined, OPENCODE_PORT, 30_000);

				assert.strictEqual(await isOpencodeServeHealthy(OPENCODE_PORT), true);
				assert.strictEqual(typeof assertPid(await findOpencodeServeProcess(OPENCODE_PORT), 'opencode serve PID was not found'), 'number');
			} finally {
				await stopApp(app);
				await killRemainingOpencodeServe();
			}
		});

		it('OpencodeServeManager adopts pre-existing healthy server (orphan adoption)', async function () {
			this.timeout(60_000);
			let app: Application | undefined;
			let externalPid: number | undefined;
			try {
				externalPid = await spawnExternalOpencodeServe(OPENCODE_PORT);
				app = await createLifecycleApp(this);
				await app.start();

				assert.strictEqual(await findOpencodeServeProcess(OPENCODE_PORT), externalPid);
				assert.strictEqual(await isOpencodeServeHealthy(OPENCODE_PORT), true);
			} finally {
				if (externalPid !== undefined) {
					killOpencodeServeProcess(externalPid);
					await waitForNoOpencodeServe(OPENCODE_PORT, 5_000);
				}
				await stopApp(app);
			}
		});

		it('app.stop() shuts down spawned opencode serve gracefully (within ~3s)', async function () {
			this.timeout(60_000);
			let app: Application | undefined;
			try {
				app = await createLifecycleApp(this);
				await app.start();
				await waitForOpencodeServe(undefined, OPENCODE_PORT, 30_000);
				assertPid(await findOpencodeServeProcess(OPENCODE_PORT), 'spawned opencode serve PID was not found');

				const start = Date.now();
				await app.stop();
				app = undefined;
				assert.ok(Date.now() - start < 5_000, 'app.stop() took longer than 5s');
				assert.strictEqual(await waitForNoOpencodeServe(OPENCODE_PORT, 5_000), true, 'spawned opencode serve was still running after app.stop()');
			} finally {
				await stopApp(app);
				const pid = await findOpencodeServeProcess(OPENCODE_PORT);
				if (pid !== undefined) {
					killOpencodeServeProcess(pid);
					await waitForNoOpencodeServe(OPENCODE_PORT, 5_000);
				}
			}
		});

		it('app.stop() does NOT kill adopted (pre-existing) opencode serve', async function () {
			this.timeout(60_000);
			let app: Application | undefined;
			let externalPid: number | undefined;
			try {
				externalPid = await spawnExternalOpencodeServe(OPENCODE_PORT);
				app = await createLifecycleApp(this);
				await app.start();
				assert.strictEqual(await findOpencodeServeProcess(OPENCODE_PORT), externalPid);

				await app.stop();
				app = undefined;
				assert.strictEqual(await findOpencodeServeProcess(OPENCODE_PORT), externalPid);
			} finally {
				await stopApp(app);
				if (externalPid !== undefined) {
					killOpencodeServeProcess(externalPid);
					await waitForNoOpencodeServe(OPENCODE_PORT, 5_000);
				}
			}
		});
	});

	describe('OpenCode Server Lifecycle / crash recovery', () => {
		before(async function () {
			this.timeout(10_000);
			await cleanOrSkipStaleServer(this, logger);
		});

		after(async function () {
			this.timeout(10_000);
			const pid = await findOpencodeServeProcess(OPENCODE_PORT);
			if (pid !== undefined) {
				killOpencodeServeProcess(pid);
				await waitForNoOpencodeServe(OPENCODE_PORT, 5_000);
			}
		});

		it('opencode serve killed externally triggers respawn within ~3s (weStarted=true)', async function () {
			this.timeout(60_000);
			let app: Application | undefined;
			try {
				app = await createLifecycleApp(this);
				await app.start();
				await waitForOpencodeServe(undefined, OPENCODE_PORT, 30_000);
				const initialPid = assertPid(await findOpencodeServeProcess(OPENCODE_PORT), 'initial opencode serve PID was not found');

				killOpencodeServeProcess(initialPid);
				const newPid = assertPid(await waitForNewOpencodeServeProcess(OPENCODE_PORT, initialPid, 5_000), 'opencode serve did not respawn after external kill');
				assert.notStrictEqual(newPid, initialPid);
				await waitForOpencodeServe(undefined, OPENCODE_PORT, 5_000);
				assert.strictEqual(await isOpencodeServeHealthy(OPENCODE_PORT), true);
			} finally {
				await stopApp(app);
				await waitForNoOpencodeServe(OPENCODE_PORT, 5_000);
			}
		});

		it('externally-spawned (adopted) opencode serve does NOT trigger respawn', async function () {
			this.timeout(60_000);
			let app: Application | undefined;
			let externalPid: number | undefined;
			try {
				externalPid = await spawnExternalOpencodeServe(OPENCODE_PORT);
				app = await createLifecycleApp(this);
				await app.start();
				assert.strictEqual(await findOpencodeServeProcess(OPENCODE_PORT), externalPid);

				killOpencodeServeProcess(assertPid(externalPid, 'external opencode serve PID was not found'));
				await sleep(3_000);
				assert.strictEqual(await findOpencodeServeProcess(OPENCODE_PORT), undefined);
			} finally {
				await stopApp(app);
				if (externalPid !== undefined) {
					killOpencodeServeProcess(externalPid);
				}
				await waitForNoOpencodeServe(OPENCODE_PORT, 5_000);
			}
		});
	});
}
