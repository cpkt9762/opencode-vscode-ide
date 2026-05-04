/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync, spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { Application } from '../../../../automation';

const defaultOpencodeServePort = 5888;
const opencodeInstallHint = 'Install it with `npm i -g opencode-ai` or configure `opencode.binaryPath`.';
const opencodeIframeSelector = '.part.sidebar iframe, .part.auxiliarybar iframe';
const sessionsControlSelector = '.opencode-sessions-control';
const sessionsListRowSelector = '.opencode-sessions-list .monaco-list-row';
const sessionsViewSelector = '.opencode-sessions-view';
const chatViewSelector = '.opencode-chat-view';

export const opencodeSmokeServePort = 4096;
export const opencodeSmokeServerPassword = 'opencode-smoke-password';

export type OpencodeSessionsOrientation = 'stacked' | 'sideBySide';

export interface OpencodeSessionsListItem {
	readonly id: string;
	readonly title: string;
	readonly group: string;
}

interface BackendSession {
	readonly id: string;
	readonly title: string;
}

export async function isOpencodeServeHealthy(port = defaultOpencodeServePort, password?: string): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/global/health`, password ? {
			headers: {
				Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
			},
		} : undefined);
		return password ? response.ok : response.ok || response.status === 401;
	} catch {
		// network error or server not yet up; treat as unhealthy
		return false;
	}
}

export async function waitForOpencodeServe(getOutput = () => '', port = defaultOpencodeServePort, deadlineMs = 30000, password?: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const start = Date.now();
		const withOutput = (message: string) => new Error(`${message}${getOutput() ? `\n${getOutput()}` : ''}`);
		const check = async (): Promise<void> => {
			try {
				if (await isOpencodeServeHealthy(port, password)) {
					resolve();
					return;
				}
		} catch {
			// health check threw (e.g. ECONNREFUSED); expected — will retry on next iteration
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
		// lsof/netstat failed (binary absent or permission denied); treat as no process found
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

export async function spawnExternalOpencodeServe(port: number, password?: string): Promise<number> {
	const child = spawn('opencode', ['serve', '--port', String(port)], {
		detached: true,
		env: password ? { ...process.env, OPENCODE_SERVER_PASSWORD: password } : process.env,
		stdio: 'ignore',
	});
	child.unref();
	if (typeof child.pid !== 'number') {
		throw new Error('failed to spawn external opencode serve (no PID)');
	}

	await waitForOpencodeServe(undefined, port, 30_000, password);
	return child.pid;
}

export async function showSessionsSidebar(app: Application): Promise<void> {
	if (await getOrientationContextKey(app) === 'sideBySide') {
		await waitForSessionsControl(app);
		return;
	}

	await app.workbench.quickaccess.runCommand('opencode.sessions.showSidebar');
	await waitForOrientation(app, 'sideBySide');
	await waitForSessionsControl(app);
}

export async function hideSessionsSidebar(app: Application): Promise<void> {
	if (await getOrientationContextKey(app) === 'stacked') {
		return;
	}

	await app.workbench.quickaccess.runCommand('opencode.sessions.hideSidebar');
	await waitForOrientation(app, 'stacked');
}

export async function getOrientationContextKey(app: Application): Promise<OpencodeSessionsOrientation> {
	const value = await app.code.driver.evaluateExpression<string>(`
		(() => {
			const sessions = document.querySelector(${JSON.stringify(sessionsViewSelector)});
			if (!(sessions instanceof HTMLElement)) {
				return 'stacked';
			}

			const rect = sessions.getBoundingClientRect();
			const style = getComputedStyle(sessions);
			return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden'
				? 'sideBySide'
				: 'stacked';
		})()
	`);
	if (value === 'stacked' || value === 'sideBySide') {
		return value;
	}

	throw new Error(`Unexpected OpenCode sessions orientation: ${value}`);
}

export async function getSessionsListItems(app: Application): Promise<OpencodeSessionsListItem[]> {
	const visibleItems = await app.code.driver.evaluateExpression<Array<{ readonly title: string; readonly group: string }>>(`
		(() => {
			const rows = [...document.querySelectorAll(${JSON.stringify(sessionsListRowSelector)})];
			const items = [];
			let group = '';
			for (const row of rows) {
				if (!(row instanceof HTMLElement) || row.getBoundingClientRect().height <= 0) {
					continue;
				}

				const groupLabel = row.querySelector('.sessions-group-header .label');
				if (groupLabel) {
					group = (groupLabel.textContent || '').trim();
					continue;
				}

				const title = row.querySelector('.sessions-session-row .title');
				const text = (title?.textContent || '').trim();
				if (text) {
					items.push({ title: text, group });
				}
			}

			return items;
		})()
	`);
	if (visibleItems.length === 0) {
		return [];
	}

	const remaining = await fetchSessionsViaIframe(app);
	return visibleItems.map(item => {
		const index = remaining.findIndex(session => session.title === item.title);
		if (index === -1) {
			return { id: item.title, title: item.title, group: item.group };
		}

		const session = remaining[index];
		remaining.splice(index, 1);
		return { id: session.id, title: item.title, group: item.group };
	});
}

export async function clickSessionInList(app: Application, sessionId: string): Promise<void> {
	const sessions = await fetchSessionsViaIframe(app);
	const session = sessions.find(item => item.id === sessionId);
	if (!session) {
		throw new Error(`OpenCode session not found: ${sessionId}`);
	}

	const point = await app.code.driver.evaluateExpression<{ readonly x: number; readonly y: number }>(`
		(() => {
			const row = [...document.querySelectorAll(${JSON.stringify(sessionsListRowSelector)})]
				.find(candidate => (candidate.querySelector('.sessions-session-row .title')?.textContent || '').trim() === ${JSON.stringify(session.title)});
			if (!(row instanceof HTMLElement)) {
				throw new Error('Visible session row not found for ${sessionId}');
			}

			row.scrollIntoView({ block: 'center' });
			const rect = row.getBoundingClientRect();
			return { x: rect.left + Math.min(rect.width / 2, 120), y: rect.top + rect.height / 2 };
		})()
	`);
	await app.code.driver.mouseClick(point.x, point.y, { clickCount: 2 });
}

export async function getCurrentIframeSessionId(app: Application): Promise<string | undefined> {
	await waitForIframeReady(app);
	return await app.code.driver.evaluateInFrame(opencodeIframeSelector, `
		(() => {
			const match = new RegExp('/session/([^/?#]+)').exec(location.pathname);
			return match ? decodeURIComponent(match[1]) : undefined;
		})()
	`);
}

export async function getSashPosition(app: Application): Promise<number> {
	return await app.code.driver.evaluateExpression(`
		(() => {
			const chat = document.querySelector(${JSON.stringify(chatViewSelector)});
			const root = chat?.parentElement;
			if (!(chat instanceof HTMLElement) || !(root instanceof HTMLElement)) {
				throw new Error('OpenCode split view not found');
			}

			const rootWidth = root.getBoundingClientRect().width;
			if (rootWidth <= 0) {
				throw new Error('OpenCode split view has no width');
			}

			return chat.getBoundingClientRect().width / rootWidth;
		})()
	`);
}

export async function setSashPosition(app: Application, ratio: number): Promise<void> {
	const clamped = Math.max(0.05, Math.min(ratio, 0.95));
	const drag = await app.code.driver.evaluateExpression<{ readonly startX: number; readonly targetX: number; readonly y: number }>(`
		(() => {
			const chat = document.querySelector(${JSON.stringify(chatViewSelector)});
			const root = chat?.parentElement;
			if (!(chat instanceof HTMLElement) || !(root instanceof HTMLElement)) {
				throw new Error('OpenCode split view not found');
			}

			const chatRect = chat.getBoundingClientRect();
			const rootRect = root.getBoundingClientRect();
			return {
				startX: chatRect.right - 1,
				targetX: rootRect.left + rootRect.width * ${clamped},
				y: chatRect.top + Math.max(20, chatRect.height / 2),
			};
		})()
	`);
	await app.code.driver.mouseDrag(drag.startX, drag.y, drag.targetX, drag.y);

	const start = Date.now();
	while (Date.now() - start < 5000) {
		if (Math.abs(await getSashPosition(app) - clamped) <= 0.08) {
			return;
		}

		await app.code.wait(100);
	}

	throw new Error(`OpenCode sessions sash did not move to ${clamped}`);
}

export async function createSessionViaIframe(app: Application, title?: string): Promise<string> {
	await waitForIframeReady(app);
	return await app.code.driver.evaluateInFrame(opencodeIframeSelector, `
		(async () => {
			const createResponse = await fetch('/session', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{}',
			});
			if (!createResponse.ok) {
				throw new Error('Failed to create OpenCode session: HTTP ' + createResponse.status);
			}

			const created = await createResponse.json();
			if (!created || typeof created.id !== 'string') {
				throw new Error('OpenCode create session returned no id');
			}

			if (!${JSON.stringify(title ?? '')}) {
				return created.id;
			}

			const renameResponse = await fetch('/session/' + encodeURIComponent(created.id), {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: ${JSON.stringify(title ?? '')} }),
			});
			if (!renameResponse.ok) {
				throw new Error('Failed to rename OpenCode session: HTTP ' + renameResponse.status);
			}

			return created.id;
		})()
	`);
}

async function waitForOrientation(app: Application, expected: OpencodeSessionsOrientation): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < 10000) {
		if (await getOrientationContextKey(app) === expected) {
			return;
		}

		await app.code.wait(100);
	}

	throw new Error(`OpenCode sessions orientation did not become ${expected}`);
}

async function waitForSessionsControl(app: Application): Promise<void> {
	await app.code.driver.evaluateExpression(`
		(async () => {
			const deadline = Date.now() + 10000;
			while (Date.now() < deadline) {
				const control = document.querySelector(${JSON.stringify(sessionsControlSelector)});
				if (control instanceof HTMLElement && control.getBoundingClientRect().width > 0) {
					return;
				}

				await new Promise(resolve => setTimeout(resolve, 100));
			}

			throw new Error('OpenCode sessions control did not render');
		})()
	`);
}

async function waitForIframeReady(app: Application): Promise<void> {
	await app.code.driver.evaluateExpression(`
		(async () => {
			const deadline = Date.now() + 30000;
			while (Date.now() < deadline) {
				const iframe = document.querySelector(${JSON.stringify(opencodeIframeSelector)});
				if (iframe instanceof HTMLIFrameElement && iframe.src.startsWith('http://127.0.0.1:') && iframe.style.display === 'block') {
					return;
				}

				await new Promise(resolve => setTimeout(resolve, 100));
			}

			throw new Error('OpenCode iframe did not become ready');
		})()
	`);
}

async function fetchSessionsViaIframe(app: Application): Promise<BackendSession[]> {
	await waitForIframeReady(app);
	return await app.code.driver.evaluateInFrame(opencodeIframeSelector, `
		(async () => {
			const response = await fetch('/session');
			if (!response.ok) {
				throw new Error('Failed to fetch OpenCode sessions: HTTP ' + response.status);
			}

			const value = await response.json();
			if (!Array.isArray(value)) {
				throw new Error('OpenCode /session did not return an array');
			}

			return value.flatMap(item => item && typeof item.id === 'string' && typeof item.title === 'string'
				? [{ id: item.id, title: item.title }]
				: []);
		})()
	`);
}
