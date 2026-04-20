/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { safeSetInnerHtml } from '../../../base/browser/domSanitize.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ContentWidgetPositionPreference, type ICodeEditor, type IContentWidget, type IContentWidgetPosition, type IOverlayWidget, type IOverlayWidgetPosition, type IViewZone, OverlayWidgetPositionPreference } from '../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../editor/common/config/editorOptions.js';
import { Position } from '../../../editor/common/core/position.js';
import { extHostNamedCustomer, type IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { type ContentWidgetPositionDTO, ExtHostContext, type ExtHostOpencodeEditorShape, MainContext, type MainThreadOpencodeEditorShape, type OverlayWidgetPositionDTO, type WidgetContentDTO } from '../common/extHost.protocol.js';

type ViewZoneEntry = {
	editor: ICodeEditor;
	domNode: HTMLElement;
	zone: IViewZone & { heightInLines: number };
	zoneId: string;
};

type OverlayWidgetEntry = {
	editor: ICodeEditor;
	domNode: HTMLElement;
	widget: IOverlayWidget;
	position: IOverlayWidgetPosition | null;
};

type ContentWidgetEntry = {
	editor: ICodeEditor;
	domNode: HTMLElement;
	widget: IContentWidget;
	position: { lineNumber: number; column: number };
};

function toOverlayWidgetPreference(preference: OverlayWidgetPositionDTO['preference']) {
	if (preference === 'TOP_RIGHT_CORNER') {
		return OverlayWidgetPositionPreference.TOP_RIGHT_CORNER;
	}

	if (preference === 'BOTTOM_RIGHT_CORNER') {
		return OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER;
	}

	return null;
}

function toOverlayWidgetPosition(position: OverlayWidgetPositionDTO): IOverlayWidgetPosition {
	return { preference: toOverlayWidgetPreference(position.preference) };
}

function toContentWidgetPosition(position: { lineNumber: number; column: number }): IContentWidgetPosition {
	return {
		position: new Position(position.lineNumber, position.column),
		preference: [ContentWidgetPositionPreference.EXACT],
	};
}

@extHostNamedCustomer(MainContext.MainThreadOpencodeEditor)
export class MainThreadOpencodeEditor extends Disposable implements MainThreadOpencodeEditorShape {
	private readonly _proxy: ExtHostOpencodeEditorShape;
	private readonly _viewZones = new Map<string, ViewZoneEntry>();
	private readonly _overlayWidgets = new Map<string, OverlayWidgetEntry>();
	private readonly _contentWidgets = new Map<string, ContentWidgetEntry>();

	constructor(
		extHostContext: IExtHostContext,
		private readonly _codeEditorService: ICodeEditorService,
	) {
		super();
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostOpencodeEditor);
		void this._proxy;
	}

	override dispose(): void {
		for (const id of [...this._viewZones.keys()]) {
			this._disposeViewZone(id);
		}

		for (const id of [...this._overlayWidgets.keys()]) {
			this._disposeOverlayWidget(id);
		}

		for (const id of [...this._contentWidgets.keys()]) {
			this._disposeContentWidget(id);
		}

		super.dispose();
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

	private _setViewZoneDomHeight(editor: ICodeEditor, domNode: HTMLElement, heightInLines: number): void {
		domNode.style.height = `${heightInLines * editor.getOption(EditorOption.lineHeight)}px`;
	}

	private _getViewZone(id: string): ViewZoneEntry {
		const entry = this._viewZones.get(id);
		if (!entry) {
			throw new Error(`[opencode] unknown view zone ${id}`);
		}
		return entry;
	}

	private _getOverlayWidget(id: string): OverlayWidgetEntry {
		const entry = this._overlayWidgets.get(id);
		if (!entry) {
			throw new Error(`[opencode] unknown overlay widget ${id}`);
		}
		return entry;
	}

	private _getContentWidget(id: string): ContentWidgetEntry {
		const entry = this._contentWidgets.get(id);
		if (!entry) {
			throw new Error(`[opencode] unknown content widget ${id}`);
		}
		return entry;
	}

	private _disposeViewZone(id: string): void {
		const entry = this._viewZones.get(id);
		if (!entry) {
			return;
		}

		this._viewZones.delete(id);
		entry.editor.changeViewZones(accessor => accessor.removeZone(entry.zoneId));
	}

	private _disposeOverlayWidget(id: string): void {
		const entry = this._overlayWidgets.get(id);
		if (!entry) {
			return;
		}

		this._overlayWidgets.delete(id);
		entry.editor.removeOverlayWidget(entry.widget);
	}

	private _disposeContentWidget(id: string): void {
		const entry = this._contentWidgets.get(id);
		if (!entry) {
			return;
		}

		this._contentWidgets.delete(id);
		entry.editor.removeContentWidget(entry.widget);
	}

	async $createViewZone(args: { id: string; editorId: string; afterLineNumber: number; heightInLines: number; content: WidgetContentDTO }): Promise<void> {
		this._disposeViewZone(args.id);
		const editor = this._resolveEditor(args.editorId);
		const domNode = this._renderContent(args.content, args.id);
		this._setViewZoneDomHeight(editor, domNode, args.heightInLines);
		const zone: IViewZone & { heightInLines: number } = {
			afterLineNumber: args.afterLineNumber,
			heightInLines: args.heightInLines,
			domNode,
		};
		const entry = { editor, domNode, zone, zoneId: '' };
		editor.changeViewZones(accessor => {
			entry.zoneId = accessor.addZone(zone);
			this._viewZones.set(args.id, entry);
		});
	}

	async $updateViewZone(id: string, content: WidgetContentDTO): Promise<void> {
		const entry = this._getViewZone(id);
		this._updateContent(entry.domNode, content, id);
		this._setViewZoneDomHeight(entry.editor, entry.domNode, entry.zone.heightInLines);
		entry.editor.changeViewZones(accessor => accessor.layoutZone(entry.zoneId));
	}

	async $setViewZoneHeight(id: string, heightInLines: number): Promise<void> {
		const entry = this._getViewZone(id);
		entry.zone.heightInLines = heightInLines;
		this._setViewZoneDomHeight(entry.editor, entry.domNode, heightInLines);
		entry.editor.changeViewZones(accessor => accessor.layoutZone(entry.zoneId));
	}

	async $disposeViewZone(id: string): Promise<void> {
		this._disposeViewZone(id);
	}

	async $createOverlayWidget(args: { id: string; editorId: string; content: WidgetContentDTO; position: OverlayWidgetPositionDTO }): Promise<void> {
		this._disposeOverlayWidget(args.id);
		const editor = this._resolveEditor(args.editorId);
		const domNode = this._renderContent(args.content, args.id);
		let entry: OverlayWidgetEntry;
		const widget: IOverlayWidget = {
			allowEditorOverflow: true,
			getId: () => `opencode.overlay.${args.id}`,
			getDomNode: () => domNode,
			getPosition: () => entry.position,
		};
		entry = { editor, domNode, widget, position: toOverlayWidgetPosition(args.position) };
		editor.addOverlayWidget(widget);
		this._overlayWidgets.set(args.id, entry);
	}

	async $updateOverlayWidget(id: string, content: WidgetContentDTO): Promise<void> {
		const entry = this._getOverlayWidget(id);
		this._updateContent(entry.domNode, content, id);
		entry.editor.layoutOverlayWidget(entry.widget);
	}

	async $updateOverlayWidgetPosition(id: string, position: OverlayWidgetPositionDTO): Promise<void> {
		const entry = this._getOverlayWidget(id);
		entry.position = toOverlayWidgetPosition(position);
		entry.editor.layoutOverlayWidget(entry.widget);
	}

	async $disposeOverlayWidget(id: string): Promise<void> {
		this._disposeOverlayWidget(id);
	}

	async $createContentWidget(args: { id: string; editorId: string; content: WidgetContentDTO; position: ContentWidgetPositionDTO }): Promise<void> {
		this._disposeContentWidget(args.id);
		const editor = this._resolveEditor(args.editorId);
		const domNode = this._renderContent(args.content, args.id);
		let entry: ContentWidgetEntry;
		const widget: IContentWidget = {
			allowEditorOverflow: true,
			suppressMouseDown: false,
			getId: () => `opencode.content.${args.id}`,
			getDomNode: () => domNode,
			getPosition: () => toContentWidgetPosition(entry.position),
		};
		entry = {
			editor,
			domNode,
			widget,
			position: { lineNumber: args.position.line, column: args.position.column },
		};
		editor.addContentWidget(widget);
		this._contentWidgets.set(args.id, entry);
	}

	async $updateContentWidget(id: string, content: WidgetContentDTO): Promise<void> {
		const entry = this._getContentWidget(id);
		this._updateContent(entry.domNode, content, id);
		entry.editor.layoutContentWidget(entry.widget);
	}

	async $updateContentWidgetPosition(id: string, position: ContentWidgetPositionDTO): Promise<void> {
		const entry = this._getContentWidget(id);
		entry.position = { lineNumber: position.line, column: position.column };
		entry.editor.layoutContentWidget(entry.widget);
	}

	async $disposeContentWidget(id: string): Promise<void> {
		this._disposeContentWidget(id);
	}
}

ICodeEditorService(MainThreadOpencodeEditor, '', 1);
