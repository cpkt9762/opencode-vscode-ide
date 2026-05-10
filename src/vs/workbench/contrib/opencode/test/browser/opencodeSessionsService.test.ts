/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// biome-ignore lint/style/useNodejsImportProtocol: browser unit tests load assert through the test runner bundle.
import * as assert from "assert";
import { bufferToStream, VSBuffer } from "../../../../../base/common/buffer.js";
import { Emitter, Event } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";
import type { IRequestContext } from "../../../../../base/parts/request/common/request.js";
import type { IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import type { ILogService } from "../../../../../platform/log/common/log.js";
import type { IRequestService } from "../../../../../platform/request/common/request.js";
import type { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import type {
	OpencodeSessionsEventStreamFactory,
} from "../../browser/opencodeSessionsService.js";
import { OpencodeSessionsService } from "../../browser/opencodeSessionsService.js";
import type { IAgentEditTracker } from "../../common/agentEditTracker.js";
import type {
	HunkRange,
	IOpencodePart,
	IOpencodeSession,
	IOpencodeSessionEvent,
	IOpencodeSessionStatusMap,
} from "../../common/opencodeSessionsTypes.js";
import type { ISpaProxyService } from "../../electron-main/spaProxyService.js";

type WorkspaceHarness = {
	readonly service: IWorkspaceContextService;
	setWorkspace(workspaceDir: string): void;
	dispose(): void;
};

type FetchBackend = {
	readonly sessions: readonly IOpencodeSession[];
	readonly status?: IOpencodeSessionStatusMap;
};

type StreamItem = IOpencodeSessionEvent | string;
type ToolMetadata = NonNullable<NonNullable<IOpencodePart["state"]>["metadata"]>;

type AgentEditTrackerHarness = {
	readonly service: IAgentEditTracker;
	readonly markModifiedCalls: URI[];
	readonly markRemovedCalls: URI[];
	readonly attachHunksCalls: {
		readonly uri: URI;
		readonly hunks: readonly HunkRange[];
		readonly time: number;
	}[];
	clearCalls: number;
};

type SSEHarness = {
	readonly workspace: WorkspaceHarness;
	readonly service: OpencodeSessionsService;
	readonly streams: TestEventStream[];
	readonly tracker: AgentEditTrackerHarness;
};

class TestEventStream implements AsyncIterable<StreamItem> {
	private readonly values: StreamItem[] = [];
	private resolve:
		| ((result: IteratorResult<StreamItem, void>) => void)
		| undefined;
	private reject: ((error: Error) => void) | undefined;
	private error: Error | undefined;
	private closed = false;

	push(value: StreamItem): void {
		const resolve = this.resolve;
		if (!resolve) {
			this.values.push(value);
			return;
		}

		this.resolve = undefined;
		this.reject = undefined;
		resolve({ done: false, value });
	}

	fail(error: Error): void {
		const reject = this.reject;
		this.error = error;
		if (!reject) {
			return;
		}

		this.resolve = undefined;
		this.reject = undefined;
		reject(error);
	}

	close(): void {
		const resolve = this.resolve;
		this.closed = true;
		if (!resolve) {
			return;
		}

		this.resolve = undefined;
		this.reject = undefined;
		resolve({ done: true, value: undefined });
	}

	async *[Symbol.asyncIterator](): AsyncIterator<StreamItem, void> {
		while (true) {
			const result = await this.next();
			if (result.done) {
				return;
			}

			yield result.value;
		}
	}

	private next(): Promise<IteratorResult<StreamItem, void>> {
		const value = this.values.shift();
		if (value) {
			return Promise.resolve({ done: false, value });
		}

		if (this.error) {
			return Promise.reject(this.error);
		}

		if (this.closed) {
			return Promise.resolve({ done: true, value: undefined });
		}

		return new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}
}

function session(id: string, title = id): IOpencodeSession {
	return {
		id,
		title,
		time: { created: id.charCodeAt(0), updated: id.charCodeAt(0) + 1 },
	};
}

function createWorkspaceHarness(workspaceDir: string): WorkspaceHarness {
	const emitter = new Emitter<void>();
	let current = workspaceDir;
	return {
		service: {
			onDidChangeWorkspaceFolders: emitter.event,
			getWorkspace() {
				return { folders: current ? [{ uri: URI.file(current) }] : [] };
			},
		} as unknown as IWorkspaceContextService,
		setWorkspace(next) {
			current = next;
			emitter.fire();
		},
		dispose() {
			emitter.dispose();
		},
	};
}

function createSpaProxyService(
	ports: Record<string, number>,
	starts: string[] = [],
): ISpaProxyService {
	let started = false;
	return {
		_serviceBrand: undefined,
		async start(options) {
			started = true;
			starts.push(options.dist);
			return { port: 5888 };
		},
		async stop() {
			started = false;
		},
		async url(workspaceDir: string) {
			if (!started) {
				throw new Error("test spa proxy was not started");
			}

			return `http://127.0.0.1:${ports[workspaceDir] ?? 5888}/${encodeURIComponent(workspaceDir)}`;
		},
		dispose() {},
	};
}

function createLogService(): ILogService {
	return {
		trace() {},
		info() {},
		warn() {},
		error() {},
	} as unknown as ILogService;
}

function createConfigurationService(): IConfigurationService {
	return {
		inspect() {
			return undefined;
		},
	} as unknown as IConfigurationService;
}

function createAgentEditTracker(): AgentEditTrackerHarness {
	const markModifiedCalls: URI[] = [];
	const markRemovedCalls: URI[] = [];
	const attachHunksCalls: AgentEditTrackerHarness["attachHunksCalls"] = [];
	const harness: AgentEditTrackerHarness = {
		service: {
			_serviceBrand: undefined,
			onDidChange: Event.None,
			trackedUris: [],
			markModified(uri) {
				markModifiedCalls.push(uri);
			},
			attachHunks(uri, hunks, time) {
				attachHunksCalls.push({ uri, hunks, time });
			},
			markViewed() {},
			markRemoved(uri) {
				markRemovedCalls.push(uri);
			},
			clear() {
				harness.clearCalls += 1;
			},
			getEntry() {
				return undefined;
			},
		},
		markModifiedCalls,
		markRemovedCalls,
		attachHunksCalls,
		clearCalls: 0,
	};
	return harness;
}

function jsonContext(body: unknown, status = 200): IRequestContext {
	return {
		res: {
			statusCode: status,
			headers: { "content-type": "application/json" },
		},
		stream: bufferToStream(VSBuffer.fromString(JSON.stringify(body))),
	};
}

function createRequestService(
	backends: Record<string, FetchBackend>,
	calls: string[],
): IRequestService {
	return {
		_serviceBrand: undefined,
		onDidCompleteRequest: Event.None,
		async request(options) {
			const url = new URL(options.url ?? "");
			const method = (options.type ?? "GET").toUpperCase();
			calls.push(`${method} ${url.origin}${url.pathname}`);

			const backend = backends[url.origin];
			if (!backend) {
				return jsonContext({ error: `missing backend for ${url.origin}` }, 404);
			}

			if (method === "GET" && url.pathname === "/session") {
				return jsonContext(backend.sessions);
			}

			if (method === "GET" && url.pathname === "/session/status") {
				return jsonContext(backend.status ?? {});
			}

			return jsonContext({ error: `${method} ${url.pathname}` }, 404);
		},
		async resolveProxy() {
			return undefined;
		},
		async lookupAuthorization() {
			return undefined;
		},
		async lookupKerberosAuthorization() {
			return undefined;
		},
		async loadCertificates() {
			return [];
		},
	};
}

function createIdleEventStreamFactory(
	streams: TestEventStream[] = [],
): OpencodeSessionsEventStreamFactory {
	return async (_url, signal) => {
		const stream = new TestEventStream();
		signal.addEventListener("abort", () => stream.close(), { once: true });
		streams.push(stream);
		return stream;
	};
}

function createService(input: {
	readonly workspace: WorkspaceHarness;
	readonly requestService: IRequestService;
	readonly eventStreamFactory?: OpencodeSessionsEventStreamFactory;
	readonly agentEditTracker?: IAgentEditTracker;
	readonly ports?: Record<string, number>;
	readonly spaProxyService?: ISpaProxyService;
}): OpencodeSessionsService {
	return new OpencodeSessionsService(
		createLogService(),
		input.spaProxyService ??
			createSpaProxyService(
				input.ports ?? { "/workspace/a": 4101, "/workspace/b": 4102 },
			),
		input.workspace.service,
		createConfigurationService(),
		input.requestService,
		input.agentEditTracker ?? createAgentEditTracker().service,
		input.eventStreamFactory ?? createIdleEventStreamFactory(),
	);
}

function createSSEHarness(): SSEHarness {
	const workspace = createWorkspaceHarness("/workspace/a");
	const streams: TestEventStream[] = [];
	const tracker = createAgentEditTracker();
	return {
		workspace,
		streams,
		tracker,
		service: createService({
			workspace,
			requestService: createRequestService(
				{ "http://127.0.0.1:4101": { sessions: [] } },
				[],
			),
			eventStreamFactory: createIdleEventStreamFactory(streams),
			agentEditTracker: tracker.service,
		}),
	};
}

async function startSSEHarness(harness: SSEHarness): Promise<void> {
	await harness.service.start();
	await waitFor(() => harness.streams.length === 1, "SSE stream was not opened");
}

function disposeSSEHarness(harness: SSEHarness): void {
	harness.service.dispose();
	harness.workspace.dispose();
}

function assertTrackerUntouched(tracker: AgentEditTrackerHarness): void {
	assert.strictEqual(tracker.markModifiedCalls.length, 0);
	assert.strictEqual(tracker.markRemovedCalls.length, 0);
	assert.strictEqual(tracker.attachHunksCalls.length, 0);
	assert.strictEqual(tracker.clearCalls, 0);
}

function completedToolEvent(
	tool: string,
	metadata: ToolMetadata,
	time = 1234,
): IOpencodeSessionEvent {
	return {
		type: "message.part.updated",
		sessionID: "s1",
		time,
		part: {
			type: "tool",
			tool,
			state: { status: "completed", metadata },
		},
	};
}

async function timeout(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
	predicate: () => boolean,
	message: string,
	timeoutMs = 1000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) {
			return;
		}

		await timeout(10);
	}

	assert.fail(message);
}

suite("OpencodeSessionsService", () => {
	test("starts spa proxy before fetching session APIs", async () => {
		const workspace = createWorkspaceHarness("/workspace/a");
		const calls: string[] = [];
		const starts: string[] = [];
		const service = createService({
			workspace,
			requestService: createRequestService(
				{ "http://127.0.0.1:4101": { sessions: [], status: {} } },
				calls,
			),
			spaProxyService: createSpaProxyService({ "/workspace/a": 4101 }, starts),
		});

		try {
			await service.start();

			assert.ok(starts.length >= 1);
			assert.ok(
				starts.every((start) =>
					start.endsWith("vs/workbench/contrib/opencode/media/spa"),
				),
			);
			assert.ok(calls.includes("GET http://127.0.0.1:4101/session"));
			assert.ok(calls.includes("GET http://127.0.0.1:4101/session/status"));
		} finally {
			service.dispose();
			workspace.dispose();
		}
	});

	test("initial fetch populates state", async () => {
		const workspace = createWorkspaceHarness("/workspace/a");
		const calls: string[] = [];
		const service = createService({
			workspace,
			requestService: createRequestService(
				{
					"http://127.0.0.1:4101": {
						sessions: [session("s1"), session("s2"), session("s3")],
						status: { s1: "idle" },
					},
				},
				calls,
			),
		});

		try {
			await service.start();

			assert.strictEqual(service.state.sessions.length, 3);
			assert.strictEqual(service.state.loading, false);
			assert.strictEqual(service.state.error, undefined);
			assert.ok(calls.includes("GET http://127.0.0.1:4101/session"));
		} finally {
			service.dispose();
			workspace.dispose();
		}
	});

	test("default SSE stream uses native fetch body", async () => {
		const workspace = createWorkspaceHarness("/workspace/a");
		const calls: string[] = [];
		const fetchCalls: { readonly url: string; readonly accept: string | null }[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input, init) => {
			fetchCalls.push({
				url: String(input),
				accept: new Headers(init?.headers).get("accept"),
			});
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								`data: ${JSON.stringify({
									type: "session.created",
									properties: {
										session: session("fetch_sse", "Fetch SSE"),
									},
								})}\n\n`,
							),
						);
						controller.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		}) as typeof fetch;
		const service = new OpencodeSessionsService(
			createLogService(),
			createSpaProxyService({ "/workspace/a": 4101 }),
			workspace.service,
			createConfigurationService(),
			createRequestService(
				{ "http://127.0.0.1:4101": { sessions: [] } },
				calls,
			),
			createAgentEditTracker().service,
			undefined,
		);

		try {
			await service.start();
			await waitFor(
				() => service.state.sessions.some((item) => item.id === "fetch_sse"),
				"native fetch SSE event did not update state",
			);

			assert.deepStrictEqual(fetchCalls, [
				{
					url: "http://127.0.0.1:4101/event?directory=%2Fworkspace%2Fa",
					accept: "text/event-stream",
				},
			]);
			assert.ok(!calls.includes("GET http://127.0.0.1:4101/event"));
		} finally {
			globalThis.fetch = originalFetch;
			service.dispose();
			workspace.dispose();
		}
	});

	test("SSE event triggers state update", async () => {
		const workspace = createWorkspaceHarness("/workspace/a");
		const calls: string[] = [];
		const streams: TestEventStream[] = [];
		const service = createService({
			workspace,
			requestService: createRequestService(
				{ "http://127.0.0.1:4101": { sessions: [] } },
				calls,
			),
			eventStreamFactory: createIdleEventStreamFactory(streams),
		});

		try {
			await service.start();
			await waitFor(() => streams.length === 1, "SSE stream was not opened");

			let emissions = 0;
			const listener = service.onDidChangeSessions(() => (emissions += 1));
			streams[0].push({
				type: "created",
				session: session("sse_1", "Created from SSE"),
			});

			await waitFor(
				() =>
					emissions === 1 &&
					service.state.sessions.some((item) => item.id === "sse_1"),
				"SSE event did not update state once",
			);
			assert.strictEqual(emissions, 1);
			listener.dispose();
		} finally {
			service.dispose();
			workspace.dispose();
		}
	});

	test("SSE file.edited marks tracker URI modified", async () => {
		const harness = createSSEHarness();

		try {
			await startSSEHarness(harness);
			harness.streams[0].push({
				type: "file.edited",
				file: "/workspace/a/src/file.ts",
			});

			await waitFor(
				() => harness.tracker.markModifiedCalls.length === 1,
				"file.edited did not mark tracker URI modified",
			);
			assert.strictEqual(
				harness.tracker.markModifiedCalls[0].toString(),
				URI.file("/workspace/a/src/file.ts").toString(),
			);
			assert.strictEqual(harness.tracker.markRemovedCalls.length, 0);
			assert.strictEqual(harness.tracker.attachHunksCalls.length, 0);
		} finally {
			disposeSSEHarness(harness);
		}
	});

	test("SSE file.watcher.updated unlink marks tracker URI removed", async () => {
		const harness = createSSEHarness();

		try {
			await startSSEHarness(harness);
			harness.streams[0].push({
				type: "file.watcher.updated",
				file: "/workspace/a/src/deleted.ts",
				event: "unlink",
			});

			await waitFor(
				() => harness.tracker.markRemovedCalls.length === 1,
				"file.watcher.updated unlink did not mark tracker URI removed",
			);
			assert.strictEqual(
				harness.tracker.markRemovedCalls[0].toString(),
				URI.file("/workspace/a/src/deleted.ts").toString(),
			);
			assert.strictEqual(harness.tracker.markModifiedCalls.length, 0);
			assert.strictEqual(harness.tracker.attachHunksCalls.length, 0);
		} finally {
			disposeSSEHarness(harness);
		}
	});

	test("SSE file.watcher.updated change leaves tracker untouched", async () => {
		const harness = createSSEHarness();

		try {
			await startSSEHarness(harness);
			harness.streams[0].push({
				type: "file.watcher.updated",
				file: "/workspace/a/src/changed.ts",
				event: "change",
			});

			await timeout(20);
			assertTrackerUntouched(harness.tracker);
		} finally {
			disposeSSEHarness(harness);
		}
	});

	test("SSE completed edit tool attaches parsed hunks", async () => {
		const harness = createSSEHarness();

		try {
			await startSSEHarness(harness);
			harness.streams[0].push(
				completedToolEvent("edit", {
					filepath: "/workspace/a/src/edit.ts",
					diff: "@@ -1 +1 @@\n-old\n+new\n",
				}, 4321),
			);

			await waitFor(
				() => harness.tracker.attachHunksCalls.length === 1,
				"completed edit tool did not attach hunks",
			);
			assert.strictEqual(
				harness.tracker.attachHunksCalls[0].uri.toString(),
				URI.file("/workspace/a/src/edit.ts").toString(),
			);
			assert.deepStrictEqual(harness.tracker.attachHunksCalls[0].hunks, [
				{ modifiedStartLine: 1, modifiedLineCount: 1 },
			]);
			assert.strictEqual(harness.tracker.attachHunksCalls[0].time, 4321);
			assert.strictEqual(harness.tracker.markModifiedCalls.length, 0);
			assert.strictEqual(harness.tracker.markRemovedCalls.length, 0);
		} finally {
			disposeSSEHarness(harness);
		}
	});

	test("SSE completed write tool attaches parsed hunks", async () => {
		const harness = createSSEHarness();

		try {
			await startSSEHarness(harness);
			harness.streams[0].push(
				completedToolEvent("write", {
					filepath: "/workspace/a/src/write.ts",
					diff: "@@ -2 +5,3 @@\n-old\n+new\n",
				}, 5678),
			);

			await waitFor(
				() => harness.tracker.attachHunksCalls.length === 1,
				"completed write tool did not attach hunks",
			);
			assert.strictEqual(
				harness.tracker.attachHunksCalls[0].uri.toString(),
				URI.file("/workspace/a/src/write.ts").toString(),
			);
			assert.deepStrictEqual(harness.tracker.attachHunksCalls[0].hunks, [
				{ modifiedStartLine: 5, modifiedLineCount: 3 },
			]);
			assert.strictEqual(harness.tracker.attachHunksCalls[0].time, 5678);
		} finally {
			disposeSSEHarness(harness);
		}
	});

	test("SSE completed multiedit tool attaches hunks in result order", async () => {
		const harness = createSSEHarness();

		try {
			await startSSEHarness(harness);
			harness.streams[0].push(
				completedToolEvent("multiedit", {
					results: [
						{
							filepath: "/workspace/a/src/first.ts",
							diff: "@@ -1 +2 @@\n-a\n+b\n",
						},
						{
							filepath: "/workspace/a/src/second.ts",
							diff: "@@ -3 +4,2 @@\n-c\n+d\n",
						},
					],
				}, 6789),
			);

			await waitFor(
				() => harness.tracker.attachHunksCalls.length === 2,
				"completed multiedit tool did not attach hunks for each result",
			);
			assert.deepStrictEqual(
				harness.tracker.attachHunksCalls.map((call) => call.uri.toString()),
				[
					URI.file("/workspace/a/src/first.ts").toString(),
					URI.file("/workspace/a/src/second.ts").toString(),
				],
			);
			assert.deepStrictEqual(harness.tracker.attachHunksCalls[0].hunks, [
				{ modifiedStartLine: 2, modifiedLineCount: 1 },
			]);
			assert.deepStrictEqual(harness.tracker.attachHunksCalls[1].hunks, [
				{ modifiedStartLine: 4, modifiedLineCount: 2 },
			]);
			assert.deepStrictEqual(
				harness.tracker.attachHunksCalls.map((call) => call.time),
				[6789, 6789],
			);
		} finally {
			disposeSSEHarness(harness);
		}
	});

	test("SSE completed multiedit tool skips malformed results", async () => {
		const harness = createSSEHarness();

		try {
			await startSSEHarness(harness);
			harness.streams[0].push(
				completedToolEvent("multiedit", {
					results: [
						{
							filepath: "/workspace/a/src/valid.ts",
							diff: "@@ -1 +7 @@\n-a\n+b\n",
						},
						{ filepath: "/workspace/a/src/malformed.ts" },
					],
				}, 7890),
			);

			await waitFor(
				() => harness.tracker.attachHunksCalls.length === 1,
				"completed multiedit tool did not skip malformed result",
			);
			assert.strictEqual(
				harness.tracker.attachHunksCalls[0].uri.toString(),
				URI.file("/workspace/a/src/valid.ts").toString(),
			);
			assert.deepStrictEqual(harness.tracker.attachHunksCalls[0].hunks, [
				{ modifiedStartLine: 7, modifiedLineCount: 1 },
			]);
			assert.strictEqual(harness.tracker.attachHunksCalls[0].time, 7890);
		} finally {
			disposeSSEHarness(harness);
		}
	});

	test("SSE completed apply_patch tool leaves tracker hunks untouched", async () => {
		const harness = createSSEHarness();

		try {
			await startSSEHarness(harness);
			harness.streams[0].push(
				completedToolEvent("apply_patch", {
					filepath: "/workspace/a/src/patched.ts",
					diff: "@@ -1 +1 @@\n-a\n+b\n",
				}),
			);

			await timeout(20);
			assertTrackerUntouched(harness.tracker);
		} finally {
			disposeSSEHarness(harness);
		}
	});

	test("SSE running tool part leaves tracker untouched", async () => {
		const harness = createSSEHarness();

		try {
			await startSSEHarness(harness);
			harness.streams[0].push({
				type: "message.part.updated",
				sessionID: "s1",
				time: 1234,
				part: {
					type: "tool",
					tool: "edit",
					state: {
						status: "running",
						metadata: {
							filepath: "/workspace/a/src/running.ts",
							diff: "@@ -1 +1 @@\n-a\n+b\n",
						},
					},
				},
			});

			await timeout(20);
			assertTrackerUntouched(harness.tracker);
		} finally {
			disposeSSEHarness(harness);
		}
	});

	test("SSE completed bash tool leaves tracker untouched", async () => {
		const harness = createSSEHarness();

		try {
			await startSSEHarness(harness);
			harness.streams[0].push(
				completedToolEvent("bash", {
					filepath: "/workspace/a/src/bash.ts",
					diff: "@@ -1 +1 @@\n-a\n+b\n",
				}),
			);

			await timeout(20);
			assertTrackerUntouched(harness.tracker);
		} finally {
			disposeSSEHarness(harness);
		}
	});

	test("SSE completed edit tool without metadata diff leaves tracker untouched", async () => {
		const harness = createSSEHarness();

		try {
			await startSSEHarness(harness);
			harness.streams[0].push(
				completedToolEvent("edit", {
					filepath: "/workspace/a/src/no-diff.ts",
				}),
			);

			await timeout(20);
			assertTrackerUntouched(harness.tracker);
		} finally {
			disposeSSEHarness(harness);
		}
	});

	test("reconnects after backend crash", async () => {
		const workspace = createWorkspaceHarness("/workspace/a");
		const calls: string[] = [];
		const streams: TestEventStream[] = [];
		let backendUp = true;
		let connectionAttempts = 0;
		const eventStreamFactory: OpencodeSessionsEventStreamFactory = async (
			_url,
			signal,
		) => {
			connectionAttempts += 1;
			if (!backendUp) {
				throw new Error("backend down");
			}

			const stream = new TestEventStream();
			signal.addEventListener("abort", () => stream.close(), { once: true });
			streams.push(stream);
			return stream;
		};
		const service = createService({
			workspace,
			requestService: createRequestService(
				{ "http://127.0.0.1:4101": { sessions: [] } },
				calls,
			),
			eventStreamFactory,
		});

		try {
			await service.start();
			await waitFor(
				() => streams.length === 1,
				"initial SSE stream was not opened",
			);

			backendUp = false;
			streams[0].fail(new Error("backend crashed"));
			await timeout(300);
			backendUp = true;

			await waitFor(
				() => streams.length === 2,
				"SSE stream did not reconnect after backend restart",
				1500,
			);
			assert.ok(connectionAttempts >= 2);
		} finally {
			service.dispose();
			workspace.dispose();
		}
	});

	test("emits connection state while SSE reconnects", async () => {
		const workspace = createWorkspaceHarness("/workspace/a");
		const calls: string[] = [];
		const streams: TestEventStream[] = [];
		let backendUp = true;
		const service = createService({
			workspace,
			requestService: createRequestService(
				{ "http://127.0.0.1:4101": { sessions: [] } },
				calls,
			),
			eventStreamFactory: async (_url, signal) => {
				if (!backendUp) {
					throw new Error("backend down");
				}

				const stream = new TestEventStream();
				signal.addEventListener("abort", () => stream.close(), { once: true });
				streams.push(stream);
				return stream;
			},
		});

		try {
			const states: boolean[] = [];
			const listener = service.onDidChangeConnection((connected) => states.push(connected));
			await service.start();
			await waitFor(
				() => states.includes(true),
				"SSE connection did not report connected",
			);

			backendUp = false;
			streams[0].fail(new Error("backend crashed"));
			await waitFor(
				() => states.includes(false),
				"SSE connection did not report disconnected",
			);

			backendUp = true;
			await waitFor(
				() => states.at(-1) === true,
				"SSE connection did not report reconnected",
				1500,
			);
			listener.dispose();
		} finally {
			service.dispose();
			workspace.dispose();
		}
	});

	test("workspace switch re-fetches and replaces state", async () => {
		const workspace = createWorkspaceHarness("/workspace/a");
		const calls: string[] = [];
		const service = createService({
			workspace,
			requestService: createRequestService(
				{
					"http://127.0.0.1:4101": {
						sessions: [session("a1"), session("a2"), session("a3")],
					},
					"http://127.0.0.1:4102": {
						sessions: [
							session("b1"),
							session("b2"),
							session("b3"),
							session("b4"),
							session("b5"),
						],
					},
				},
				calls,
			),
		});

		try {
			await service.start();
			assert.deepStrictEqual(
				service.state.sessions.map((item) => item.id),
				["a1", "a2", "a3"],
			);

			workspace.setWorkspace("/workspace/b");

			await waitFor(
				() => service.state.sessions.length === 5,
				"workspace switch did not re-fetch sessions",
			);
			assert.deepStrictEqual(
				service.state.sessions.map((item) => item.id),
				["b1", "b2", "b3", "b4", "b5"],
			);
		} finally {
			service.dispose();
			workspace.dispose();
		}
	});

	test("workspace switch clears tracker", () => {
		const workspace = createWorkspaceHarness("/workspace/a");
		const tracker = createAgentEditTracker();
		const service = createService({
			workspace,
			requestService: createRequestService(
				{ "http://127.0.0.1:4101": { sessions: [] } },
				[],
			),
			agentEditTracker: tracker.service,
		});

		try {
			workspace.setWorkspace("/workspace/b");

			assert.strictEqual(tracker.clearCalls, 1);
			assert.strictEqual(tracker.markModifiedCalls.length, 0);
			assert.strictEqual(tracker.markRemovedCalls.length, 0);
			assert.strictEqual(tracker.attachHunksCalls.length, 0);
		} finally {
			service.dispose();
			workspace.dispose();
		}
	});

	test("optimistic delete removes session and rollback restores state", async () => {
		const workspace = createWorkspaceHarness("/workspace/a");
		const calls: string[] = [];
		const service = createService({
			workspace,
			requestService: createRequestService(
				{
					"http://127.0.0.1:4101": {
						sessions: [session("s1"), session("s2")],
						status: { s1: "idle", s2: "busy" },
					},
				},
				calls,
			),
		});

		try {
			await service.start();
			let emissions = 0;
			const listener = service.onDidChangeSessions(() => (emissions += 1));

			const rollback = service.applyOptimisticDelete("s1");

			assert.deepStrictEqual(
				service.state.sessions.map((item) => item.id),
				["s2"],
			);
			assert.deepStrictEqual(service.state.status, { s2: "busy" });
			assert.strictEqual(emissions, 1);

			rollback();

			assert.deepStrictEqual(
				service.state.sessions.map((item) => item.id),
				["s1", "s2"],
			);
			assert.deepStrictEqual(service.state.status, { s1: "idle", s2: "busy" });
			assert.strictEqual(emissions, 2);
			listener.dispose();
		} finally {
			service.dispose();
			workspace.dispose();
		}
	});

	test("optimistic rename updates title and rollback restores state", async () => {
		const workspace = createWorkspaceHarness("/workspace/a");
		const calls: string[] = [];
		const service = createService({
			workspace,
			requestService: createRequestService(
				{
					"http://127.0.0.1:4101": {
						sessions: [session("s1", "Original"), session("s2")],
					},
				},
				calls,
			),
		});

		try {
			await service.start();
			let emissions = 0;
			const listener = service.onDidChangeSessions(() => (emissions += 1));

			const rollback = service.applyOptimisticRename("s1", "Renamed");

			assert.strictEqual(service.state.sessions[0].title, "Renamed");
			assert.strictEqual(emissions, 1);

			rollback();

			assert.strictEqual(service.state.sessions[0].title, "Original");
			assert.strictEqual(emissions, 2);
			listener.dispose();
		} finally {
			service.dispose();
			workspace.dispose();
		}
	});
});
