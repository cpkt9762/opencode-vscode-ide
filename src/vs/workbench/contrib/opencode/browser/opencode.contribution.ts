/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *  Based on Void Editor (https://github.com/voideditor/void).
 *  Original: src/vs/workbench/contrib/void/browser/void.contribution.ts
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../../base/common/lifecycle.js";
import { localize } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import {
	Extensions as ConfigurationExtensions,
	type IConfigurationRegistry,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import {
	InstantiationType,
	registerSingleton,
} from "../../../../platform/instantiation/common/extensions.js";
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from "../../../../platform/log/common/log.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import type { IWorkbenchContributionsRegistry } from "../../../common/contributions.js";
import { Extensions as WorkbenchExtensions } from "../../../common/contributions.js";
import { LifecyclePhase } from "../../../services/lifecycle/common/lifecycle.js";
import { IEditBridgeService } from '../common/editBridgeTypes.js';
import { IEditCodeService } from "../common/editCodeServiceTypes.js";
import {
	IOpencodeEditorService,
	OpencodeEditorService,
} from "../common/opencodeEditorService.js";
import { EditCodeService } from "./editCodeService.js";
import "./sidebarPane.js";
import './editBridgeService.js';

void IEditBridgeService;

const opencodeCategory = { value: localize('opencodeCategory', 'OpenCode'), original: 'OpenCode' };

class OpencodeWorkbenchContribution extends Disposable {
	static readonly ID = "workbench.contrib.opencode";

	constructor(
		logService: ILogService,
		_editBridgeService: IEditBridgeService,
	) {
		super();
		logService.info("[opencode] contribution loaded");
		void _editBridgeService;
	}
}

ILogService(OpencodeWorkbenchContribution, "", 0);
IEditBridgeService(OpencodeWorkbenchContribution, "", 1);

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

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'opencode.acceptAllPendingEdits',
			title: {
				value: localize('opencodeAcceptAllPendingEdits', 'OpenCode: Accept All Pending Edits'),
				original: 'OpenCode: Accept All Pending Edits',
			},
			category: opencodeCategory,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditBridgeService).acceptAll();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'opencode.rejectAllPendingEdits',
			title: {
				value: localize('opencodeRejectAllPendingEdits', 'OpenCode: Reject All Pending Edits'),
				original: 'OpenCode: Reject All Pending Edits',
			},
			category: opencodeCategory,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditBridgeService).rejectAll();
	}
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
