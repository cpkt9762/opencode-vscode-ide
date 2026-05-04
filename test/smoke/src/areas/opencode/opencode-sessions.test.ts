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
	clickSessionInList,
	createSessionViaIframe,
	findOpencodeServeProcess,
	getCurrentIframeSessionId,
	getOrientationContextKey,
	getSashPosition,
	getSessionsListItems,
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

async function openOpencodeSidebar(app: Application): Promise<void> {
	await app.workbench.activitybar.waitForActivityBar(ActivityBarPosition.LEFT);
	await app.code.waitForElement(opencodeActivityBarSelector, undefined, 50);
	await app.code.waitAndClick(opencodeActivityBarSelector);

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

async function waitForOpencodeIframe(app: Application): Promise<void> {
	await app.code.waitForElement(opencodeIframeSelector, undefined, 300);
	await app.code.driver.evaluateExpression(`
		(async () => {
			const deadline = Date.now() + 30000;
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

			throw new Error('OpenCode iframe did not report frame-ready within 30s');
		})()
	`);
}

async function deleteSessionViaIframe(app: Application, sessionId: string): Promise<void> {
	await waitForOpencodeIframe(app);
	await app.code.driver.evaluateInFrame(opencodeIframeSelector, `
		(async () => {
			const response = await fetch('/session/' + encodeURIComponent(${JSON.stringify(sessionId)}), { method: 'DELETE' });
			if (!response.ok && response.status !== 404) {
				throw new Error('Failed to delete test session ${sessionId}: HTTP ' + response.status);
			}
		})()
	`);
}

async function waitForSessionItems(
	app: Application,
	accept: (items: Awaited<ReturnType<typeof getSessionsListItems>>) => boolean,
	message: string,
	deadlineMs = 10000,
): Promise<Awaited<ReturnType<typeof getSessionsListItems>>> {
	const start = Date.now();
	while (Date.now() - start < deadlineMs) {
		const items = await getSessionsListItems(app);
		if (accept(items)) {
			return items;
		}

		await app.code.wait(100);
	}

	throw new Error(message);
}

async function waitForIframeSession(app: Application, sessionId: string): Promise<void> {
	await app.code.driver.evaluateInFrame(opencodeIframeSelector, `
		(async () => {
			const deadline = Date.now() + 10000;
			while (Date.now() < deadline) {
				if (location.pathname.includes('/session/' + ${JSON.stringify(sessionId)})) {
					return;
				}

				await new Promise(resolve => setTimeout(resolve, 100));
			}

			throw new Error('Timed out waiting for iframe to navigate to session ${sessionId}; pathname=' + location.pathname);
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
	await app.code.driver.selectOption(sessionsAgentFilterSelector, agent);
}

async function clearSessionsFilter(app: Application): Promise<void> {
	await app.code.waitForSetValue(sessionsSearchSelector, '');
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

async function rightClickFocusedSession(app: Application): Promise<void> {
	const point = await app.code.driver.evaluateExpression<{ readonly x: number; readonly y: number }>(`
		(() => {
			const row = document.querySelector('.opencode-sessions-list .monaco-list-row.focused');
			if (!(row instanceof HTMLElement)) {
				throw new Error('Focused session row not found');
			}

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
		const createdSessionIds: string[] = [];

		async function createTrackedSession(app: Application, title: string): Promise<string> {
			const id = await createSessionViaIframe(app, title);
			createdSessionIds.push(id);
			return id;
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

		afterEach(async function () {
			if (createdSessionIds.length === 0) {
				return;
			}

			const app = this.app as Application;
			await openOpencodeSidebar(app);
			const ids = createdSessionIds.splice(0, createdSessionIds.length);
			await Promise.all(ids.map(id => deleteSessionViaIframe(app, id)));
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
			const id = await createTrackedSession(app, `e2e-show-list-${Date.now()}`);

			await showSessionsSidebar(app);
			assert.strictEqual(await getOrientationContextKey(app), 'sideBySide');
			await assertSessionsControlVisible(app);
			const items = await waitForSessionItems(app, sessions => sessions.some(session => session.id === id), 'created session did not render in Sessions list');
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

		it('4. Clicking a session navigates the iframe to /session/:id', async function () {
			const app = this.app as Application;
			await openOpencodeSidebar(app);
			const targetId = await createTrackedSession(app, `e2e-click-target-${Date.now()}`);
			await createTrackedSession(app, `e2e-click-spare-${Date.now()}`);

			await showSessionsSidebar(app);
			await waitForSessionItems(app, items => items.filter(item => createdSessionIds.includes(item.id)).length >= 2, 'expected at least two smoke-created sessions in list');
			await clickSessionInList(app, targetId);
			await waitForIframeSession(app, targetId);
			assert.strictEqual(await getCurrentIframeSessionId(app), targetId);
		});

		it('5. Auto-widens narrow pane on first SideBySide toggle', async function () {
			const app = this.app as Application;
			await openOpencodeSidebar(app);
			await hideSessionsSidebar(app);
			await app.restart();
			await openOpencodeSidebar(app);

			await setSidebarNarrow(app);
			assert.ok(await getSidebarWidth(app) < 600, 'precondition: OpenCode pane is narrow before toggle');
			await showSessionsSidebar(app);
			assert.ok(await getSidebarWidth(app) >= 600, 'OpenCode pane auto-widens for side-by-side sessions');
		});

		it('6. Sash drag persists across IDE restart', async function () {
			const app = this.app as Application;
			await openOpencodeSidebar(app);
			await showSessionsSidebar(app);

			await setSashPosition(app, 0.5);
			assert.ok(Math.abs(await getSashPosition(app) - 0.5) <= 0.08, 'sash ratio is near 0.5 before restart');
			await app.restart();
			await openOpencodeSidebar(app);
			await showSessionsSidebar(app);
			assert.ok(Math.abs(await getSashPosition(app) - 0.5) <= 0.08, 'sash ratio is near 0.5 after restart');
		});

		it('7. Orientation persists across IDE restart', async function () {
			const app = this.app as Application;
			await openOpencodeSidebar(app);
			await showSessionsSidebar(app);

			await app.restart();
			await openOpencodeSidebar(app);
			assert.strictEqual(await getOrientationContextKey(app), 'sideBySide');
			await hideSessionsSidebar(app);
			await app.restart();
			await openOpencodeSidebar(app);
			assert.strictEqual(await getOrientationContextKey(app), 'stacked');
		});

		it('8. New session in iframe → list updates within 1500ms via SSE', async function () {
			const app = this.app as Application;
			await openOpencodeSidebar(app);
			await showSessionsSidebar(app);
			const before = await getSessionsListItems(app);
			const title = `e2e-test-session-${Date.now()}`;
			const id = await createTrackedSession(app, title);

			const items = await waitForSessionItems(app, sessions => sessions.length > before.length && sessions.some(session => session.id === id), 'SSE-created session did not appear within 1500ms', 1500);
			const created = items.find(item => item.id === id);
			assert.strictEqual(created?.title, title);
			assert.strictEqual(created?.group, 'Today');
		});

		it('9. Search filters list; agent dropdown filters list', async function () {
			const app = this.app as Application;
			await openOpencodeSidebar(app);
			const agent = 'agentA';
			await createTrackedSession(app, `e2e test alpha @${agent} subagent ${Date.now()}`);
			await createTrackedSession(app, `e2e test beta @agentB subagent ${Date.now()}`);
			await createTrackedSession(app, `e2e control @${agent} subagent ${Date.now()}`);

			await showSessionsSidebar(app);
			await waitForSessionItems(app, items => createdSessionIds.every(id => items.some(item => item.id === id)), 'expected smoke-created sessions before filtering');
			await clearSessionsFilter(app);
			await app.code.waitForSetValue(sessionsSearchSelector, 'test');
			const searched = await waitForSessionItems(app, items => items.length > 0 && items.every(item => item.title.toLocaleLowerCase().includes('test')), 'search filter did not restrict visible session rows');
			assert.ok(searched.length >= 2, 'search filter keeps matching smoke sessions');

			await app.code.waitForSetValue(sessionsSearchSelector, '');
			await waitForSessionItems(app, items => createdSessionIds.every(id => items.some(item => item.id === id)), 'search clear did not restore smoke sessions');
			await selectAgentFilter(app, agent);
			const agentFiltered = await waitForSessionItems(app, items => items.length > 0 && items.every(item => item.title.includes(`@${agent} subagent`)), 'agent filter did not restrict visible session rows');
			assert.ok(agentFiltered.length >= 2, 'agent filter keeps matching smoke sessions');
		});

		it('10. Right-click context menu — Rename + Delete actions complete', async function () {
			const app = this.app as Application;
			await openOpencodeSidebar(app);
			const id = await createTrackedSession(app, `e2e-context-${Date.now()}`);
			const renamedTitle = `renamed-by-e2e-${Date.now()}`;

			await showSessionsSidebar(app);
			await waitForSessionItems(app, items => items.some(item => item.id === id), 'context-menu session did not render');
			await clickSessionInList(app, id);
			await rightClickFocusedSession(app);
			await waitForContextMenuActions(app);
			await clickContextMenuAction(app, 'Rename');
			await app.workbench.quickinput.waitForQuickInputOpened();
			await app.workbench.quickinput.type(renamedTitle);
			await app.code.dispatchKeybinding('enter', async () => {
				await app.workbench.quickinput.waitForQuickInputClosed();
			});
			await waitForSessionItems(app, items => items.some(item => item.id === id && item.title === renamedTitle), 'renamed session title did not appear in list');

			await clickSessionInList(app, id);
			await rightClickFocusedSession(app);
			await waitForContextMenuActions(app);
			await clickContextMenuAction(app, 'Delete');
			await app.code.waitForTextContent('.monaco-dialog-box', undefined, text => text.includes('Delete session?'), 50);
			await app.code.waitAndClick('.monaco-dialog-box .dialog-buttons .monaco-button.default', 2, 2);
			await waitForSessionItems(app, items => !items.some(item => item.id === id), 'deleted session still appears in list');
			createdSessionIds.splice(createdSessionIds.indexOf(id), 1);
		});
	});
}
