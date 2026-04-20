/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IOpencodeEditorService = createDecorator<IOpencodeEditorService>('opencodeEditorService');

export interface IOpencodeEditorService {
	readonly _serviceBrand: undefined;
}

export class OpencodeEditorService implements IOpencodeEditorService {
	declare readonly _serviceBrand: undefined;
}
