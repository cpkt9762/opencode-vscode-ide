/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import type { ICodeEditor, IViewZone } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { Range } from '../../../../editor/common/core/range.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import * as nls from '../../../../nls.js';
import type { DiffEdit, DiffZoneState, DiffZoneStatus, IDiffZoneWidget, IEditCodeService } from '../common/editCodeServiceTypes.js';

const acceptLabel = nls.localize('opencode.diffZone.accept', "Accept");
const rejectLabel = nls.localize('opencode.diffZone.reject', "Reject");
const currentLabel = nls.localize('opencode.diffZone.current', "Current");
const suggestedLabel = nls.localize('opencode.diffZone.suggested', "Suggested");
const proposedEditLabel = nls.localize('opencode.diffZone.proposedEdit', "Proposed Edit");
const streamingLabel = nls.localize('opencode.diffZone.streaming', "Streaming");
const staleDiffLabel = nls.localize('opencode.diffZone.stale', "Diff is stale and can no longer be applied.");

type DiffPreview = {
	readonly id: string;
	readonly edit: DiffEdit;
	readonly originalText: string;
};

type DiffZoneEntry = {
	readonly editor: ICodeEditor;
	readonly modelId: string;
	readonly widgetDisposables: DisposableStore;
	readonly lifecycleDisposables: DisposableStore;
	readonly versionId: number;
	state: DiffZoneState;
	previews: readonly DiffPreview[];
	widgets: readonly IDiffZoneWidget[];
};

function countLines(text: string): number {
	return text ? text.split('\n').length : 0;
}

class DiffZoneWidget extends Disposable implements IDiffZoneWidget {
	private readonly domNode: HTMLElement;
	private readonly viewZone: IViewZone & { heightInLines: number };
	private viewZoneId: string | undefined;

	constructor(
		readonly id: string,
		private readonly editor: ICodeEditor,
		private readonly preview: DiffPreview,
		private readonly index: number,
		private readonly total: number,
		private readonly status: DiffZoneStatus,
		private readonly onAccept: () => void,
		private readonly onReject: () => void,
	) {
		super();
		this.domNode = document.createElement('div');
		this.viewZone = {
			afterLineNumber: Math.max(this.preview.edit.originalStartLine - 1, 0),
			heightInLines: this.computeHeightInLines(),
			domNode: this.domNode,
			showInHiddenAreas: true,
			suppressMouseDown: false,
		};
		this.render();
		this.mount();
	}

	accept(): void {
		this.onAccept();
	}

	reject(): void {
		this.onReject();
	}

	override dispose(): void {
		const viewZoneId = this.viewZoneId;
		if (viewZoneId) {
			this.editor.changeViewZones(accessor => accessor.removeZone(viewZoneId));
			this.viewZoneId = undefined;
		}

		super.dispose();
	}

	private mount(): void {
		this.editor.changeViewZones(accessor => {
			this.viewZoneId = accessor.addZone(this.viewZone);
		});
	}

	private computeHeightInLines(): number {
		const originalHeight = this.preview.originalText ? countLines(this.preview.originalText) + 1 : 0;
		const modifiedHeight = this.preview.edit.modifiedText ? countLines(this.preview.edit.modifiedText) + 1 : 0;
		return Math.max(originalHeight + modifiedHeight + 4, 5);
	}

	private createCodeBlock(label: string, text: string, background: string, border: string, foreground: string): HTMLElement {
		const block = document.createElement('div');
		block.style.cssText = `display:flex;flex-direction:column;gap:4px;padding:6px 8px;border-radius:4px;background:${background};border:1px solid ${border};`;

		const title = document.createElement('span');
		title.textContent = label;
		title.style.cssText = 'font-size:11px;font-weight:600;opacity:0.8;text-transform:uppercase;letter-spacing:0.08em;';
		block.appendChild(title);

		const code = document.createElement('pre');
		const fontInfo = this.editor.getOption(EditorOption.fontInfo);
		code.textContent = text;
		code.style.cssText = `margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:${foreground};font-family:${fontInfo.fontFamily};font-size:${fontInfo.fontSize}px;line-height:${this.editor.getOption(EditorOption.lineHeight)}px;`;
		block.appendChild(code);

		return block;
	}

	private createButton(label: string, background: string, foreground: string, handler: () => void): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = label;
		button.style.cssText = `appearance:none;border:0;border-radius:4px;padding:4px 10px;cursor:pointer;background:${background};color:${foreground};font-size:12px;font-weight:600;`;
		this._register(addDisposableListener(button, 'click', event => {
			event.preventDefault();
			event.stopPropagation();
			handler();
		}));
		return button;
	}

	private render(): void {
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		this.domNode.replaceChildren();
		this.domNode.style.cssText = `box-sizing:border-box;height:${this.viewZone.heightInLines * lineHeight}px;padding:8px 10px;display:flex;flex-direction:column;gap:8px;overflow:auto;border-radius:6px;background:var(--vscode-editorWidget-background, #1f1f1f);border:1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.08));`;

		const header = document.createElement('div');
		header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';

		const title = document.createElement('span');
		title.textContent = this.total > 1 ? `${proposedEditLabel} ${this.index + 1}/${this.total}` : proposedEditLabel;
		title.style.cssText = 'font-size:12px;font-weight:600;color:var(--vscode-editor-foreground);';
		header.appendChild(title);

		const badge = document.createElement('span');
		badge.textContent = this.status === 'streaming' ? streamingLabel : suggestedLabel;
		badge.style.cssText = `font-size:11px;padding:2px 6px;border-radius:999px;background:${this.status === 'streaming' ? 'var(--vscode-textLink-activeForeground, rgba(14, 99, 156, 0.2))' : 'var(--vscode-badge-background, rgba(90, 93, 94, 0.3))'};color:var(--vscode-badge-foreground, var(--vscode-editor-foreground));`;
		header.appendChild(badge);
		this.domNode.appendChild(header);

		if (this.preview.originalText) {
			this.domNode.appendChild(this.createCodeBlock(
				currentLabel,
				this.preview.originalText,
				'var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.12))',
				'var(--vscode-diffEditor-removedLineBorder, rgba(255, 0, 0, 0.3))',
				'var(--vscode-editor-foreground)',
			));
		}

		if (this.preview.edit.modifiedText) {
			this.domNode.appendChild(this.createCodeBlock(
				suggestedLabel,
				this.preview.edit.modifiedText,
				'var(--vscode-diffEditor-insertedTextBackground, rgba(0, 255, 0, 0.12))',
				'var(--vscode-diffEditor-insertedLineBorder, rgba(0, 255, 0, 0.3))',
				'var(--vscode-editor-foreground)',
			));
		}

		const actions = document.createElement('div');
		actions.style.cssText = 'display:flex;gap:8px;';
		actions.appendChild(this.createButton(acceptLabel, 'var(--vscode-button-background, #0e639c)', 'var(--vscode-button-foreground, #ffffff)', () => this.accept()));
		actions.appendChild(this.createButton(rejectLabel, 'var(--vscode-button-secondaryBackground, #3a3d41)', 'var(--vscode-button-secondaryForeground, #ffffff)', () => this.reject()));
		this.domNode.appendChild(actions);
	}
}

export class EditCodeService extends Disposable implements IEditCodeService {
	declare readonly _serviceBrand: undefined;

	private readonly zones = new Map<string, DiffZoneEntry>();
	private idCounter = 0;

	constructor(private readonly codeEditorService: ICodeEditorService) {
		super();
	}

	override dispose(): void {
		for (const zoneId of [...this.zones.keys()]) {
			this.disposeDiffZone(zoneId);
		}

		super.dispose();
	}

	createDiffZone(editorId: string, edits: readonly DiffEdit[], options?: { status?: 'streaming' | 'pending' }): string {
		const id = `diffzone-${this.idCounter++}`;
		this.disposeZonesForEditor(editorId);
		const entry = this.createEntry(id, editorId, edits, options?.status ?? 'pending');
		this.zones.set(id, entry);
		this.renderEntry(entry);
		return id;
	}

	updateDiffZone(zoneId: string, edits: readonly DiffEdit[], options?: { status?: 'streaming' | 'pending' }): void {
		const entry = this.zones.get(zoneId);
		if (!entry) {
			return;
		}

		const model = this.assertCurrentModel(entry);
		entry.state = {
			...entry.state,
			edits: this.normalizeEdits(model, edits),
			status: options?.status ?? (entry.state.status === 'streaming' ? 'streaming' : 'pending'),
		};
		entry.previews = this.createPreviews(model, entry.state.edits);
		this.renderEntry(entry);
	}

	acceptDiffZone(zoneId: string): void {
		const entry = this.zones.get(zoneId);
		if (!entry || entry.previews.length === 0) {
			this.disposeDiffZone(zoneId);
			return;
		}

		this.acceptPreview(zoneId, entry.previews[0].id);
	}

	rejectDiffZone(zoneId: string): void {
		const entry = this.zones.get(zoneId);
		if (!entry) {
			return;
		}

		entry.state.status = 'rejected';
		this.disposeDiffZone(zoneId);
	}

	disposeDiffZone(zoneId: string): void {
		const entry = this.zones.get(zoneId);
		if (!entry) {
			return;
		}

		this.zones.delete(zoneId);
		entry.lifecycleDisposables.dispose();
		entry.widgetDisposables.dispose();
		entry.widgets = [];
	}

	private createEntry(id: string, editorId: string, edits: readonly DiffEdit[], status: 'streaming' | 'pending'): DiffZoneEntry {
		const editor = this.resolveEditor(editorId);
		if (!editor) {
			throw new Error(`[opencode] editor not found for ${editorId}`);
		}

		const model = editor.getModel();
		if (!model) {
			throw new Error(`[opencode] editor ${editorId} has no model`);
		}

		const normalizedEdits = this.normalizeEdits(model, edits);
		const lifecycleDisposables = new DisposableStore();
		lifecycleDisposables.add(editor.onDidDispose(() => this.disposeDiffZone(id)));
		lifecycleDisposables.add(editor.onDidChangeModel(() => this.disposeDiffZone(id)));

		return {
			editor,
			modelId: model.id,
			widgetDisposables: new DisposableStore(),
			lifecycleDisposables,
			versionId: model.getVersionId(),
			state: {
				id,
				editorId,
				edits: normalizedEdits,
				status,
			},
			previews: this.createPreviews(model, normalizedEdits),
			widgets: [],
		};
	}

	private normalizeEdits(model: ITextModel, edits: readonly DiffEdit[]): readonly DiffEdit[] {
		const normalizedEdits = [...edits].sort((left, right) => left.originalStartLine - right.originalStartLine || left.originalEndLine - right.originalEndLine);
		let previousEndLine = 0;
		for (const edit of normalizedEdits) {
			if (edit.originalStartLine < 1) {
				throw new Error('[opencode] diff edits must start at line 1 or later');
			}

			if (edit.originalEndLine < edit.originalStartLine - 1) {
				throw new Error('[opencode] diff edits must be contiguous line hunks');
			}

			if (edit.originalStartLine <= previousEndLine) {
				throw new Error('[opencode] diff edits must not overlap');
			}

			if (edit.originalStartLine > model.getLineCount() + 1) {
				throw new Error('[opencode] diff edit starts outside the current model');
			}

			if (edit.originalEndLine > model.getLineCount()) {
				throw new Error('[opencode] diff edit ends outside the current model');
			}

			previousEndLine = Math.max(previousEndLine, edit.originalEndLine);
		}
		return normalizedEdits;
	}

	private createPreviews(model: ITextModel, edits: readonly DiffEdit[]): readonly DiffPreview[] {
		return edits.map((edit, index) => ({
			id: `${index}:${edit.originalStartLine}-${edit.originalEndLine}`,
			edit,
			originalText: this.getOriginalText(model, edit),
		}));
	}

	private renderEntry(entry: DiffZoneEntry): void {
		entry.widgetDisposables.clear();
		entry.widgets = entry.previews.map((preview, index) => {
			const widget = new DiffZoneWidget(
				preview.id,
				entry.editor,
				preview,
				index,
				entry.previews.length,
				entry.state.status,
				() => this.acceptPreview(entry.state.id, preview.id),
				() => this.rejectPreview(entry.state.id, preview.id),
			);
			entry.widgetDisposables.add(widget);
			return widget;
		});
	}

	private getOriginalText(model: ITextModel, edit: DiffEdit): string {
		if (edit.originalEndLine < edit.originalStartLine) {
			return '';
		}

		const startLineNumber = Math.max(1, Math.min(edit.originalStartLine, model.getLineCount()));
		const endLineNumber = Math.max(startLineNumber, Math.min(edit.originalEndLine, model.getLineCount()));
		return model.getValueInRange(new Range(startLineNumber, 1, endLineNumber, model.getLineMaxColumn(endLineNumber)));
	}

	private toModelRange(edit: DiffEdit, model: ITextModel): Range {
		if (edit.originalEndLine < edit.originalStartLine) {
			if (edit.originalStartLine > model.getLineCount()) {
				const lineNumber = model.getLineCount();
				return new Range(lineNumber, model.getLineMaxColumn(lineNumber), lineNumber, model.getLineMaxColumn(lineNumber));
			}

			const lineNumber = Math.max(1, edit.originalStartLine);
			return new Range(lineNumber, 1, lineNumber, 1);
		}

		const startLineNumber = Math.max(1, Math.min(edit.originalStartLine, model.getLineCount()));
		const endLineNumber = Math.max(startLineNumber, Math.min(edit.originalEndLine, model.getLineCount()));
		if (endLineNumber < model.getLineCount()) {
			return new Range(startLineNumber, 1, endLineNumber + 1, 1);
		}

		return new Range(startLineNumber, 1, endLineNumber, model.getLineMaxColumn(endLineNumber));
	}

	private acceptPreview(zoneId: string, previewId: string): void {
		const entry = this.zones.get(zoneId);
		if (!entry) {
			return;
		}

		const preview = entry.previews.find(candidate => candidate.id === previewId);
		if (!preview) {
			return;
		}

		const model = this.assertCurrentModel(entry);
		if (this.getOriginalText(model, preview.edit) !== preview.originalText) {
			this.disposeDiffZone(zoneId);
			throw new Error(`[opencode] ${staleDiffLabel}`);
		}

		entry.state.status = 'accepted';
		model.pushEditOperations([], [{
			range: this.toModelRange(preview.edit, model),
			text: preview.edit.modifiedText,
		}], () => null);
		this.disposeDiffZone(zoneId);
	}

	private rejectPreview(zoneId: string, previewId: string): void {
		const entry = this.zones.get(zoneId);
		if (!entry) {
			return;
		}

		const previews = entry.previews.filter(preview => preview.id !== previewId);
		if (previews.length === entry.previews.length) {
			return;
		}

		if (previews.length === 0) {
			entry.state.status = 'rejected';
			this.disposeDiffZone(zoneId);
			return;
		}

		entry.previews = previews;
		entry.state = {
			...entry.state,
			edits: previews.map(preview => preview.edit),
		};
		this.renderEntry(entry);
	}

	private assertCurrentModel(entry: DiffZoneEntry): ITextModel {
		const model = entry.editor.getModel();
		if (!model || model.id !== entry.modelId || model.getVersionId() !== entry.versionId) {
			this.disposeDiffZone(entry.state.id);
			throw new Error(`[opencode] ${staleDiffLabel}`);
		}

		return model;
	}

	private disposeZonesForEditor(editorId: string): void {
		for (const [zoneId, entry] of this.zones) {
			if (entry.state.editorId === editorId) {
				this.disposeDiffZone(zoneId);
			}
		}
	}

	private resolveEditor(editorId: string): ICodeEditor | undefined {
		const [editorOnlyId, modelId] = editorId.split(',');
		return this.codeEditorService.listCodeEditors().find(editor => {
			if (editor.getId() !== editorOnlyId) {
				return false;
			}

			if (!modelId) {
				return true;
			}

			return editor.getModel()?.id === modelId;
		});
	}
}

ICodeEditorService(EditCodeService, '', 0);
