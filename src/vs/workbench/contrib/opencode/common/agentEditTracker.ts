/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../../../../base/common/event.js';
import type { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { HunkRange } from './opencodeSessionsTypes.js';

export interface IAgentEditEntry {
	readonly status: 'modified' | 'viewed';
	readonly hunks: readonly HunkRange[];
	readonly lastEditedAt: number;
}

export const IAgentEditTracker = createDecorator<IAgentEditTracker>('agentEditTracker');

export interface IAgentEditTracker {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<readonly URI[]>;
	/** Snapshot of all currently-tracked URIs (any status). Used by SCM bridge for clean-detection iteration. */
	readonly trackedUris: readonly URI[];
	markModified(uri: URI, hunks?: readonly HunkRange[], editedAt?: number): void;
	attachHunks(uri: URI, hunks: readonly HunkRange[], editedAt: number): void;
	markViewed(uri: URI): void;
	markRemoved(uri: URI): void;
	clear(): void;
	getEntry(uri: URI): IAgentEditEntry | undefined;
}
