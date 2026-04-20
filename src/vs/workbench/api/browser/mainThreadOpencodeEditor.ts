/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { safeSetInnerHtml } from '../../../base/browser/domSanitize.js';
import { Disposable, DisposableMap } from '../../../base/common/lifecycle.js';
import { ContentWidgetPositionPreference, ICodeEditor, IContentWidget, IContentWidgetPosition, IOverlayWidget, IOverlayWidgetPosition, IViewZone, OverlayWidgetPositionPreference } from '../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import { Position } from '../../../editor/common/core/position.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { ContentWidgetPositionDTO, ExtHostContext, ExtHostOpencodeEditorShape, MainContext, MainThreadOpencodeEditorShape, OverlayWidgetPositionDTO, WidgetContentDTO } from '../common/extHost.protocol.js';

type MutableViewZone = IViewZone & { heightInLines: number };

class OpencodeViewZoneEntry {
	constructor(
		readonly editor: ICodeEditor,
		readonly domNode: HTMLElement,
		private readonly _zone: MutableViewZone,
		private readonly _zoneId: string,
	) {
	}

	updateHeight(heightInLines: number): void {
		this._zone.heightInLines = heightInLines;
		this.layout();
	}

	layout(): void {
		this.editor.changeViewZones(accessor => accessor.layoutZone(this._zoneId));
	}

	dispose(): void {
		this.editor.changeViewZones(accessor => accessor.removeZone(this._zoneId));
	}
}

class OpencodeOverlayWidgetEntry implements IOverlayWidget {
	allowEditorOverflow = true;
	private _position: IOverlayWidgetPosition | null;

	constructor(
		readonly editor: ICodeEditor,
		private readonly _id: string,
		private readonly _domNode: HTMLElement,
		position: OverlayWidgetPositionDTO,
	) {
		this._position = { preference: toOverlayWidgetPreference(position.preference) };
		this.editor.addOverlayWidget(this);
	}

	getId(): string {
		return this._id;
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	getPosition(): IOverlayWidgetPosition | null {
		return this._position;
	}

	updatePosition(position: OverlayWidgetPositionDTO): void {
		this._position = { preference: toOverlayWidgetPreference(position.preference) };
		this.editor.layoutOverlayWidget(this);
	}

	dispose(): void {
		this.editor.removeOverlayWidget(this);
	}
}

class OpencodeContentWidgetEntry implements IContentWidget {
	allowEditorOverflow = true;
	suppressMouseDown = false;
	private _position: IContentWidgetPosition | null;

	constructor(
		readonly editor: ICodeEditor,
		private readonly _id: string,
		private readonly _domNode: HTMLElement,
		position: ContentWidgetPositionDTO,
	) {
		this._position = toContentWidgetPosition(position);
		this.editor.addContentWidget(this);
	}

	getId(): string {
		return this._id;
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	getPosition(): IContentWidgetPosition | null {
		return this._position;
	}

	updatePosition(position: ContentWidgetPositionDTO): void {
		this._position = toContentWidgetPosition(position);
		this.editor.layoutContentWidget(this);
	}

	dispose(): void {
		this.editor.removeContentWidget(this);
	}
}

function toOverlayWidgetPreference(preference: OverlayWidgetPositionDTO['preference']) {
	if (preference === 'TOP_RIGHT_CORNER') {
		return OverlayWidgetPositionPreference.TOP_RIGHT_CORNER;
	}

	if (preference === 'BOTTOM_RIGHT_CORNER') {
		return OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER;
	}

	return null;
}

function toContentWidgetPosition(position: ContentWidgetPositionDTO): IContentWidgetPosition {
	return {
		position: new Position(position.line, position.column),
		preference: [ContentWidgetPositionPreference.EXACT],
	};
}

@extHostNamedCustomer(MainContext.MainThreadOpencodeEditor)
export class MainThreadOpencodeEditor extends Disposable implements MainThreadOpencodeEditorShape {
	private readonly _proxy: ExtHostOpencodeEditorShape;
	private readonly _viewZones = this._register(new DisposableMap<string, OpencodeViewZoneEntry>());
	private readonly _overlays = this._register(new DisposableMap<string, OpencodeOverlayWidgetEntry>());
	private readonly _contents = this._register(new DisposableMap<string, OpencodeContentWidgetEntry>());

	constructor(
		extHostContext: IExtHostContext,
		private readonly _codeEditorService: ICodeEditorService,
	) {
		super();
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostOpencodeEditor);
		void this._proxy;
	}

	private _resolveEditor(compositeId: string): ICodeEditor {
		const [editorId, modelId] = compositeId.split(',');
		if (!editorId || !modelId) {
			throw new Error(`[opencode] malformed composite editor id: ${compositeId}`);
		}

		const editor = this._codeEditorService.listCodeEditors().find(candidate => candidate.getId() === editorId && candidate.getModel()?.id === modelId);
		if (!editor) {
			throw new Error(`[opencode] editor not found for composite id ${compositeId}`);
		}

		return editor;
	}

	private _renderContent(content: WidgetContentDTO, widgetId: string): HTMLElement {
		const host = document.createElement('div');
		this._updateContent(host, content, widgetId);
		return host;
	}

	private _updateContent(host: HTMLElement, content: WidgetContentDTO, widgetId: string): void {
		host.dataset.opencodeWidgetId = widgetId;
		host.style.cssText = '';
		safeSetInnerHtml(host, content.html);
		for (const [cssProperty, value] of Object.entries(content.style ?? {})) {
			host.style.setProperty(cssProperty, value);
		}
	}

	private _getViewZone(id: string): OpencodeViewZoneEntry {
		const entry = this._viewZones.get(id);
		if (!entry) {
			throw new Error(`[opencode] unknown view zone ${id}`);
		}
		return entry;
	}

	private _getOverlay(id: string): OpencodeOverlayWidgetEntry {
		const entry = this._overlays.get(id);
		if (!entry) {
			throw new Error(`[opencode] unknown overlay widget ${id}`);
		}
		return entry;
	}

	private _getContent(id: string): OpencodeContentWidgetEntry {
		const entry = this._contents.get(id);
		if (!entry) {
			throw new Error(`[opencode] unknown content widget ${id}`);
		}
		return entry;
	}

	async $createViewZone(args: { id: string; editorId: string; afterLineNumber: number; heightInLines: number; content: WidgetContentDTO }): Promise<void> {
		console.log(`[mainThreadOpencodeEditor] $createViewZone id=${args.id}`);
		const editor = this._resolveEditor(args.editorId);
		const domNode = this._renderContent(args.content, args.id);
		const zone: MutableViewZone = {
			afterLineNumber: args.afterLineNumber,
			heightInLines: args.heightInLines,
			domNode,
		};
		let zoneId = '';
		editor.changeViewZones(accessor => {
			zoneId = accessor.addZone(zone);
		});
		this._viewZones.set(args.id, new OpencodeViewZoneEntry(editor, domNode, zone, zoneId));
	}

	async $updateViewZone(id: string, content: WidgetContentDTO): Promise<void> {
		console.log(`[mainThreadOpencodeEditor] $updateViewZone id=${id}`);
		const entry = this._getViewZone(id);
		this._updateContent(entry.domNode, content, id);
		entry.layout();
	}

	async $setViewZoneHeight(id: string, heightInLines: number): Promise<void> {
		console.log(`[mainThreadOpencodeEditor] $setViewZoneHeight id=${id}`);
		this._getViewZone(id).updateHeight(heightInLines);
	}

	async $disposeViewZone(id: string): Promise<void> {
		console.log(`[mainThreadOpencodeEditor] $disposeViewZone id=${id}`);
		this._viewZones.deleteAndDispose(id);
	}

	async $createOverlayWidget(args: { id: string; editorId: string; content: WidgetContentDTO; position: OverlayWidgetPositionDTO }): Promise<void> {
		console.log(`[mainThreadOpencodeEditor] $createOverlayWidget id=${args.id}`);
		const editor = this._resolveEditor(args.editorId);
		const domNode = this._renderContent(args.content, args.id);
		this._overlays.set(args.id, new OpencodeOverlayWidgetEntry(editor, args.id, domNode, args.position));
	}

	async $updateOverlayWidget(id: string, content: WidgetContentDTO): Promise<void> {
		console.log(`[mainThreadOpencodeEditor] $updateOverlayWidget id=${id}`);
		const entry = this._getOverlay(id);
		this._updateContent(entry.getDomNode(), content, id);
		entry.editor.layoutOverlayWidget(entry);
	}

	async $updateOverlayWidgetPosition(id: string, position: OverlayWidgetPositionDTO): Promise<void> {
		console.log(`[mainThreadOpencodeEditor] $updateOverlayWidgetPosition id=${id}`);
		this._getOverlay(id).updatePosition(position);
	}

	async $disposeOverlayWidget(id: string): Promise<void> {
		console.log(`[mainThreadOpencodeEditor] $disposeOverlayWidget id=${id}`);
		this._overlays.deleteAndDispose(id);
	}

	async $createContentWidget(args: { id: string; editorId: string; content: WidgetContentDTO; position: ContentWidgetPositionDTO }): Promise<void> {
		console.log(`[mainThreadOpencodeEditor] $createContentWidget id=${args.id}`);
		const editor = this._resolveEditor(args.editorId);
		const domNode = this._renderContent(args.content, args.id);
		this._contents.set(args.id, new OpencodeContentWidgetEntry(editor, args.id, domNode, args.position));
	}

	async $updateContentWidget(id: string, content: WidgetContentDTO): Promise<void> {
		console.log(`[mainThreadOpencodeEditor] $updateContentWidget id=${id}`);
		const entry = this._getContent(id);
		this._updateContent(entry.getDomNode(), content, id);
		entry.editor.layoutContentWidget(entry);
	}

	async $updateContentWidgetPosition(id: string, position: ContentWidgetPositionDTO): Promise<void> {
		console.log(`[mainThreadOpencodeEditor] $updateContentWidgetPosition id=${id}`);
		this._getContent(id).updatePosition(position);
	}

	async $disposeContentWidget(id: string): Promise<void> {
		console.log(`[mainThreadOpencodeEditor] $disposeContentWidget id=${id}`);
		this._contents.deleteAndDispose(id);
	}
}

ICodeEditorService(MainThreadOpencodeEditor, '', 1);
