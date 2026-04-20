/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export const IOpencodeEditorService = createDecorator<IOpencodeEditorService>('opencodeEditorService');

export interface IOpencodeEditorService {
	readonly _serviceBrand: undefined;
	sendLLMRequest(prompt: string): Promise<string>;
	getServerUrl(): string;
}

export class OpencodeEditorService implements IOpencodeEditorService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly logService: ILogService) {}

	sendLLMRequest(prompt: string): Promise<string> {
		this.logService.info('[opencode] stub llm-request', prompt);
		return Promise.resolve(`[stub] LLM response for: ${prompt}`);
	}

	getServerUrl(): string {
		return 'http://127.0.0.1:4096';
	}
}

ILogService(OpencodeEditorService, '', 0);
