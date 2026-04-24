/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export type DiffZoneStatus = 'streaming' | 'pending' | 'accepted' | 'rejected';
export type ActiveDiffZoneStatus = Extract<DiffZoneStatus, 'streaming' | 'pending'>;

export interface DiffEdit {
	readonly originalStartLine: number;
	readonly originalEndLine: number;
	readonly modifiedText: string;
}

export interface DiffZoneState {
	readonly id: string;
	readonly editorId: string;
	edits: readonly DiffEdit[];
	status: DiffZoneStatus;
}

export interface IDiffZoneWidget {
	readonly id: string;
	accept(): void;
	reject(): void;
	dispose(): void;
}

export interface IEditCodeService {
	readonly _serviceBrand: undefined;
	createDiffZone(editorId: string, edits: readonly DiffEdit[], options?: { status?: ActiveDiffZoneStatus; replaceExisting?: boolean }): string;
	updateDiffZone(zoneId: string, edits: readonly DiffEdit[], options?: { status?: ActiveDiffZoneStatus }): void;
	acceptDiffZone(zoneId: string): void;
	rejectDiffZone(zoneId: string): void;
	disposeDiffZone(zoneId: string): void;
}

export const IEditCodeService = createDecorator<IEditCodeService>('editCodeService');
