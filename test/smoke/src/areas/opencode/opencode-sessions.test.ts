/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { spawn } from 'node:child_process';
import type { Application, Logger } from '../../../../automation';
import { ActivityBarPosition } from '../../../../automation';
import { installAllHandlers } from '../../utils';
import {
	findOpencodeServeProcess,
	getOrientationContextKey,
	getSashPosition,
	hideSessionsSidebar,
	isOpencodeServeHealthy,
	killOpencodeServeProcess,
	opencodeSmokeServePort,
	opencodeSmokeServerPassword,
	setSashPosition,
	showSessionsSidebar,
	waitForOpencodeServe,
} from './opencode-test-helpers.js';

const opencodeActivityBarSelector = '.part.activitybar [aria-label*="OpenCode"]';
const opencodeIframeSelector = '.part.sidebar iframe, .part.auxiliarybar iframe';
const sessionsControlSelector = '.opencode-sessions-control';
const sessionsSearchSelector = '.opencode-sessions-search';
const sessionsAgentFilterSelector = '.opencode-sessions-agent-filter';

let opencodeServeProcess: ReturnType<typeof spawn> | undefined;

interface BackendSession {
	readonly id: string;
	readonly title: string;
}

interface RenderedSessionItem {
	readonly title: string;
	readonly group: string;
}

async function openOpencodeSidebar(app: Application, waitForIframe = true): Promise<void> {
	await app.workbench.activitybar.waitForActivityBar(ActivityBarPosition.LEFT);
	await app.code.waitForElement(opencodeActivityBarSelector, undefined, 50);
	if (!await isOpencodeSidebarOpen(app)) {
		await app.code.waitAndClick(opencodeActivityBarSelector);
	}
	if (!waitForIframe) {
		await waitForOpencodeShell(app);
		return;
	}

	try {
		await waitForOpencodeIframe(app);
	} catch (error) {
		const sidebarError = (await app.code.driver.getConsoleMessages())
			.reverse()
			.find(message => message.text.includes('workbench.view.opencode.chat') || message.text.includes('TrustedHTML'));

		if (sidebarError) {
			throw new Error(`OpenCode sidebar failed to render: ${sidebarError.text}`);
		}

		throw error;
	}
}

async function isOpencodeSidebarOpen(app: Application): Promise<boolean> {
	return await app.code.driver.evaluateExpression(`
		(() => {
			const chat = document.querySelector('.opencode-chat-view');
			if (chat instanceof HTMLElement && chat.getBoundingClientRect().width > 0 && getComputedStyle(chat).display !== 'none') {
				return true;
			}

			const iframe = document.querySelector(${JSON.stringify(opencodeIframeSelector)});
			return iframe instanceof HTMLIFrameElement && iframe.src.startsWith('http://127.0.0.1:') && getComputedStyle(iframe).display !== 'none';
		})()
	`);
}

async function waitForOpencodeShell(app: Application): Promise<void> {
	await app.code.driver.evaluateExpression(`
		(async () => {
			const deadline = Date.now() + 60000;
			while (Date.now() < deadline) {
				const chat = document.querySelector('.opencode-chat-view');
				if (chat instanceof HTMLElement && chat.getBoundingClientRect().width > 0) {
					return;
				}

				await new Promise(resolve => setTimeout(resolve, 100));
			}

			throw new Error('OpenCode workbench shell did not render within 60s');
		})()
	`);
}

async function waitForOpencodeIframe(app: Application): Promise<void> {
	await app.code.waitForElement(opencodeIframeSelector, undefined, 600);
	await app.code.driver.evaluateExpression(`
		(async () => {
			const deadline = Date.now() + 60000;
			while (Date.now() < deadline) {
				const iframe = document.querySelector(${JSON.stringify(opencodeIframeSelector)});
				if (
					iframe instanceof HTMLIFrameElement &&
					iframe.src.startsWith('http://127.0.0.1:') &&
					getComputedStyle(iframe).display !== 'none'
				) {
					return;
				}

				await new Promise(resolve => setTimeout(resolve, 100));
			}

			throw new Error('OpenCode iframe did not report frame-ready within 60s');
		})()
	`);
}

function opencodeAuthHeader(): string {
	return `Basic ${Buffer.from(`opencode:${opencodeSmokeServerPassword}`).toString('base64')}`;
}

async function waitForSessionItems(
	app: Application,
	accept: (items: readonly RenderedSessionItem[]) => boolean,
	message: string,
	deadlineMs = 10000,
): Promise<readonly RenderedSessionItem[]> {
	const start = Date.now();
	while (Date.now() - start < deadlineMs) {
		const items = await getRenderedSessionItems(app);
		if (accept(items)) {
			return items;
		}

		await app.code.wait(100);
	}

	throw new Error(message);
}

async function createSessionViaBackend(title: string): Promise<BackendSession> {
	const created = await opencodeJson('/session', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: '{}',
	});
	const session = toBackendSession(created);
	if (!session) {
		throw new Error('OpenCode create session returned an invalid session');
	}

	const renamed = await opencodeJson(`/session/${encodeURIComponent(session.id)}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ title }),
	});
	const renamedSession = toBackendSession(renamed);
	if (!renamedSession) {
		throw new Error('OpenCode rename session returned an invalid session');
	}

	return renamedSession;
}

async function deleteSessionViaBackend(sessionId: string): Promise<void> {
	const response = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
	if (!response.ok && response.status !== 404) {
		throw new Error(`Failed to delete test session ${sessionId}: HTTP ${response.status}`);
	}
}

async function opencodeJson(path: string, init?: RequestInit): Promise<unknown> {
	const response = await opencodeFetch(path, init);
	if (!response.ok) {
		throw new Error(`OpenCode request failed: ${path} HTTP ${response.status}`);
	}

	return await response.json() as unknown;
}

async function opencodeFetch(path: string, init?: RequestInit): Promise<Response> {
	return await fetch(`http://127.0.0.1:${opencodeSmokeServePort}${path}`, {
		...init,
		headers: {
			...init?.headers,
			Authorization: opencodeAuthHeader(),
		},
	});
}

function toBackendSession(value: unknown): BackendSession | undefined {
	if (!value || typeof value !== 'object' || !('id' in value) || !('title' in value)) {
		return undefined;
	}

	return typeof value.id === 'string' && typeof value.title === 'string'
		? { id: value.id, title: value.title }
		: undefined;
}

async function getRenderedSessionItems(app: Application): Promise<readonly RenderedSessionItem[]> {
	return await app.code.driver.evaluateExpression<RenderedSessionItem[]>(`
		(() => {
			const rows = [...document.querySelectorAll('.opencode-sessions-list .monaco-list-row')];
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

				const title = (row.querySelector('.sessions-session-row .title')?.textContent || '').trim();
				if (title) {
					items.push({ title, group });
				}
			}

			return items;
		})()
	`);
}

async function assertSessionsControlVisible(app: Application): Promise<void> {
	assert.strictEqual(await app.code.driver.evaluateExpression(`
		(() => {
			const control = document.querySelector(${JSON.stringify(sessionsControlSelector)});
			if (!(control instanceof HTMLElement)) {
				return false;
			}

			const rect = control.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0 && getComputedStyle(control).display !== 'none';
		})()
	`), true, 'sessions control is visible');
}

async function assertNoSessionsControl(app: Application): Promise<void> {
	assert.strictEqual(await app.code.driver.evaluateExpression(`
		(() => document.querySelector(${JSON.stringify(sessionsControlSelector)}) === null)()
	`), true, 'sessions control is not created in stacked mode on first launch');
}

async function assertIframeSpansPane(app: Application): Promise<void> {
	const widths = await app.code.driver.evaluateExpression<{ readonly chat: number; readonly pane: number }>(`
		(() => {
			const chat = document.querySelector('.opencode-chat-view');
			const pane = chat?.parentElement;
			if (!(chat instanceof HTMLElement) || !(pane instanceof HTMLElement)) {
				throw new Error('OpenCode chat pane not found');
			}

			return {
				chat: chat.getBoundingClientRect().width,
				pane: pane.getBoundingClientRect().width,
			};
		})()
	`);
	assert.ok(Math.abs(widths.chat - widths.pane) <= 2, `iframe/chat pane should span full width: ${JSON.stringify(widths)}`);
}

async function setSidebarNarrow(app: Application): Promise<void> {
	const drag = await app.code.driver.evaluateExpression<{ readonly startX: number; readonly targetX: number; readonly y: number }>(`
		(() => {
			const sidebar = document.querySelector('.part.sidebar');
			if (!(sidebar instanceof HTMLElement)) {
				throw new Error('Sidebar part not found');
			}

			const sidebarRect = sidebar.getBoundingClientRect();
			const sash = [...document.querySelectorAll('.monaco-sash.vertical')]
				.filter(candidate => candidate instanceof HTMLElement)
				.map(candidate => ({ element: candidate, rect: candidate.getBoundingClientRect() }))
				.sort((a, b) => Math.abs((a.rect.left + a.rect.width / 2) - sidebarRect.right) - Math.abs((b.rect.left + b.rect.width / 2) - sidebarRect.right))[0];

			return {
				startX: sash ? sash.rect.left + sash.rect.width / 2 : sidebarRect.right - 1,
				targetX: sidebarRect.left + 400,
				y: sidebarRect.top + Math.max(40, sidebarRect.height / 2),
			};
		})()
	`);
	await app.code.driver.mouseDrag(drag.startX, drag.y, drag.targetX, drag.y);
	await app.code.driver.evaluateExpression(`
		(async () => {
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				const sidebar = document.querySelector('.part.sidebar');
				if (sidebar instanceof HTMLElement && sidebar.getBoundingClientRect().width < 600) {
					return;
				}

				await new Promise(resolve => setTimeout(resolve, 100));
			}

			throw new Error('Sidebar did not become narrow enough for auto-widen smoke test');
		})()
	`);
}

async function getSidebarWidth(app: Application): Promise<number> {
	return await app.code.driver.evaluateExpression(`
		(() => {
			const sidebar = document.querySelector('.part.sidebar');
			if (!(sidebar instanceof HTMLElement)) {
				throw new Error('Sidebar part not found');
			}

			return sidebar.getBoundingClientRect().width;
		})()
	`);
}

async function selectAgentFilter(app: Application, agent: string): Promise<void> {
	await app.code.driver.evaluateExpression(`
		(() => {
			const select = document.querySelector(${JSON.stringify(sessionsAgentFilterSelector)});
			if (!(select instanceof HTMLSelectElement)) {
				throw new Error('OpenCode sessions agent filter not found');
			}

			select.value = ${JSON.stringify(agent)};
			select.dispatchEvent(new Event('change', { bubbles: true }));
		})()
	`);
}

async function setSessionsSearch(app: Application, value: string): Promise<void> {
	await app.code.driver.evaluateExpression(`
		(() => {
			const input = document.querySelector(${JSON.stringify(sessionsSearchSelector)});
			if (!(input instanceof HTMLInputElement)) {
				throw new Error('OpenCode sessions search input not found');
			}

			input.value = ${JSON.stringify(value)};
			input.dispatchEvent(new Event('input', { bubbles: true }));
		})()
	`);
}

async function clearSessionsFilter(app: Application): Promise<void> {
	await setSessionsSearch(app, '');
	await selectAgentFilter(app, '');
}

async function waitForContextMenuActions(app: Application): Promise<void> {
	await app.code.driver.evaluateExpression(`
		(async () => {
			const deadline = Date.now() + 5000;
			const required = ['Rename', 'Share', 'Fork', 'Delete'];
			while (Date.now() < deadline) {
				const labels = [...document.querySelectorAll('.context-view .action-label, .context-view .option-text')]
					.map(element => (element.textContent || '').trim())
					.filter(Boolean);
				if (required.every(label => labels.includes(label))) {
					return;
				}

				await new Promise(resolve => setTimeout(resolve, 100));
			}

			throw new Error('OpenCode session context menu did not show Rename, Share, Fork, Delete');
		})()
	`);
}

async function clickContextMenuAction(app: Application, label: string): Promise<void> {
	await app.code.driver.evaluateExpression(`
		(() => {
			const item = [...document.querySelectorAll('.context-view .action-label, .context-view .option-text')]
				.find(element => (element.textContent || '').trim() === ${JSON.stringify(label)});
			if (!(item instanceof HTMLElement)) {
				throw new Error('Context menu action not found: ${label}');
			}

			item.click();
		})()
	`);
}

async function rightClickSessionTitle(app: Application, title: string): Promise<void> {
	const point = await app.code.driver.evaluateExpression<{ readonly x: number; readonly y: number }>(`
		(() => {
			const row = [...document.querySelectorAll('.opencode-sessions-list .monaco-list-row')]
				.find(candidate => (candidate.querySelector('.sessions-session-row .title')?.textContent || '').trim() === ${JSON.stringify(title)});
			if (!(row instanceof HTMLElement)) {
				throw new Error('Session row not found: ${title}');
			}

			row.scrollIntoView({ block: 'center' });
			const rect = row.getBoundingClientRect();
			return { x: rect.left + Math.min(rect.width / 2, 120), y: rect.top + rect.height / 2 };
		})()
	`);
	await app.code.driver.mouseClick(point.x, point.y, { button: 'right' });
}

export function setup(logger: Logger) {
	describe('OpenCode Sessions Panel', () => {
		installAllHandlers(logger);

		let opencodeServeOutput = '';
		const createdSessions: BackendSession[] = [];

		async function createTrackedSession(title: string): Promise<BackendSession> {
			const session = await createSessionViaBackend(title);
			createdSessions.push(session);
			return session;
		}

		before(async function () {
			this.timeout(30000);
			opencodeServeOutput = '';
			if (await isOpencodeServeHealthy(opencodeSmokeServePort, opencodeSmokeServerPassword)) {
				return;
			}
			const stalePid = await findOpencodeServeProcess(opencodeSmokeServePort);
			if (stalePid !== undefined) {
				killOpencodeServeProcess(stalePid);
			}

			opencodeServeProcess = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(opencodeSmokeServePort), '--print-logs'], {
				env: { ...process.env, OPENCODE_SERVER_PASSWORD: opencodeSmokeServerPassword },
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			opencodeServeProcess.stdout?.on('data', chunk => {
				opencodeServeOutput += chunk.toString();
			});
			opencodeServeProcess.stderr?.on('data', chunk => {
				opencodeServeOutput += chunk.toString();
			});

			await waitForOpencodeServe(() => opencodeServeOutput, opencodeSmokeServePort, 30_000, opencodeSmokeServerPassword);
		});

		after(async function () {
			this.timeout(10000);
			if (!opencodeServeProcess) {
				return;
			}

			const childProcess = opencodeServeProcess;
			opencodeServeProcess = undefined;
			const exited = new Promise<void>(resolve => {
				childProcess.once('exit', () => {
					resolve();
				});
			});

			childProcess.kill('SIGTERM');
			await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
			if (!childProcess.killed) {
				childProcess.kill('SIGKILL');
				await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
			}
		});

		afterEach(async () => {
			if (createdSessions.length === 0) {
				return;
			}

			const ids = createdSessions.splice(0, createdSessions.length).map(session => session.id);
			await Promise.all(ids.map(id => deleteSessionViaBackend(id)));
		});

		it('1. Stacked is default — sessions hidden on first launch', async function () {
			const app = this.app as Application;
			await openOpencodeSidebar(app);

			assert.strictEqual(await getOrientationContextKey(app), 'stacked');
			await assertNoSessionsControl(app);
		});

		it('2. Show button switches to SideBySide and renders list', async function () {
			const app = this.app as Application;
			await openOpencodeSidebar(app);
			const session = await createTrackedSession(`e2e-show-list-${Date.now()}`);

			await showSessionsSidebar(app);
			assert.strictEqual(await getOrientationContextKey(app), 'sideBySide');
			await assertSessionsControlVisible(app);
			const items = await waitForSessionItems(app, sessions => sessions.some(item => item.title === session.title), 'created session did not render in Sessions list');
			assert.ok(items.length >= 1, 'sessions list renders visible session rows');
		});

		it('3. Hide button switches back to Stacked', async function () {
			const app = this.app as Application;
			await openOpencodeSidebar(app);

			await showSessionsSidebar(app);
			assert.strictEqual(await getOrientationContextKey(app), 'sideBySide');
			await hideSessionsSidebar(app);
			assert.strictEqual(await getOrientationContextKey(app), 'stacked');
			await assertIframeSpansPane(app);
		});

		it('4. Internal toggle auto-widens narrow pane on first SideBySide switch', async function () {
			const app = this.app as Application;
			await openOpencodeSidebar(app, false);
			await hideSessionsSidebar(app);
			await app.restart();
			await openOpencodeSidebar(app, false);

			await setSidebarNarrow(app);
			assert.ok(await getSidebarWidth(app) < 600, 'precondition: OpenCode pane is narrow before toggle');
			await showSessionsSidebar(app);
			assert.ok(await getSidebarWidth(app) >= 600, 'OpenCode pane auto-widens for side-by-side sessions');
		});

		it('5. Internal sash ratio persists across IDE restart', async function () {
			const app = this.app as Application;
			await openOpencodeSidebar(app, false);
			await showSessionsSidebar(app);

			await setSashPosition(app, 0.5);
			assert.ok(Math.abs(await getSashPosition(app) - 0.5) <= 0.08, 'sash ratio is near 0.5 before restart');
			await app.code.wait(700);
			await app.restart();
			await openOpencodeSidebar(app, false);
			await showSessionsSidebar(app);
			assert.ok(Math.abs(await getSashPosition(app) - 0.5) <= 0.08, 'sash ratio is near 0.5 after restart');
		});

		it('6. Internal orientation state persists across IDE restart', async function () {
			const app = this.app as Application;
			await openOpencodeSidebar(app, false);
			await showSessionsSidebar(app);

			await app.restart();
			await openOpencodeSidebar(app, false);
			assert.strictEqual(await getOrientationContextKey(app), 'sideBySide');
			await hideSessionsSidebar(app);
			await app.restart();
			await openOpencodeSidebar(app, false);
			assert.strictEqual(await getOrientationContextKey(app), 'stacked');
		});

		it('7. Backend session event updates list within 1500ms via SSE', async function () {
			const app = this.app as Application;
			await openOpencodeSidebar(app, false);
			await showSessionsSidebar(app);
			const before = await getRenderedSessionItems(app);
			const title = `e2e-test-session-${Date.now()}`;
			await createTrackedSession(title);

			const items = await waitForSessionItems(app, sessions => sessions.length > before.length && sessions.some(item => item.title === title), 'SSE-created session did not appear within 1500ms', 1500);
			const created = items.find(item => item.title === title);
			assert.strictEqual(created?.title, title);
			assert.strictEqual(created?.group, 'Today');
		});

		it('8. Internal search input and agent dropdown filter rendered list', async function () {
			const app = this.app as Application;
			await openOpencodeSidebar(app, false);
			const agent = 'agentA';
			const alpha = await createTrackedSession(`e2e test alpha @${agent} subagent ${Date.now()}`);
			const beta = await createTrackedSession(`e2e test beta @agentB subagent ${Date.now()}`);
			const control = await createTrackedSession(`e2e control @${agent} subagent ${Date.now()}`);

			await showSessionsSidebar(app);
			await waitForSessionItems(app, items => [alpha, beta, control].every(session => items.some(item => item.title === session.title)), 'expected smoke-created sessions before filtering');
			await clearSessionsFilter(app);
			await setSessionsSearch(app, 'test');
			const searched = await waitForSessionItems(app, items => items.length > 0 && items.every(item => item.title.toLocaleLowerCase().includes('test')), 'search filter did not restrict visible session rows');
			assert.ok(searched.length >= 2, 'search filter keeps matching smoke sessions');

			await setSessionsSearch(app, '');
			await waitForSessionItems(app, items => [alpha, beta, control].every(session => items.some(item => item.title === session.title)), 'search clear did not restore smoke sessions');
			await selectAgentFilter(app, agent);
			const agentFiltered = await waitForSessionItems(app, items => items.length > 0 && items.every(item => item.title.includes(`@${agent} subagent`)), 'agent filter did not restrict visible session rows');
			assert.ok(agentFiltered.length >= 2, 'agent filter keeps matching smoke sessions');
		});

		it('9. Rename session command updates the rendered list', async function () {
			const app = this.app as Application;
			await openOpencodeSidebar(app, false);
			const session = await createTrackedSession(`e2e-rename-${Date.now()}`);
			const renamedTitle = `renamed-by-e2e-${Date.now()}`;

			await showSessionsSidebar(app);
			await waitForSessionItems(app, items => items.some(item => item.title === session.title), 'rename session did not render');
			await rightClickSessionTitle(app, session.title);
			await waitForContextMenuActions(app);
			await clickContextMenuAction(app, 'Rename');
			await app.workbench.quickinput.waitForQuickInputOpened();
			await app.workbench.quickinput.type(renamedTitle);
			await app.code.dispatchKeybinding('enter', async () => {
				await app.workbench.quickinput.waitForQuickInputClosed();
			});
			await waitForSessionItems(app, items => items.some(item => item.title === renamedTitle), 'renamed session title did not appear in list');
			createdSessions.splice(createdSessions.findIndex(item => item.id === session.id), 1, { id: session.id, title: renamedTitle });
		});

		it('10. Delete session command removes the rendered list row', async function () {
			const app = this.app as Application;
			await openOpencodeSidebar(app, false);
			const session = await createTrackedSession(`e2e-delete-${Date.now()}`);

			await showSessionsSidebar(app);
			await waitForSessionItems(app, items => items.some(item => item.title === session.title), 'delete session did not render');
			await rightClickSessionTitle(app, session.title);
			await waitForContextMenuActions(app);
			await clickContextMenuAction(app, 'Delete');
			await app.code.waitForTextContent('.monaco-dialog-box', undefined, text => text.includes('Delete session?'), 50);
			await app.code.waitAndClick('.monaco-dialog-box .dialog-buttons .monaco-button.default', 2, 2);
			await waitForSessionItems(app, items => !items.some(item => item.title === session.title), 'deleted session still appears in list');
			createdSessions.splice(createdSessions.findIndex(item => item.id === session.id), 1);
		});
	});
}
