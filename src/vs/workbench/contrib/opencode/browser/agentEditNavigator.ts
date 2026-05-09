/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { isCodeEditor, isDiffEditor } from '../../../../editor/browser/editorBrowser.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IAgentEditTracker } from '../common/agentEditTracker.js';

export class AgentEditNavigator extends Disposable {
	constructor(
		private readonly editorService: IEditorService,
		private readonly tracker: IAgentEditTracker,
	) {
		super();
		this._register(editorService.onDidActiveEditorChange(() => this.onActiveEditorChanged()));
	}

	private onActiveEditorChanged(): void {
		const activeEditor = this.editorService.activeEditor;
		if (!activeEditor) {
			return;
		}

		const uri = activeEditor.resource;
		if (!uri) {
			return;
		}

		if ((activeEditor as { readonly preview?: boolean }).preview === true) {
			return;
		}

		const codeEditor = this.editorService.activeTextEditorControl;
		if (isDiffEditor(codeEditor)) {
			return;
		}

		if (!isCodeEditor(codeEditor)) {
			return;
		}

		const entry = this.tracker.getEntry(uri);
		if (!entry || entry.status === 'viewed') {
			return;
		}

		if (entry.hunks.length === 0) {
			this.tracker.markViewed(uri);
			return;
		}

		const hunk = entry.hunks[entry.hunks.length - 1];
		codeEditor.revealRangeInCenter(new Range(hunk.modifiedStartLine, 1, hunk.modifiedStartLine + hunk.modifiedLineCount, 1));
		this.tracker.markViewed(uri);
	}
}

IEditorService(AgentEditNavigator, undefined, 0);
IAgentEditTracker(AgentEditNavigator, undefined, 1);
