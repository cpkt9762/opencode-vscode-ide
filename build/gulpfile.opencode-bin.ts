/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * CI surface decision:
 * - This fork uses both GitHub Actions (.github/workflows/) and Azure Pipelines (build/azure-pipelines/).
 * - The opencode binary packaging job should live in GitHub Actions because fork-specific CI jobs already live there.
 */

import * as path from 'node:path';
import gulp from 'gulp';
import product from '../product.json' with { type: 'json' };
import * as task from './lib/task.ts';

const root = path.dirname(import.meta.dirname);

function bundleOpencodeBin() {
	const arch = process.env.OPENCODE_BUILD_ARCH || process.arch;
	const resolvedPlatform = process.env.OPENCODE_BUILD_PLATFORM || process.platform;
	const ext = resolvedPlatform === 'win32' ? '.exe' : '';
	const source = `resources/opencode-bin/opencode-${resolvedPlatform}-${arch}${ext}`;
	const destination = resolvedPlatform === 'darwin'
		? path.join(path.dirname(root), `VSCode-darwin-${arch}`, `${product.nameLong}.app`, 'Contents', 'Resources', 'opencode-bin')
		: path.join(path.dirname(root), `VSCode-${resolvedPlatform}-${arch}`, 'resources', 'opencode-bin');

	return gulp.src(source, { allowEmpty: false })
		.pipe(gulp.dest(destination));
}

export const bundleOpencodeBinTask = task.define('bundle-opencode-bin', bundleOpencodeBin);
gulp.task(bundleOpencodeBinTask);
