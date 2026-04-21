/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from 'node:path';
import type { Application, Logger } from '../../../../automation';
import { ActivityBarPosition } from '../../../../automation';
import { installAllHandlers } from '../../utils';

const opencodeActivityBarSelector = '.part.activitybar [aria-label*="OpenCode"]';
const opencodeViewZoneSelector = '.monaco-editor .view-zones [data-opencode-widget-id]';
const opencodeOverlaySelector = '[data-opencode-widget-id="opencode-sample.overlay"]';
const opencodeContentSelector = '[data-opencode-widget-id="opencode-sample.content"]';

async function openAppJs(app: Application): Promise<void> {
	await app.workbench.quickaccess.openFile(join(app.workspacePathOrFolder, 'app.js'));
}

export function setup(logger: Logger) {
	describe('OpenCode Smoke', () => {
		installAllHandlers(logger);

		it('window title reflects OpenCode IDE', async function () {
			// document.title reflects workspace name in dev mode; identity verified via product.json at build time.
			this.skip();
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

		it('Activity Bar shows OpenCode icon and sidebar iframe exists', async function () {
			const app = this.app as Application;
			await app.workbench.activitybar.waitForActivityBar(ActivityBarPosition.LEFT);
			await app.code.waitForElement(opencodeActivityBarSelector, undefined, 50);
			await app.code.waitAndClick(opencodeActivityBarSelector);
			// Wait for any iframe under the sidebar container (SPA connection not required).
			await app.code.waitForElement('.part.sidebar iframe, .part.auxiliarybar iframe', undefined, 30);
		});

		it('iframe receives llm-response after llm-request', async function () {
			// requires live opencode serve backend on 127.0.0.1:4096; not available in CI.
			this.skip();
		});

		it('createDiffZone renders accept and reject buttons and reject clears the diff', async function () {
			// requires live backend + chat UI; DiffZone core tested via unit tests.
			this.skip();
		});

		it('accept applies the diff edit to the editor model', async function () {
			// requires live backend + chat UI; accept logic tested via unit tests.
			this.skip();
		});
	});
}
