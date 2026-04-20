/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { type DiffEdit, IEditCodeService } from './editCodeServiceTypes.js';

export const IOpencodeEditorService = createDecorator<IOpencodeEditorService>('opencodeEditorService');

export interface IOpencodeEditorService {
	readonly _serviceBrand: undefined;
	sendLLMRequest(prompt: string): Promise<string>;
	getServerUrl(): string;
	applyDiffEdit(editorId: string, edits: readonly DiffEdit[]): string;
}

export class OpencodeEditorService implements IOpencodeEditorService {
	declare readonly _serviceBrand: undefined;

	constructor(
		private readonly logService: ILogService,
		private readonly editCodeService: IEditCodeService,
	) {}

	sendLLMRequest(prompt: string): Promise<string> {
		this.logService.info('[opencode] stub llm-request', prompt);
		return Promise.resolve(`[stub] LLM response for: ${prompt}`);
	}

	getServerUrl(): string {
		return 'http://127.0.0.1:4096';
	}

	applyDiffEdit(editorId: string, edits: readonly DiffEdit[]): string {
		this.logService.info('[opencode] apply diff edit', { editorId, editCount: edits.length });
		return this.editCodeService.createDiffZone(editorId, edits);
	}
}

ILogService(OpencodeEditorService, '', 0);
IEditCodeService(OpencodeEditorService, '', 1);
