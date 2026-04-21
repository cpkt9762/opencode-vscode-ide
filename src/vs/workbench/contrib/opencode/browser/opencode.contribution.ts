/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *  Based on Void Editor (https://github.com/voideditor/void).
 *  Original: src/vs/workbench/contrib/void/browser/void.contribution.ts
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../../base/common/lifecycle.js";
import { localize } from '../../../../nls.js';
import {
	Extensions as ConfigurationExtensions,
	type IConfigurationRegistry,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import {
	InstantiationType,
	registerSingleton,
} from "../../../../platform/instantiation/common/extensions.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import type { IWorkbenchContributionsRegistry } from "../../../common/contributions.js";
import { Extensions as WorkbenchExtensions } from "../../../common/contributions.js";
import { LifecyclePhase } from "../../../services/lifecycle/common/lifecycle.js";
import { IEditCodeService } from "../common/editCodeServiceTypes.js";
import {
	IOpencodeEditorService,
	OpencodeEditorService,
} from "../common/opencodeEditorService.js";
import { EditCodeService } from "./editCodeService.js";
import "./sidebarPane.js";

class OpencodeWorkbenchContribution extends Disposable {
	static readonly ID = "workbench.contrib.opencode";

	constructor(logService: ILogService) {
		super();
		logService.info("[opencode] contribution loaded");
	}
}

ILogService(OpencodeWorkbenchContribution, "", 0);

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
			default: true,
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
	},
});

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
