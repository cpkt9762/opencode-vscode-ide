/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// biome-ignore lint/style/useNodejsImportProtocol: vscode test convention
import * as assert from "assert";
import { Emitter } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../../../base/test/common/utils.js";
import { opencodeAgentModifiedForeground, opencodeAgentViewedForeground } from "../../../../../platform/theme/common/colors/listColors.js";
import { AgentModifiedDecorationsProvider } from "../../browser/agentModifiedDecorationsProvider.js";
import type { IAgentEditEntry, IAgentEditTracker } from "../../common/agentEditTracker.js";

const modifiedUri = URI.file("/workspace/modified.ts");
const viewedUri = URI.file("/workspace/viewed.ts");
const missingUri = URI.file("/workspace/missing.ts");

function createTracker(entries = new Map<string, IAgentEditEntry>()) {
	const emitter = new Emitter<readonly URI[]>();
	const tracker: IAgentEditTracker = {
		_serviceBrand: undefined,
		onDidChange: emitter.event,
		trackedUris: [],
		getEntry: (uri: URI) => entries.get(uri.toString()),
		markModified: () => { },
		attachHunks: () => { },
		markViewed: () => { },
		markRemoved: () => { },
		clear: () => { },
	};

	return { emitter, tracker };
}

suite("AgentModifiedDecorationsProvider", () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createProvider(entries?: Map<string, IAgentEditEntry>) {
		const fixture = createTracker(entries);
		return {
			emitter: disposables.add(fixture.emitter),
			provider: disposables.add(new AgentModifiedDecorationsProvider(fixture.tracker)),
		};
	}

	test("provideDecorations returns undefined when the tracker has no entry", () => {
		const fixture = createProvider();

		assert.strictEqual(fixture.provider.provideDecorations(missingUri), undefined);
	});

	test("provideDecorations returns the modified decoration shape", () => {
		const fixture = createProvider(new Map([[modifiedUri.toString(), { status: "modified", hunks: [], lastEditedAt: 1 }]]));

		assert.deepStrictEqual(fixture.provider.provideDecorations(modifiedUri), {
			weight: 8,
			letter: "A",
			tooltip: "Modified by OpenCode agent",
			color: opencodeAgentModifiedForeground,
			bubble: true,
		});
	});

	test("provideDecorations returns the viewed decoration shape", () => {
		const fixture = createProvider(new Map([[viewedUri.toString(), { status: "viewed", hunks: [], lastEditedAt: 1 }]]));

		assert.deepStrictEqual(fixture.provider.provideDecorations(viewedUri), {
			weight: 8,
			letter: "A",
			tooltip: "Modified by OpenCode agent (viewed)",
			color: opencodeAgentViewedForeground,
			bubble: true,
		});
	});

	test("onDidChange re-fires tracker URI batches", () => {
		const fixture = createProvider();
		const changes: URI[][] = [];
		disposables.add(fixture.provider.onDidChange((uris) => changes.push([...uris])));

		fixture.emitter.fire([modifiedUri, viewedUri]);

		assert.deepStrictEqual(changes, [[modifiedUri, viewedUri]]);
	});
});
