/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// biome-ignore lint/style/useNodejsImportProtocol: browser unit tests load assert through the test runner bundle.
import * as assert from "assert";
import { Emitter } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";
import type { IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import type { ILogService } from "../../../../../platform/log/common/log.js";
import type { IWorkspaceContextService } from "../../../../../platform/workspace/common/workspace.js";
import type {
	OpencodeSessionsEventStreamFactory,
	OpencodeSessionsFetchFn,
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
): ISpaProxyService {
	return {
		async start() {
			return { port: 5888 };
		},
		async stop() {},
		async url(workspaceDir: string) {
			return `http://127.0.0.1:${ports[workspaceDir] ?? 5888}/${encodeURIComponent(workspaceDir)}`;
		},
		dispose() {},
	} as unknown as ISpaProxyService;
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

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") {
		return input;
	}

	if (input instanceof URL) {
		return input.toString();
	}

	return input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function createFetch(
	backends: Record<string, FetchBackend>,
	calls: string[],
): OpencodeSessionsFetchFn {
	return async (input, init) => {
		const url = new URL(requestUrl(input));
		const method = (init?.method ?? "GET").toUpperCase();
		calls.push(`${method} ${url.origin}${url.pathname}`);

		const backend = backends[url.origin];
		if (!backend) {
			return jsonResponse({ error: `missing backend for ${url.origin}` }, 404);
		}

		if (method === "GET" && url.pathname === "/session") {
			return jsonResponse(backend.sessions);
		}

		if (method === "GET" && url.pathname === "/session/status") {
			return jsonResponse(backend.status ?? {});
		}

		return jsonResponse({ error: `${method} ${url.pathname}` }, 404);
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
	readonly fetchFn: OpencodeSessionsFetchFn;
	readonly eventStreamFactory?: OpencodeSessionsEventStreamFactory;
	readonly ports?: Record<string, number>;
}): OpencodeSessionsService {
	return new OpencodeSessionsService(
		createLogService(),
		createSpaProxyService(
			input.ports ?? { "/workspace/a": 4101, "/workspace/b": 4102 },
		),
		input.workspace.service,
		createConfigurationService(),
		input.fetchFn,
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
	test("initial fetch populates state", async () => {
		const workspace = createWorkspaceHarness("/workspace/a");
		const calls: string[] = [];
		const service = createService({
			workspace,
			fetchFn: createFetch(
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

	test("SSE event triggers state update", async () => {
		const workspace = createWorkspaceHarness("/workspace/a");
		const calls: string[] = [];
		const streams: TestEventStream[] = [];
		const service = createService({
			workspace,
			fetchFn: createFetch(
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
			fetchFn: createFetch(
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

	test("workspace switch re-fetches and replaces state", async () => {
		const workspace = createWorkspaceHarness("/workspace/a");
		const calls: string[] = [];
		const service = createService({
			workspace,
			fetchFn: createFetch(
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
			fetchFn: createFetch(
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
			fetchFn: createFetch(
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
