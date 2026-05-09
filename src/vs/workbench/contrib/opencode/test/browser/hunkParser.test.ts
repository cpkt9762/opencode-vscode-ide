/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// biome-ignore lint/style/useNodejsImportProtocol: browser unit tests load assert through the test runner bundle.
import * as assert from 'assert';
import { parseUnifiedDiffHunks } from '../../common/hunkParser.js';

const multiHunkDiff = [
	'@@ -1,2 +1,2 @@',
	' context',
	'-before',
	'+after',
	'@@ -20 +24,2 @@',
	'-tail',
	'+tail one',
	'+tail two',
].join('\n');

const createTwoFilesPatchLikeDiff = `--- a/src/example.ts
+++ b/src/example.ts
@@ -1,4 +1,5 @@
 import { foo } from './foo';
 
-const name = 'old';
+const name = 'new';
+const enabled = true;
 export { name };
@@ -18,3 +19,4 @@ export function run() {
 	return foo(name);
 }
+run();
`;

suite('HunkParser', () => {
	test('empty string returns no hunks', () => {
		assert.deepStrictEqual(parseUnifiedDiffHunks(''), []);
	});

	test('string with no hunk header returns no hunks', () => {
		assert.deepStrictEqual(parseUnifiedDiffHunks(' context\n-old\n+new'), []);
	});

	test('single-line hunk defaults modified line count to one', () => {
		assert.deepStrictEqual(parseUnifiedDiffHunks('@@ -10 +12 @@'), [{ modifiedStartLine: 12, modifiedLineCount: 1 }]);
	});

	test('standard hunk parses modified start and count', () => {
		assert.deepStrictEqual(parseUnifiedDiffHunks('@@ -10,3 +12,5 @@'), [{ modifiedStartLine: 12, modifiedLineCount: 5 }]);
	});

	test('multi-hunk diff returns hunks in input order', () => {
		assert.deepStrictEqual(parseUnifiedDiffHunks(multiHunkDiff), [
			{ modifiedStartLine: 1, modifiedLineCount: 2 },
			{ modifiedStartLine: 24, modifiedLineCount: 2 },
		]);
	});

	test('multi-hunk diff with CRLF line endings returns the same number of hunks', () => {
		assert.strictEqual(parseUnifiedDiffHunks(multiHunkDiff.replaceAll('\n', '\r\n')).length, parseUnifiedDiffHunks(multiHunkDiff).length);
	});

	test('createTwoFilesPatch-like fixture returns exact hunk ranges', () => {
		assert.deepStrictEqual(parseUnifiedDiffHunks(createTwoFilesPatchLikeDiff), [
			{ modifiedStartLine: 1, modifiedLineCount: 5 },
			{ modifiedStartLine: 19, modifiedLineCount: 4 },
		]);
	});

	test('indented hunk header is ignored', () => {
		assert.deepStrictEqual(parseUnifiedDiffHunks('   @@ -10 +12 @@'), []);
	});
});
