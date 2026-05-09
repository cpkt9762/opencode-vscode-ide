/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import type { Application, Logger } from '../../../../automation';
import { ActivityBarPosition } from '../../../../automation';
import { installAllHandlers } from '../../utils';

const opencodeActivityBarSelector = '.part.activitybar [aria-label*="OpenCode"]';
const opencodeChatViewSelector = '.opencode-chat-view';
const agentEditConsoleErrorPattern = /agentEditTracker|agentModifiedDecorationsProvider|agentEditNavigator|agentEditScmBridge/i;
const colorTokens = [
	'list.opencodeAgentModifiedForeground',
	'list.opencodeAgentViewedForeground',
] as const;

async function openOpencodeSidebarShell(app: Application): Promise<void> {
	await app.workbench.activitybar.waitForActivityBar(ActivityBarPosition.LEFT);
	await app.code.waitForElement(opencodeActivityBarSelector, undefined, 50);
	await app.code.waitAndClick(opencodeActivityBarSelector);
	await app.code.driver.evaluateExpression(`
		(async () => {
			const deadline = Date.now() + 10000;
			while (Date.now() < deadline) {
				const chat = document.querySelector(${JSON.stringify(opencodeChatViewSelector)});
				if (chat instanceof HTMLElement && chat.getBoundingClientRect().width > 0) {
					return;
				}

				await new Promise(resolve => setTimeout(resolve, 100));
			}

			throw new Error('OpenCode workbench shell did not render within 10s');
		})()
	`);
}

async function assertNoAgentEditConsoleErrors(app: Application, message: string): Promise<void> {
	const matchingErrors = (await app.code.driver.getConsoleMessages())
		.filter(entry => entry.type === 'error' && agentEditConsoleErrorPattern.test(entry.text))
		.map(entry => `${entry.type}: ${entry.text}`);
	assert.deepStrictEqual(matchingErrors, [], message);
}

async function openSettingsJsonFromSettingsUI(app: Application): Promise<void> {
	await app.workbench.settingsEditor.searchSettingsUI('workbench.colorCustomizations');
	await app.workbench.settingsEditor.openUserSettingsFile();
}

async function triggerColorCustomizationSuggestions(app: Application): Promise<void> {
	await app.code.driver.evaluateExpression(`
		(() => {
			const editor = globalThis.monaco?.editor?.getEditors?.()
				.find(candidate => candidate.getModel?.()?.uri?.toString?.().endsWith('/settings.json'));
			if (!editor) {
				throw new Error('settings.json editor not found');
			}

			const value = '{\n\t"workbench.colorCustomizations": {\n\t\t"list.opencodeAgent\n\t}\n}';
			const lineNumber = 3;
			const column = value.split('\n')[lineNumber - 1].length + 1;
			editor.getModel().setValue(value);
			editor.setPosition({ lineNumber, column });
			editor.focus();
			editor.trigger('opencode-agent-edit-decorations-smoke', 'editor.action.triggerSuggest', {});
		})()
	`);
}

async function waitForColorTokenSuggestions(app: Application): Promise<void> {
	const start = Date.now();
	let lastSuggestions: readonly string[] = [];
	while (Date.now() - start < 10000) {
		lastSuggestions = await app.code.driver.evaluateExpression<string[]>(`
			(() => [...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')]
				.flatMap(row => {
					const text = (row.textContent || '').trim();
					return text ? [text] : [];
				}))()
		`);
		if (colorTokens.every(token => lastSuggestions.some(suggestion => suggestion.includes(token)))) {
			return;
		}

		await app.code.wait(100);
	}

	throw new Error(`OpenCode agent color tokens were not suggested. Last suggestions: ${lastSuggestions.join(', ')}`);
}

export function setup(logger: Logger) {
	describe('OpenCode Agent Edit Decorations Smoke', () => {
		installAllHandlers(logger);

		it('agent-edit-decorations registers startup-safe command and color tokens', async function () {
			this.timeout(30000);
			const app = this.app as Application;

			await openOpencodeSidebarShell(app);
			await app.code.wait(5000);
			await assertNoAgentEditConsoleErrors(app, 'agent edit services should not log startup errors');

			assert.ok(
				(await app.workbench.quickaccess.getVisibleCommandNames('Clear Agent Edit')).includes('OpenCode: Clear Agent Edit Highlights'),
				'OpenCode clear agent edit highlights command is visible in command palette',
			);
			await app.workbench.quickaccess.runCommand('OpenCode: Clear Agent Edit Highlights', { exactLabelMatch: true });
			await assertNoAgentEditConsoleErrors(app, 'clear agent edit highlights command should not log errors');

			await openSettingsJsonFromSettingsUI(app);
			await triggerColorCustomizationSuggestions(app);
			await waitForColorTokenSuggestions(app);
		});
	});
}
