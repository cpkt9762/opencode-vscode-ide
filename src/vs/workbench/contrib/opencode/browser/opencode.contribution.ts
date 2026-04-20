/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *  Based on Void Editor (https://github.com/voideditor/void).
 *  Original: src/vs/workbench/contrib/void/browser/void.contribution.ts
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from "../../../../base/common/lifecycle.js";
import {
	InstantiationType,
	registerSingleton,
} from "../../../../platform/instantiation/common/extensions.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import type { IWorkbenchContributionsRegistry } from "../../../common/contributions.js";
import { Extensions as WorkbenchExtensions } from "../../../common/contributions.js";
import { LifecyclePhase } from "../../../services/lifecycle/common/lifecycle.js";
import {
	IOpencodeEditorService,
	OpencodeEditorService,
} from "../common/opencodeEditorService.js";

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

registerSingleton(
	IOpencodeEditorService,
	OpencodeEditorService,
	InstantiationType.Delayed,
);
