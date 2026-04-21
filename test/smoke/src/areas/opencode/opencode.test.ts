/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { join } from 'node:path';
import type { Application, Logger } from '../../../../automation';
import { ActivityBarPosition } from '../../../../automation';
import { installAllHandlers } from '../../utils';

type OpencodeMessage = {
	type: string;
	id?: string;
	payload?: Record<string, unknown>;
};

const opencodeActivityBarSelector = '.part.activitybar [aria-label*="OpenCode"]';
const opencodeViewZoneSelector = '.monaco-editor .view-zones [data-opencode-widget-id]';
const opencodeOverlaySelector = '[data-opencode-widget-id="opencode-sample.overlay"]';
const opencodeContentSelector = '[data-opencode-widget-id="opencode-sample.content"]';

async function openAppJs(app: Application): Promise<void> {
	await app.workbench.quickaccess.openFile(join(app.workspacePathOrFolder, 'app.js'));
}

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
	await app.code.driver.evaluateExpression(`
		(async () => {
			const deadline = Date.now() + 10000;
			while (Date.now() < deadline) {
				const iframe = [...document.querySelectorAll('iframe')].find(candidate => candidate.contentDocument?.getElementById('opencode-fallback'));
				if (iframe?.contentWindow && iframe.contentDocument?.readyState === 'complete') {
					return true;
				}
				await new Promise(resolve => setTimeout(resolve, 100));
			}

			throw new Error('OpenCode iframe did not finish loading');
		})()
	`);
}

async function postFromOpencodeIframe<T>(app: Application, message: OpencodeMessage, responseType: string): Promise<T> {
	return await app.code.driver.evaluateExpression(`
		(async () => {
			const iframe = [...document.querySelectorAll('iframe')].find(candidate => candidate.contentDocument?.getElementById('opencode-fallback'));
			if (!iframe?.contentWindow || !iframe.contentDocument?.body) {
				throw new Error('OpenCode iframe is not ready');
			}

			return await new Promise((resolve, reject) => {
				const cleanup = () => {
					clearTimeout(timer);
					window.removeEventListener('message', onMessage);
				};

				const onMessage = event => {
					if (event.source !== iframe.contentWindow || event.data?.type !== ${JSON.stringify(responseType)}) {
						return;
					}

					cleanup();
					resolve(event.data);
				};

				const timer = setTimeout(() => {
					cleanup();
					reject(new Error('Timed out waiting for ${responseType}'));
				}, 10000);

				window.addEventListener('message', onMessage);

				const script = iframe.contentDocument.createElement('script');
				script.textContent = ${JSON.stringify(`window.parent.postMessage(${JSON.stringify(message)}, '*');`)};
				iframe.contentDocument.body.appendChild(script);
				script.remove();
			});
		})()
	`) as T;
}

async function getActiveEditorCompositeId(app: Application): Promise<string> {
	return await app.code.driver.evaluateExpression(`
		(() => {
			const editors = globalThis.monaco?.editor?.getEditors?.() ?? [];
			const editor = editors.find(candidate => candidate.hasTextFocus?.() || candidate.hasWidgetFocus?.()) ?? editors[0];
			const model = editor?.getModel?.();
			if (!editor || !model) {
				throw new Error('No active Monaco editor found for diff zone smoke test');
			}

			return editor.getId() + ',' + model.id;
		})()
	`);
}

export function setup(logger: Logger) {
	describe('OpenCode Smoke', () => {
		installAllHandlers(logger);

		it('window title reflects OpenCode IDE', async function () {
			const app = this.app as Application;
			const title = await app.code.driver.evaluateExpression<string>('document.title');
			assert.ok(title.toLowerCase().includes('opencode'), `Expected document title to include opencode, got: ${title}`);
		});

		it('sample ext createViewZone command renders and disposes a view zone', async function () {
			const app = this.app as Application;
			await openAppJs(app);
			await app.workbench.quickaccess.runCommand('OpenCode: Create ViewZone', { exactLabelMatch: true });

			await app.code.waitForTextContent(opencodeViewZoneSelector, undefined, text => text.includes('OpenCode ViewZone'), 50);
			await app.workbench.quickaccess.runCommand('OpenCode: Dispose ViewZone', { exactLabelMatch: true });
			await app.code.waitForElement(opencodeViewZoneSelector, element => !element, 50);
		});

		it('sample ext createOverlayWidget command renders and disposes an overlay widget', async function () {
			const app = this.app as Application;
			await openAppJs(app);
			await app.workbench.quickaccess.runCommand('OpenCode: Create OverlayWidget', { exactLabelMatch: true });

			await app.code.waitForTextContent(opencodeOverlaySelector, undefined, text => text.includes('OpenCode Overlay'), 50);
			await app.workbench.quickaccess.runCommand('OpenCode: Dispose OverlayWidget', { exactLabelMatch: true });
			await app.code.waitForElement(opencodeOverlaySelector, element => !element, 50);
		});

		it('sample ext createContentWidget command renders and disposes a content widget', async function () {
			const app = this.app as Application;
			await openAppJs(app);
			await app.workbench.quickaccess.runCommand('OpenCode: Create ContentWidget', { exactLabelMatch: true });

			await app.code.waitForTextContent(opencodeContentSelector, undefined, text => text.includes('OpenCode Content'), 50);
			await app.workbench.quickaccess.runCommand('OpenCode: Dispose ContentWidget', { exactLabelMatch: true });
			await app.code.waitForElement(opencodeContentSelector, element => !element, 50);
		});

		it('Activity Bar shows OpenCode icon and clicking it opens the sidebar iframe', async function () {
			const app = this.app as Application;
			await openOpencodeSidebar(app);

			const sidebar = await app.code.driver.evaluateExpression<{ hasFallback: boolean; iframeCount: number }>(`
				(() => {
					const iframe = [...document.querySelectorAll('iframe')].find(candidate => candidate.contentDocument?.getElementById('opencode-fallback'));
					return {
						hasFallback: !!iframe?.contentDocument?.getElementById('opencode-fallback'),
						iframeCount: document.querySelectorAll('iframe').length,
					};
				})()
			`);

			assert.ok(sidebar.hasFallback, `Expected OpenCode iframe fallback content to exist, saw ${JSON.stringify(sidebar)}`);
		});

		it('iframe receives llm-response after llm-request', async function () {
			this.timeout(30000);
			const app = this.app as Application;
			await openOpencodeSidebar(app);

			const response = await postFromOpencodeIframe<{ payload?: { response?: string } }>(app, {
				type: 'llm-request',
				id: 'smoke-llm',
				payload: { prompt: 'hello smoke' },
			}, 'llm-response');

			assert.strictEqual(response.payload?.response, '[stub] LLM response for: hello smoke');
		});

		it('createDiffZone renders accept and reject buttons and reject clears the diff', async function () {
			this.timeout(30000);
			const app = this.app as Application;
			await openAppJs(app);
			await openOpencodeSidebar(app);

			const editorId = await getActiveEditorCompositeId(app);
			const modifiedText = 'const opencodeSmokeReject = true;';

			await postFromOpencodeIframe<{ payload?: { zoneId?: string } }>(app, {
				type: 'apply-diff-edit',
				id: 'smoke-diff-reject',
				payload: {
					editorId,
					edits: [{
						originalStartLine: 1,
						originalEndLine: 1,
						modifiedText,
					}],
				},
			}, 'diff-zone-created');

			await app.code.waitForTextContent('.monaco-editor .view-zones', undefined, text => text.includes('Proposed Edit') && text.includes('Accept') && text.includes('Reject'), 50);
			await app.code.driver.evaluateExpression(`
				(() => {
					const button = [...document.querySelectorAll('.monaco-editor .view-zones button')].find(candidate => candidate.textContent === 'Reject');
					if (!button) {
						throw new Error('Reject button not found');
					}

					button.click();
				})()
			`);

			await app.code.waitForElement('.monaco-editor .view-zones button', element => !element, 50);
			await app.workbench.editor.waitForEditorContents('app.js', contents => !contents.includes(modifiedText));
		});

		it('accept applies the diff edit to the editor model', async function () {
			this.timeout(30000);
			const app = this.app as Application;
			await openAppJs(app);
			await openOpencodeSidebar(app);

			const editorId = await getActiveEditorCompositeId(app);
			const modifiedText = 'const opencodeSmokeAccept = true;';

			await postFromOpencodeIframe<{ payload?: { zoneId?: string } }>(app, {
				type: 'apply-diff-edit',
				id: 'smoke-diff-accept',
				payload: {
					editorId,
					edits: [{
						originalStartLine: 1,
						originalEndLine: 1,
						modifiedText,
					}],
				},
			}, 'diff-zone-created');

			await app.code.waitForTextContent('.monaco-editor .view-zones', undefined, text => text.includes('Proposed Edit') && text.includes('Accept') && text.includes('Reject'), 50);
			await app.code.driver.evaluateExpression(`
				(() => {
					const button = [...document.querySelectorAll('.monaco-editor .view-zones button')].find(candidate => candidate.textContent === 'Accept');
					if (!button) {
						throw new Error('Accept button not found');
					}

					button.click();
				})()
			`);

			await app.code.waitForElement('.monaco-editor .view-zones button', element => !element, 50);
			await app.workbench.editor.waitForEditorContents('app.js', contents => contents.includes(modifiedText));
		});
	});
}
