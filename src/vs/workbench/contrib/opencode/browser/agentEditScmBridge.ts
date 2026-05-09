/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { type ISCMRepository, ISCMService } from '../../scm/common/scm.js';
import { IAgentEditTracker } from '../common/agentEditTracker.js';

export class AgentEditScmBridge extends Disposable {
	private readonly _scheduler: RunOnceScheduler;
	private readonly _repoDisposables = new Map<ISCMRepository, IDisposable>();

	constructor(
		private readonly scmService: ISCMService,
		private readonly tracker: IAgentEditTracker,
		debounceMs = 250,
	) {
		super();
		// The debounce duration is injectable only so unit tests can avoid waiting on real 250ms timers.
		this._scheduler = this._register(new RunOnceScheduler(() => this.flush(), debounceMs));
		this._register(scmService.onDidAddRepository((repository) => this.subscribeToRepo(repository)));
		this._register(scmService.onDidRemoveRepository((repository) => this.unsubscribeRepo(repository)));

		for (const repository of this.repositories()) {
			this.subscribeToRepo(repository);
		}
	}

	override dispose(): void {
		for (const disposable of this._repoDisposables.values()) {
			disposable.dispose();
		}
		this._repoDisposables.clear();
		super.dispose();
	}

	private subscribeToRepo(repository: ISCMRepository): void {
		if (this._repoDisposables.has(repository)) {
			return;
		}

		const disposables = new DisposableStore();
		disposables.add(repository.provider.onDidChangeResources(() => this._scheduler.schedule()));
		this._repoDisposables.set(repository, disposables);
	}

	private unsubscribeRepo(repository: ISCMRepository): void {
		const disposable = this._repoDisposables.get(repository);
		if (!disposable) {
			return;
		}

		this._repoDisposables.delete(repository);
		disposable.dispose();
	}

	private flush(): void {
		const repositories = this.repositories();
		const dirtyUriSet = new Set(repositories.flatMap((repository) => repository.provider.groups.flatMap((group) => group.resources.map((resource) => resource.sourceUri.toString()))));

		for (const uri of this.tracker.trackedUris) {
			if (!repositories.some((repository) => this.containsUri(repository.provider.rootUri, uri))) {
				continue;
			}

			if (!dirtyUriSet.has(uri.toString())) {
				this.tracker.markRemoved(uri);
			}
		}
	}

	private repositories(): readonly ISCMRepository[] {
		return Array.from(this.scmService.repositories);
	}

	private containsUri(rootUri: URI | undefined, uri: URI): boolean {
		if (!rootUri) {
			return false;
		}

		// Include an exact root match, then require a trailing slash so /repo does not match /repo-other.
		return uri.fsPath === rootUri.fsPath || uri.fsPath.startsWith(rootUri.fsPath.endsWith('/') ? rootUri.fsPath : `${rootUri.fsPath}/`);
	}
}

ISCMService(AgentEditScmBridge, undefined, 0);
IAgentEditTracker(AgentEditScmBridge, undefined, 1);
