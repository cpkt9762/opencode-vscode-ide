/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { opencodeAgentModifiedForeground, opencodeAgentViewedForeground } from '../../../../platform/theme/common/colors/listColors.js';
import type { IDecorationData, IDecorationsProvider } from '../../../services/decorations/common/decorations.js';
import { IAgentEditTracker } from '../common/agentEditTracker.js';

export class AgentModifiedDecorationsProvider extends Disposable implements IDecorationsProvider {
	readonly label = 'OpenCode Agent Edits';

	private readonly _onDidChange = this._register(new Emitter<readonly URI[]>());
	readonly onDidChange: Event<readonly URI[]> = this._onDidChange.event;

	constructor(private readonly tracker: IAgentEditTracker) {
		super();
		this._register(this.tracker.onDidChange((uris) => this._onDidChange.fire(uris)));
	}

	provideDecorations(uri: URI): IDecorationData | undefined {
		const entry = this.tracker.getEntry(uri);
		if (!entry) {
			return undefined;
		}

		return {
			weight: 8,
			letter: 'A',
			tooltip: entry.status === 'modified'
				? 'Modified by OpenCode agent'
				: 'Modified by OpenCode agent (viewed)',
			color: entry.status === 'modified'
				? opencodeAgentModifiedForeground
				: opencodeAgentViewedForeground,
			bubble: true,
		};
	}
}

IAgentEditTracker(AgentModifiedDecorationsProvider, undefined, 0);
