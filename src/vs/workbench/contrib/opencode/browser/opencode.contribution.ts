/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *  Based on Void Editor (https://github.com/voideditor/void).
 *  Original: src/vs/workbench/contrib/void/browser/void.contribution.ts
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../../base/common/lifecycle.js";
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from "../../../../platform/actions/common/actions.js";
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import {
	Extensions as ConfigurationExtensions,
	type IConfigurationRegistry,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import {
	InstantiationType,
	registerSingleton,
} from "../../../../platform/instantiation/common/extensions.js";
import { IInstantiationService, type ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import type { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import type { IWorkbenchContributionsRegistry } from "../../../common/contributions.js";
import { Extensions as WorkbenchExtensions } from "../../../common/contributions.js";
import { IDecorationsService } from "../../../services/decorations/common/decorations.js";
import { LifecyclePhase } from "../../../services/lifecycle/common/lifecycle.js";
import type { ISCMService } from "../../scm/common/scm.js";
import { IAgentEditTracker } from "../common/agentEditTracker.js";
import { IEditCodeService } from "../common/editCodeServiceTypes.js";
import {
	IOpencodeEditorService,
	OpencodeEditorService,
} from "../common/opencodeEditorService.js";
import { IOpencodeSessionsService } from "../common/opencodeSessionsTypes.js";
import type { ISpaProxyService } from "../electron-main/spaProxyService.js";
import { AgentEditNavigator } from "./agentEditNavigator.js";
import { AgentEditScmBridge } from "./agentEditScmBridge.js";
import { AgentEditTracker } from "./agentEditTracker.js";
import { AgentModifiedDecorationsProvider } from "./agentModifiedDecorationsProvider.js";
import { EditCodeService } from "./editCodeService.js";
import "./opencodeSessionsActions.js";
import { OpencodeSessionsService } from "./opencodeSessionsService.js";
import "./sidebarPane.js";

class OpencodeWorkbenchContribution extends Disposable {
	static readonly ID = "workbench.contrib.opencode";

	constructor(
		logService: ILogService,
		instantiationService: IInstantiationService,
		decorationsService: IDecorationsService,
	) {
		super();
		logService.info("[opencode] contribution loaded");
		const provider = this._register(instantiationService.createInstance(AgentModifiedDecorationsProvider));
		this._register(decorationsService.registerDecorationsProvider(provider));
		this._register(instantiationService.createInstance(AgentEditNavigator));
		this._register(instantiationService.createInstance(AgentEditScmBridge as new (
			scmService: ISCMService,
			tracker: IAgentEditTracker,
		) => AgentEditScmBridge));
	}
}

ILogService(OpencodeWorkbenchContribution, "", 0);
IInstantiationService(OpencodeWorkbenchContribution, "", 1);
IDecorationsService(OpencodeWorkbenchContribution, "", 2);

class ClearAgentEditHighlightsAction extends Action2 {
	constructor() {
		super({
			id: 'opencode.clearAgentEditHighlights',
			title: localize2('clearAgentEditHighlights', 'OpenCode: Clear Agent Edit Highlights'),
			category: { value: 'OpenCode', original: 'OpenCode' },
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IAgentEditTracker).clear();
	}
}

registerAction2(ClearAgentEditHighlightsAction);

Registry.as<IWorkbenchContributionsRegistry>(
	WorkbenchExtensions.Workbench,
).registerWorkbenchContribution(
	OpencodeWorkbenchContribution,
	LifecyclePhase.Restored,
);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'opencode',
	title: localize('opencodeConfigurationTitle', 'OpenCode'),
	type: 'object',
	properties: {
		'opencode.autoStart': {
			type: 'boolean',
			default: false,
			description: localize('opencodeAutoStart', 'Automatically start opencode serve when the workbench opens.'),
		},
		'opencode.port': {
			type: 'number',
			default: 4096,
			minimum: 1,
			maximum: 65535,
			description: localize('opencodePort', 'Port for the opencode serve backend.'),
		},
		'opencode.binaryPath': {
			type: 'string',
			default: '',
			description: localize('opencodeBinaryPath', 'Override path to the opencode binary. Leave empty for auto-discovery.'),
		},
		'opencode.serverPassword': {
			type: 'string',
			default: '',
			description: localize('opencodeServerPassword', 'Password for the opencode serve HTTP Basic auth. Leave empty to auto-generate a random one.'),
		},
	},
});

registerSingleton(
	IAgentEditTracker,
	AgentEditTracker,
	InstantiationType.Delayed,
);
registerSingleton(
	IOpencodeEditorService,
	OpencodeEditorService,
	InstantiationType.Delayed,
);
registerSingleton(
	IEditCodeService,
	EditCodeService,
	InstantiationType.Delayed,
);
registerSingleton<
	IOpencodeSessionsService,
	[
		ILogService,
		ISpaProxyService,
		IWorkspaceContextService,
		IConfigurationService,
	]
>(
	IOpencodeSessionsService,
	OpencodeSessionsService,
	InstantiationType.Delayed,
);
