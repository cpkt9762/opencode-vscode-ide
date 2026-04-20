/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from "vscode";
import { DisposableStore } from "../../../base/common/lifecycle.js";
import { generateUuid } from "../../../base/common/uuid.js";
import type { ExtHostDocumentsAndEditors } from "./extHostDocumentsAndEditors.js";

interface MainContextLike {
	getProxy<T>(_identifier: unknown): T;
}

export interface ExtHostOpencodeEditorShape {
	readonly _extHostOpencodeEditorShapeBrand?: never;
}

interface WidgetContent {
	html: string;
	style?: { readonly [cssProperty: string]: string };
	commands?: ReadonlyArray<{
		selector: string;
		event: "click" | "keydown";
		command: string;
		args?: unknown[];
	}>;
}

interface OpencodeViewZone {
	readonly id: string;
	readonly afterLineNumber: number;
	heightInLines: number;
	setContent(content: WidgetContent): Thenable<void>;
	dispose(): void;
}

interface OpencodeOverlayWidget {
	readonly id: string;
	setPosition(position: {
		preference: "TOP_RIGHT_CORNER" | "BOTTOM_RIGHT_CORNER" | null;
	}): Thenable<void>;
	setContent(content: WidgetContent): Thenable<void>;
	dispose(): void;
}

interface OpencodeContentWidget {
	readonly id: string;
	setPosition(line: number, column: number): Thenable<void>;
	setContent(content: WidgetContent): Thenable<void>;
	dispose(): void;
}

interface MainThreadOpencodeEditorShape {
	$createViewZone(args: {
		id: string;
		editorId: string;
		afterLineNumber: number;
		heightInLines: number;
		content: WidgetContent;
	}): Promise<void>;
	$updateViewZone(id: string, content: WidgetContent): Promise<void>;
	$setViewZoneHeight(id: string, heightInLines: number): Promise<void>;
	$disposeViewZone(id: string): Promise<void>;
	$createOverlayWidget(args: {
		id: string;
		editorId: string;
		content: WidgetContent;
		position: { preference: "TOP_RIGHT_CORNER" | "BOTTOM_RIGHT_CORNER" };
	}): Promise<void>;
	$updateOverlayWidgetPosition(
		id: string,
		position: {
			preference: "TOP_RIGHT_CORNER" | "BOTTOM_RIGHT_CORNER" | null;
		},
	): Promise<void>;
	$updateOverlayWidgetContent(id: string, content: WidgetContent): Promise<void>;
	$disposeOverlayWidget(id: string): Promise<void>;
	$createContentWidget(args: {
		id: string;
		editorId: string;
		content: WidgetContent;
		position: { line: number; column: number };
	}): Promise<void>;
	$updateContentWidgetPosition(
		id: string,
		position: { line: number; column: number },
	): Promise<void>;
	$updateContentWidgetContent(id: string, content: WidgetContent): Promise<void>;
	$disposeContentWidget(id: string): Promise<void>;
}

function createStubMainThreadOpencodeEditorProxy(): MainThreadOpencodeEditorShape {
	const log = (method: string, ...args: unknown[]) => {
		console.log("[extHostOpencodeEditor]", method, ...args);
		return Promise.resolve();
	};

	return {
		$createViewZone: (args) => log("$createViewZone", args),
		$updateViewZone: (id, content) => log("$updateViewZone", id, content),
		$setViewZoneHeight: (id, heightInLines) =>
			log("$setViewZoneHeight", id, heightInLines),
		$disposeViewZone: (id) => log("$disposeViewZone", id),
		$createOverlayWidget: (args) => log("$createOverlayWidget", args),
		$updateOverlayWidgetPosition: (id, position) =>
			log("$updateOverlayWidgetPosition", id, position),
		$updateOverlayWidgetContent: (id, content) =>
			log("$updateOverlayWidgetContent", id, content),
		$disposeOverlayWidget: (id) => log("$disposeOverlayWidget", id),
		$createContentWidget: (args) => log("$createContentWidget", args),
		$updateContentWidgetPosition: (id, position) =>
			log("$updateContentWidgetPosition", id, position),
		$updateContentWidgetContent: (id, content) =>
			log("$updateContentWidgetContent", id, content),
		$disposeContentWidget: (id) => log("$disposeContentWidget", id),
	};
}

class ExtHostOpencodeViewZone implements OpencodeViewZone {
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
		console.log("[extHostOpencodeEditor]", "set view zone height", this.id, value);
		void this._proxy.$setViewZoneHeight(this.id, value);
	}

	setContent(content: WidgetContent): Thenable<void> {
		console.log("[extHostOpencodeEditor]", "set view zone content", this.id, content);
		return this._proxy.$updateViewZone(this.id, content);
	}

	dispose(): void {
		console.log("[extHostOpencodeEditor]", "dispose view zone", this.id);
		this._store.dispose();
	}
}

class ExtHostOpencodeOverlayWidget implements OpencodeOverlayWidget {
	private readonly _store = new DisposableStore();

	constructor(
		private readonly _proxy: MainThreadOpencodeEditorShape,
		readonly id: string,
	) {
		this._store.add({
			dispose: () => void this._proxy.$disposeOverlayWidget(this.id),
		});
	}

	setPosition(position: {
		preference: "TOP_RIGHT_CORNER" | "BOTTOM_RIGHT_CORNER" | null;
	}): Thenable<void> {
		console.log(
			"[extHostOpencodeEditor]",
			"set overlay widget position",
			this.id,
			position,
		);
		return this._proxy.$updateOverlayWidgetPosition(this.id, position);
	}

	setContent(content: WidgetContent): Thenable<void> {
		console.log(
			"[extHostOpencodeEditor]",
			"set overlay widget content",
			this.id,
			content,
		);
		return this._proxy.$updateOverlayWidgetContent(this.id, content);
	}

	dispose(): void {
		console.log("[extHostOpencodeEditor]", "dispose overlay widget", this.id);
		this._store.dispose();
	}
}

class ExtHostOpencodeContentWidget implements OpencodeContentWidget {
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
		console.log(
			"[extHostOpencodeEditor]",
			"set content widget position",
			this.id,
			{ line, column },
		);
		return this._proxy.$updateContentWidgetPosition(this.id, { line, column });
	}

	setContent(content: WidgetContent): Thenable<void> {
		console.log(
			"[extHostOpencodeEditor]",
			"set content widget content",
			this.id,
			content,
		);
		return this._proxy.$updateContentWidgetContent(this.id, content);
	}

	dispose(): void {
		console.log("[extHostOpencodeEditor]", "dispose content widget", this.id);
		this._store.dispose();
	}
}

export class ExtHostOpencodeEditor implements ExtHostOpencodeEditorShape {
	readonly _extHostOpencodeEditorShapeBrand = undefined;
	private readonly _proxy: MainThreadOpencodeEditorShape;

	constructor(
		_mainContext: MainContextLike,
		private readonly _editors: ExtHostDocumentsAndEditors,
	) {
		void _mainContext;
		this._proxy = createStubMainThreadOpencodeEditorProxy();
	}

	private _editorId(editor: vscode.TextEditor): string {
		const match = this._editors
			.allEditors()
			.find((candidate) => candidate.value === editor);
		if (!match) {
			throw new Error("[opencode] editor not found in extHost registry");
		}
		return match.id;
	}

	async createViewZone(
		editor: vscode.TextEditor,
		options: {
			afterLineNumber: number;
			heightInLines: number;
			content: WidgetContent;
		},
	): Promise<OpencodeViewZone> {
		const id = generateUuid();
		const editorId = this._editorId(editor);
		console.log("[extHostOpencodeEditor]", "create view zone", {
			id,
			editorId,
			options,
		});
		await this._proxy.$createViewZone({ id, editorId, ...options });
		return new ExtHostOpencodeViewZone(
			this._proxy,
			id,
			options.afterLineNumber,
			options.heightInLines,
		);
	}

	async createOverlayWidget(
		editor: vscode.TextEditor,
		options: {
			id: string;
			content: WidgetContent;
			position: { preference: "TOP_RIGHT_CORNER" | "BOTTOM_RIGHT_CORNER" };
		},
	): Promise<OpencodeOverlayWidget> {
		const id = options.id || generateUuid();
		const editorId = this._editorId(editor);
		console.log("[extHostOpencodeEditor]", "create overlay widget", {
			id,
			editorId,
			options,
		});
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
			content: WidgetContent;
			position: { line: number; column: number };
		},
	): Promise<OpencodeContentWidget> {
		const id = options.id || generateUuid();
		const editorId = this._editorId(editor);
		console.log("[extHostOpencodeEditor]", "create content widget", {
			id,
			editorId,
			options,
		});
		await this._proxy.$createContentWidget({
			id,
			editorId,
			content: options.content,
			position: options.position,
		});
		return new ExtHostOpencodeContentWidget(this._proxy, id);
	}
}
