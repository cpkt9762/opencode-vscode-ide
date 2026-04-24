/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export interface LineEdit {
	readonly originalStartLine: number;
	readonly originalEndLine: number;
	readonly modifiedText: string;
}

export interface ApplyEditRequest {
	filePath: string;
	newContent: string;
	edits: readonly LineEdit[];
}

export interface ApplyEditResponse {
	zoneId: string;
}

export interface ApplyWriteRequest {
	filePath: string;
	newContent: string;
}

export interface ApplyPatchFileChange {
	filePath: string;
	type: 'add' | 'update' | 'move' | 'delete';
	newContent: string;
	diff: string;
	movePath?: string;
}

export interface ApplyPatchRequest {
	files: readonly ApplyPatchFileChange[];
}

export interface ApplyPatchResponse {
	zoneIds: readonly string[];
}

export interface ReadBufferResponse {
	dirty: boolean;
	content?: string;
}

export interface IEditBridgeService {
	readonly _serviceBrand: undefined;
	applyEdit(req: ApplyEditRequest): Promise<ApplyEditResponse>;
	applyWrite(req: ApplyWriteRequest): Promise<ApplyEditResponse>;
	applyPatch(req: ApplyPatchRequest): Promise<ApplyPatchResponse>;
	readBuffer(filePath: string): Promise<ReadBufferResponse>;
	acceptAll(): Promise<void>;
	rejectAll(): Promise<void>;
	pendingCount(): Promise<number>;
}

export const IEditBridgeService = createDecorator<IEditBridgeService>('opencodeEditBridgeService');
