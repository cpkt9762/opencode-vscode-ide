/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { IAgentEditEntry, IAgentEditTracker } from '../common/agentEditTracker.js';
import type { HunkRange } from '../common/opencodeSessionsTypes.js';

export class AgentEditTracker extends Disposable implements IAgentEditTracker {
	declare readonly _serviceBrand: undefined;

	// URI.toString() normalizes URI identity so equal-by-content URIs share one tracker entry.
	private readonly _state = new Map<string, IAgentEditEntry>();
	private readonly _onDidChange = this._register(new Emitter<readonly URI[]>());
	readonly onDidChange: Event<readonly URI[]> = this._onDidChange.event;

	constructor(
		private readonly workspaceContextService: IWorkspaceContextService,
		_logService: ILogService,
	) {
		super();
		void _logService;
	}

	get trackedUris(): readonly URI[] {
		return Array.from(this._state.keys(), (key) => URI.parse(key));
	}

	markModified(uri: URI, hunks?: readonly HunkRange[], editedAt?: number): void {
		if (!this.acceptsWorkspaceUri(uri)) {
			return;
		}

		const key = uri.toString();
		const previous = this._state.get(key);
		const next: IAgentEditEntry = {
			status: 'modified',
			hunks: hunks ? [...hunks] : previous?.hunks ?? [],
			lastEditedAt: editedAt ?? previous?.lastEditedAt ?? 0,
		};
		if (this.entryEquals(previous, next)) {
			return;
		}

		this._state.set(key, next);
		this._onDidChange.fire([uri]);
	}

	attachHunks(uri: URI, hunks: readonly HunkRange[], editedAt: number): void {
		const key = uri.toString();
		const previous = this._state.get(key);
		const next: IAgentEditEntry = {
			status: previous?.status ?? 'modified',
			hunks: [...hunks],
			lastEditedAt: editedAt,
		};
		if (this.entryEquals(previous, next)) {
			return;
		}

		this._state.set(key, next);
		this._onDidChange.fire([uri]);
	}

	markViewed(uri: URI): void {
		const key = uri.toString();
		const previous = this._state.get(key);
		if (!previous || previous.status === 'viewed') {
			return;
		}

		this._state.set(key, { ...previous, status: 'viewed' });
		this._onDidChange.fire([uri]);
	}

	markRemoved(uri: URI): void {
		if (!this._state.delete(uri.toString())) {
			return;
		}

		this._onDidChange.fire([uri]);
	}

	clear(): void {
		if (this._state.size === 0) {
			return;
		}

		const uris = this.trackedUris;
		this._state.clear();
		this._onDidChange.fire(uris);
	}

	getEntry(uri: URI): IAgentEditEntry | undefined {
		return this._state.get(uri.toString());
	}

	private acceptsWorkspaceUri(uri: URI): boolean {
		// During empty-window/workspace transitions there may be no folders yet; accept all URIs rather than dropping agent events.
		if (this.workspaceContextService.getWorkspace().folders.length === 0) {
			return true;
		}

		return Boolean(this.workspaceContextService.getWorkspaceFolder(uri));
	}

	private entryEquals(left: IAgentEditEntry | undefined, right: IAgentEditEntry): boolean {
		return Boolean(
			left &&
				left.status === right.status &&
				left.lastEditedAt === right.lastEditedAt &&
				this.hunksEqual(left.hunks, right.hunks),
		);
	}

	private hunksEqual(left: readonly HunkRange[], right: readonly HunkRange[]): boolean {
		return left.length === right.length && left.every((hunk, index) => {
			const other = right[index];
			return Boolean(
				other &&
					hunk.modifiedStartLine === other.modifiedStartLine &&
					hunk.modifiedLineCount === other.modifiedLineCount,
			);
		});
	}
}

IWorkspaceContextService(AgentEditTracker, undefined, 0);
ILogService(AgentEditTracker, undefined, 1);
