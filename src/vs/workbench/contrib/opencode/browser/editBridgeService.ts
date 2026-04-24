/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import {
	type ApplyEditRequest,
	type ApplyEditResponse,
	type ApplyPatchRequest,
	type ApplyPatchResponse,
	type ApplyWriteRequest,
	IEditBridgeService,
	type ReadBufferResponse,
} from '../common/editBridgeTypes.js';
import { type DiffEdit, IEditCodeService } from '../common/editCodeServiceTypes.js';

type PendingEdit = {
	readonly filePath: string;
	readonly newContent: string;
};

type DiffZoneWidgetLike = {
	accept(): void;
	reject(): void;
	dispose(): void;
	__opencodeEditBridgeWrapped?: boolean;
};

type DiffZoneEntryLike = {
	readonly widgets: readonly DiffZoneWidgetLike[];
};

type InternalEditCodeService = IEditCodeService & {
	readonly zones?: Map<string, DiffZoneEntryLike>;
};

function normalizePath(filePath: string): string {
	return filePath;
}

class StagedContentStore {
	private readonly contents = new Map<string, string>();

	set(filePath: string, content: string): void {
		this.contents.set(normalizePath(filePath), content);
	}

	get(filePath: string): string | undefined {
		return this.contents.get(normalizePath(filePath));
	}

	clearOne(filePath: string): void {
		this.contents.delete(normalizePath(filePath));
	}

	clearAll(): void {
		this.contents.clear();
	}
}

class PendingEditsRegistry {
	private readonly entries = new Map<string, PendingEdit>();

	set(zoneId: string, entry: PendingEdit): void {
		this.entries.set(zoneId, entry);
	}

	get(zoneId: string): PendingEdit | undefined {
		return this.entries.get(zoneId);
	}

	delete(zoneId: string): boolean {
		return this.entries.delete(zoneId);
	}

	hasPendingForFile(filePath: string): boolean {
		const normalizedPath = normalizePath(filePath);
		for (const entry of this.entries.values()) {
			if (normalizePath(entry.filePath) === normalizedPath) {
				return true;
			}
		}

		return false;
	}

	zoneIds(): readonly string[] {
		return [...this.entries.keys()];
	}

	clearAll(): void {
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}
}

function parseUnifiedDiff(diff: string): readonly DiffEdit[] {
	const edits: DiffEdit[] = [];
	let originalLine = 0;
	let editStartLine: number | undefined;
	let removed: string[] = [];
	let added: string[] = [];
	const flushEdit = () => {
		if (editStartLine === undefined) {
			return;
		}

		edits.push({
			originalStartLine: editStartLine,
			originalEndLine: removed.length === 0 ? editStartLine - 1 : editStartLine + removed.length - 1,
			modifiedText: added.join('\n'),
		});
		editStartLine = undefined;
		removed = [];
		added = [];
	};

	for (const line of diff.split('\n')) {
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (header) {
			flushEdit();
			originalLine = Number(header[1]);
			continue;
		}

		if (line.startsWith('-')) {
			editStartLine ??= Math.max(originalLine, 1);
			removed.push(line.slice(1));
			originalLine += 1;
		}

		if (line.startsWith('+')) {
			editStartLine ??= Math.max(originalLine, 1);
			added.push(line.slice(1));
		}

		if (line.startsWith(' ')) {
			flushEdit();
			originalLine += 1;
		}

	}

	flushEdit();
	return edits;
}

export class EditBridgeService extends Disposable implements IEditBridgeService {
	declare readonly _serviceBrand: undefined;

	private readonly stagedContentStore = new StagedContentStore();
	private readonly pendingEditsRegistry = new PendingEditsRegistry();
	private _codeEditorService: ICodeEditorService | undefined;
	private _editCodeService: IEditCodeService | undefined;
	private _fileService: IFileService | undefined;
	private _editorService: IEditorService | undefined;

	constructor(
		mainProcessService: IMainProcessService,
		private readonly logService: ILogService,
		private readonly instantiationService: IInstantiationService,
	) {
		super();

		const disposables = this._register(new DisposableStore());
		mainProcessService.registerChannel('opencodeEditBridge', ProxyChannel.fromService(this, disposables));
		this.logService.info('[opencode] editBridge channel registered');
	}

	private getCodeEditorService(): ICodeEditorService {
		if (!this._codeEditorService) {
			this._codeEditorService = this.instantiationService.invokeFunction(accessor => accessor.get(ICodeEditorService));
		}

		return this._codeEditorService;
	}

	private getEditCodeService(): IEditCodeService {
		if (!this._editCodeService) {
			this._editCodeService = this.instantiationService.invokeFunction(accessor => accessor.get(IEditCodeService));
		}

		return this._editCodeService;
	}

	private getFileService(): IFileService {
		if (!this._fileService) {
			this._fileService = this.instantiationService.invokeFunction(accessor => accessor.get(IFileService));
		}

		return this._fileService;
	}

	private getEditorService(): IEditorService {
		if (!this._editorService) {
			this._editorService = this.instantiationService.invokeFunction(accessor => accessor.get(IEditorService));
		}

		return this._editorService;
	}

	async applyEdit(req: ApplyEditRequest): Promise<ApplyEditResponse> {
		return this.createPendingZone(req.filePath, req.newContent, req.edits);
	}

	async applyWrite(req: ApplyWriteRequest): Promise<ApplyEditResponse> {
		const editor = await this.resolveEditor(req.filePath);
		const model = editor.getModel();
		if (!model) {
			throw new Error(`[opencode] editor model not found for ${req.filePath}`);
		}

		return this.createPendingZone(req.filePath, req.newContent, [{
			originalStartLine: 1,
			originalEndLine: model.getLineCount(),
			modifiedText: req.newContent,
		}]);
	}

	async applyPatch(req: ApplyPatchRequest): Promise<ApplyPatchResponse> {
		const zoneIds: string[] = [];
		for (const change of req.files) {
			if (change.type === 'delete' || change.type === 'move') {
				this.logService.warn(`[opencode] skipping unsupported patch change type ${change.type} for ${change.filePath}`);
				continue;
			}

			const edits = parseUnifiedDiff(change.diff);
			const response = edits.length > 0
				? await this.applyEdit({ filePath: change.filePath, newContent: change.newContent, edits })
				: change.type === 'add'
					? await this.applyEdit({
						filePath: change.filePath,
						newContent: change.newContent,
						edits: [{ originalStartLine: 1, originalEndLine: 0, modifiedText: change.newContent }],
					})
					: await this.applyWrite({ filePath: change.filePath, newContent: change.newContent });
			zoneIds.push(response.zoneId);
		}

		return { zoneIds };
	}

	async readBuffer(filePath: string): Promise<ReadBufferResponse> {
		const content = this.stagedContentStore.get(filePath);
		if (content !== undefined) {
			return { dirty: true, content };
		}

		return { dirty: false };
	}

	async acceptAll(): Promise<void> {
		for (const zoneId of this.pendingEditsRegistry.zoneIds()) {
			this.getEditCodeService().acceptDiffZone(zoneId);
			await this.handleZoneAccepted(zoneId);
		}
	}

	async rejectAll(): Promise<void> {
		for (const zoneId of this.pendingEditsRegistry.zoneIds()) {
			this.getEditCodeService().rejectDiffZone(zoneId);
			this.handleZoneRejected(zoneId);
		}
	}

	async pendingCount(): Promise<number> {
		return this.pendingEditsRegistry.size;
	}

	private async createPendingZone(filePath: string, newContent: string, edits: readonly DiffEdit[]): Promise<ApplyEditResponse> {
		const editor = await this.resolveEditor(filePath);
		const model = editor.getModel();
		if (!model) {
			throw new Error(`[opencode] editor model not found for ${filePath}`);
		}

		const zoneId = this.getEditCodeService().createDiffZone(`${editor.getId()},${model.id}`, edits, { status: 'pending', replaceExisting: false });
		this.attachZoneLifecycle(zoneId);
		this.stagedContentStore.set(filePath, newContent);
		this.pendingEditsRegistry.set(zoneId, { filePath, newContent });
		return { zoneId };
	}

	private async resolveEditor(filePath: string): Promise<ICodeEditor> {
		const existingEditor = this.findEditor(filePath);
		if (existingEditor) {
			return existingEditor;
		}

		await this.getEditorService().openEditor({ resource: URI.file(filePath) });
		const openedEditor = this.findEditor(filePath);
		if (openedEditor) {
			return openedEditor;
		}

		throw new Error(`[opencode] editor not found for ${filePath}`);
	}

	private findEditor(filePath: string): ICodeEditor | undefined {
		return this.getCodeEditorService().listCodeEditors().find(editor => editor.getModel()?.uri.fsPath === filePath);
	}

	private attachZoneLifecycle(zoneId: string): void {
		const entry = (this.getEditCodeService() as InternalEditCodeService).zones?.get(zoneId);
		if (!entry) {
			return;
		}

		for (const widget of entry.widgets) {
			if (widget.__opencodeEditBridgeWrapped) {
				continue;
			}

			widget.__opencodeEditBridgeWrapped = true;
			const originalAccept = widget.accept.bind(widget);
			const originalReject = widget.reject.bind(widget);
			widget.accept = () => {
				originalAccept();
				void this.handleZoneAccepted(zoneId).catch(error => this.logService.error('[opencode] failed to persist accepted edit bridge zone', error));
			};
			widget.reject = () => {
				originalReject();
				this.handleZoneRejected(zoneId);
			};
		}
	}

	private async handleZoneAccepted(zoneId: string): Promise<void> {
		const pendingEdit = this.pendingEditsRegistry.get(zoneId);
		if (!pendingEdit) {
			return;
		}

		await this.getFileService().writeFile(URI.file(pendingEdit.filePath), VSBuffer.fromString(pendingEdit.newContent));
		this.pendingEditsRegistry.delete(zoneId);
		if (!this.pendingEditsRegistry.hasPendingForFile(pendingEdit.filePath)) {
			this.stagedContentStore.clearOne(pendingEdit.filePath);
		}
	}

	private handleZoneRejected(zoneId: string): void {
		const pendingEdit = this.pendingEditsRegistry.get(zoneId);
		if (!pendingEdit) {
			return;
		}

		this.pendingEditsRegistry.delete(zoneId);
		if (!this.pendingEditsRegistry.hasPendingForFile(pendingEdit.filePath)) {
			this.stagedContentStore.clearOne(pendingEdit.filePath);
		}
	}
}

IMainProcessService(EditBridgeService, '', 0);
ILogService(EditBridgeService, '', 1);
IInstantiationService(EditBridgeService, '', 2);

registerSingleton(IEditBridgeService, EditBridgeService, InstantiationType.Eager);
