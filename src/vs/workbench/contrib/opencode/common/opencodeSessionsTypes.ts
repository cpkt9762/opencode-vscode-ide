/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export interface IOpencodeSession {
	readonly id: string;
	readonly title: string;
	readonly parentID?: string;
	readonly time: {
		readonly created: number;
		readonly updated: number;
	};
}

export type IOpencodeSessionStatus = 'busy' | 'idle' | 'retry';

export type IOpencodeSessionStatusMap = Record<string, IOpencodeSessionStatus>;

export type IOpencodeSessionEvent =
	| { readonly type: 'created'; readonly session: IOpencodeSession }
	| { readonly type: 'updated'; readonly session: IOpencodeSession }
	| { readonly type: 'deleted'; readonly sessionID: string }
	| { readonly type: 'idle'; readonly sessionID: string }
	| { readonly type: 'status'; readonly sessionID: string; readonly status: IOpencodeSessionStatus }
	| { readonly type: "file.edited"; readonly file: string }
	| { readonly type: "file.watcher.updated"; readonly file: string; readonly event: "add" | "change" | "unlink" }
	| { readonly type: "message.part.updated"; readonly sessionID: string; readonly part: IOpencodePart; readonly time: number };

export type SessionsGroupId = 'today' | 'yesterday' | 'thisWeek' | 'older';

export interface IOpencodeSessionGroup {
	readonly id: SessionsGroupId;
	readonly label: string;
	readonly sessions: IOpencodeSession[];
}

export enum OpencodeSessionsViewerOrientation {
	Stacked = 1,
	SideBySide = 2,
}

export enum OpencodeSessionsViewerPosition {
	Left = 1,
	Right = 2,
}

export interface IOpencodeSessionsControl {

	readonly element: HTMLElement | undefined;

	refresh(): void;
	openFind(): void;

	reveal(sessionID: string): boolean;

	clearFocus(): void;
	hasFocusOrSelection(): boolean;

	resetSectionCollapseState(): void;
	collapseAllSections(): void;

	setNavigateCallback(cb: (sessionID: string) => void): void;

	dispose(): void;
}

export const IOpencodeSessionsService = createDecorator<IOpencodeSessionsService>('opencodeSessionsService');

export interface IOpencodeSessionsService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSessions: Event<void>;
	readonly state: {
		readonly sessions: readonly IOpencodeSession[];
		readonly status: IOpencodeSessionStatusMap;
		readonly loading: boolean;
		readonly error: string | undefined;
	};

	start(): Promise<void>;
	stop(): void;
	refresh(): Promise<void>;
	createSession(): Promise<string>;
	deleteSession(id: string): Promise<void>;
	renameSession(id: string, title: string): Promise<void>;
	shareSession(id: string): Promise<string>;
	forkSession(id: string): Promise<string>;
}

export interface IOpencodePart {
	readonly type: string;
	readonly tool?: string;
	readonly state?: {
		readonly status: string;
		/**
		 * Tool metadata. Shape varies per tool (verified via grep against backend source):
		 *   - edit / write: `{ filepath: string; diff: string }` (single file, unified-diff)
		 *   - multiedit: `{ results: Array<{ filepath?: string; diff?: string }> }` (one entry per sub-edit)
		 *   - apply_patch (normal): `{ filepath: string; diff: string; files: string[] }` (filepath is COMMA-JOINED relative paths, diff is aggregated multi-file — not directly usable for per-file hunks in v1.4)
		 *   - apply_patch (bridge mode): `{ diff: string; files: string[]; diagnostics: object }` (no filepath at all)
		 * Plan does runtime narrowing in Task 8 dispatch.
		 */
		readonly metadata?: {
			readonly filepath?: string;
			readonly diff?: string;
			readonly results?: ReadonlyArray<{ readonly filepath?: string; readonly diff?: string }>;
			readonly files?: readonly string[];
		};
	};
}

export interface HunkRange {
	readonly modifiedStartLine: number;
	readonly modifiedLineCount: number;
}
