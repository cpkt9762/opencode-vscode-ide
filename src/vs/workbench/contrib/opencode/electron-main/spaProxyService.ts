/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const ISpaProxyService = createDecorator<ISpaProxyService>('spaProxyService');

export interface ISpaProxyService extends IDisposable {
	readonly _serviceBrand: undefined;
	start(opts: { dist: string; backend: string }): Promise<{ port: number }>;
	stop(): Promise<void>;
	url(workspaceDir: string): string;
}
