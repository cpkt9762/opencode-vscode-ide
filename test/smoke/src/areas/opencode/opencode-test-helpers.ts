/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync, spawn } from 'node:child_process';
import { platform } from 'node:os';

const defaultOpencodeServePort = 5888;
const opencodeInstallHint = 'Install it with `npm i -g opencode-ai` or configure `opencode.binaryPath`.';

export async function isOpencodeServeHealthy(port = defaultOpencodeServePort, password?: string): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/global/health`, password ? {
			headers: {
				Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
			},
		} : undefined);
		return response.ok || response.status === 401;
	} catch {
		return false;
	}
}

export async function waitForOpencodeServe(getOutput = () => '', port = defaultOpencodeServePort, deadlineMs = 30000): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const start = Date.now();
		const withOutput = (message: string) => new Error(`${message}${getOutput() ? `\n${getOutput()}` : ''}`);
		const check = async (): Promise<void> => {
			try {
				if (await isOpencodeServeHealthy(port)) {
					resolve();
					return;
				}
			} catch {
				// wait and retry
			}

			if (Date.now() - start > deadlineMs) {
				reject(withOutput(`opencode serve did not start within ${Math.round(deadlineMs / 1000)}s. ${opencodeInstallHint}`));
				return;
			}

			setTimeout(() => {
				void check();
			}, 500);
		};

		void check();
	});
}

export async function findOpencodeServeProcess(port: number): Promise<number | undefined> {
	try {
		if (platform() === 'win32') {
			const pattern = new RegExp(`\\s127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)$`);
			const match = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
				.split(/\r?\n/)
				.map(line => pattern.exec(line))
				.find((candidate): candidate is RegExpExecArray => !!candidate);

			return match ? Number(match[1]) : undefined;
		}

		const output = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim();
		const pid = output ? Number(output.split(/\r?\n/)[0]) : NaN;
		return Number.isFinite(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

export function killOpencodeServeProcess(pid: number): void {
	try {
		process.kill(pid, 'SIGKILL');
	} catch {
		// Process may have already exited; that's fine.
	}
}

export async function spawnExternalOpencodeServe(port: number): Promise<number> {
	const child = spawn('opencode', ['serve', '--port', String(port)], {
		detached: true,
		stdio: 'ignore',
	});
	child.unref();
	if (typeof child.pid !== 'number') {
		throw new Error('failed to spawn external opencode serve (no PID)');
	}

	await waitForOpencodeServe(undefined, port, 30_000);
	return child.pid;
}
