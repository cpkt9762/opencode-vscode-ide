/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import type { HunkRange } from './opencodeSessionsTypes.js';

/**
 * Parses unified-diff hunk headers and returns a regular array typed as readonly for callers.
 */
export function parseUnifiedDiffHunks(diff: string): readonly HunkRange[] {
	const hunkHeader = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/gm;

	return Array.from(diff.matchAll(hunkHeader), match => ({
		modifiedStartLine: Number.parseInt(match[1], 10),
		modifiedLineCount: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
	}));
}
