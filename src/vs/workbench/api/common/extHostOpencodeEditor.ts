/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { MainContext, type ContentWidgetPositionDTO, type ExtHostOpencodeEditorShape, type IMainContext, type MainThreadOpencodeEditorShape, type OverlayWidgetPositionDTO, type WidgetContentDTO } from './extHost.protocol.js';
import type { ExtHostDocumentsAndEditors } from './extHostDocumentsAndEditors.js';

class ExtHostOpencodeViewZone implements vscode.opencodeEditor.OpencodeViewZone {
	private readonly _store = new DisposableStore();
	private _heightInLines: number;

	constructor(
		private readonly _proxy: MainThreadOpencodeEditorShape,
		readonly id: string,
		readonly afterLineNumber: number,
		heightInLines: number,
	) {
		this._heightInLines = heightInLines;
		this._store.add({
			dispose: () => void this._proxy.$disposeViewZone(this.id),
		});
	}

	get heightInLines(): number {
		return this._heightInLines;
	}

	set heightInLines(value: number) {
		this._heightInLines = value;
		console.log('[extHostOpencodeEditor]', 'set view zone height', this.id, value);
		void this._proxy.$setViewZoneHeight(this.id, value);
	}

	setContent(content: vscode.opencodeEditor.WidgetContent): Thenable<void> {
		console.log('[extHostOpencodeEditor]', 'set view zone content', this.id, content);
		return this._proxy.$updateViewZone(this.id, content);
	}

	dispose(): void {
		console.log('[extHostOpencodeEditor]', 'dispose view zone', this.id);
		this._store.dispose();
	}
}

class ExtHostOpencodeOverlayWidget implements vscode.opencodeEditor.OpencodeOverlayWidget {
	private readonly _store = new DisposableStore();

	constructor(
		private readonly _proxy: MainThreadOpencodeEditorShape,
		readonly id: string,
	) {
		this._store.add({
			dispose: () => void this._proxy.$disposeOverlayWidget(this.id),
		});
	}

	setPosition(position: OverlayWidgetPositionDTO): Thenable<void> {
		console.log('[extHostOpencodeEditor]', 'set overlay widget position', this.id, position);
		return this._proxy.$updateOverlayWidgetPosition(this.id, position);
	}

	setContent(content: vscode.opencodeEditor.WidgetContent): Thenable<void> {
		console.log('[extHostOpencodeEditor]', 'set overlay widget content', this.id, content);
		return this._proxy.$updateOverlayWidget(this.id, content);
	}

	dispose(): void {
		console.log('[extHostOpencodeEditor]', 'dispose overlay widget', this.id);
		this._store.dispose();
	}
}

class ExtHostOpencodeContentWidget implements vscode.opencodeEditor.OpencodeContentWidget {
	private readonly _store = new DisposableStore();

	constructor(
		private readonly _proxy: MainThreadOpencodeEditorShape,
		readonly id: string,
	) {
		this._store.add({
			dispose: () => void this._proxy.$disposeContentWidget(this.id),
		});
	}

	setPosition(line: number, column: number): Thenable<void> {
		console.log('[extHostOpencodeEditor]', 'set content widget position', this.id, { line, column });
		return this._proxy.$updateContentWidgetPosition(this.id, { line, column });
	}

	setContent(content: vscode.opencodeEditor.WidgetContent): Thenable<void> {
		console.log('[extHostOpencodeEditor]', 'set content widget content', this.id, content);
		return this._proxy.$updateContentWidget(this.id, content);
	}

	dispose(): void {
		console.log('[extHostOpencodeEditor]', 'dispose content widget', this.id);
		this._store.dispose();
	}
}

export class ExtHostOpencodeEditor implements ExtHostOpencodeEditorShape {
	readonly _extHostOpencodeEditorShapeBrand = undefined;
	private readonly _proxy: MainThreadOpencodeEditorShape;

	constructor(
		mainContext: IMainContext,
		private readonly _editors: ExtHostDocumentsAndEditors,
	) {
		this._proxy = mainContext.getProxy(MainContext.MainThreadOpencodeEditor);
	}

	private _editorId(editor: vscode.TextEditor): string {
		const match = this._editors.allEditors().find(candidate => candidate.value === editor);
		if (!match) {
			throw new Error('[opencode] editor not found in extHost registry');
		}
		return match.id;
	}

	async createViewZone(
		editor: vscode.TextEditor,
		options: {
			afterLineNumber: number;
			heightInLines: number;
			content: WidgetContentDTO;
		},
	): Promise<vscode.opencodeEditor.OpencodeViewZone> {
		const id = generateUuid();
		const editorId = this._editorId(editor);
		console.log('[extHostOpencodeEditor]', 'create view zone', { id, editorId, options });
		await this._proxy.$createViewZone({ id, editorId, ...options });
		return new ExtHostOpencodeViewZone(this._proxy, id, options.afterLineNumber, options.heightInLines);
	}

	async createOverlayWidget(
		editor: vscode.TextEditor,
		options: {
			id: string;
			content: WidgetContentDTO;
			position: { preference: 'TOP_RIGHT_CORNER' | 'BOTTOM_RIGHT_CORNER' };
		},
	): Promise<vscode.opencodeEditor.OpencodeOverlayWidget> {
		const id = options.id || generateUuid();
		const editorId = this._editorId(editor);
		console.log('[extHostOpencodeEditor]', 'create overlay widget', { id, editorId, options });
		await this._proxy.$createOverlayWidget({
			id,
			editorId,
			content: options.content,
			position: options.position,
		});
		return new ExtHostOpencodeOverlayWidget(this._proxy, id);
	}

	async createContentWidget(
		editor: vscode.TextEditor,
		options: {
			id: string;
			content: WidgetContentDTO;
			position: ContentWidgetPositionDTO;
		},
	): Promise<vscode.opencodeEditor.OpencodeContentWidget> {
		const id = options.id || generateUuid();
		const editorId = this._editorId(editor);
		console.log('[extHostOpencodeEditor]', 'create content widget', { id, editorId, options });
		await this._proxy.$createContentWidget({
			id,
			editorId,
			content: options.content,
			position: options.position,
		});
		return new ExtHostOpencodeContentWidget(this._proxy, id);
	}
}
