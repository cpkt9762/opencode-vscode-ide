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
import type {
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
		input.eventStreamFactory ?? createIdleEventStreamFactory(),
	);
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
		);

		try {
			await service.start();
			await waitFor(
				() => service.state.sessions.some((item) => item.id === "fetch_sse"),
				"native fetch SSE event did not update state",
			);

			assert.deepStrictEqual(fetchCalls, [
				{
					url: "http://127.0.0.1:4101/event",
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
