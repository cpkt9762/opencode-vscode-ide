/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import {
	createSSEStreamReader,
	parseSSELine,
} from "../common/opencodeSessionsSSEParser.js";
import type {
	IOpencodeSession,
	IOpencodeSessionEvent,
	IOpencodeSessionStatus,
	IOpencodeSessionStatusMap,
	IOpencodeSessionsService,
} from "../common/opencodeSessionsTypes.js";
import { ISpaProxyService } from "../electron-main/spaProxyService.js";

export { IOpencodeSessionsService } from "../common/opencodeSessionsTypes.js";

export type OpencodeSessionsFetchFn = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;
export type OpencodeSessionsEventStreamFactory = (
	url: string,
	signal: AbortSignal,
	fetchFn: OpencodeSessionsFetchFn,
) => Promise<AsyncIterable<IOpencodeSessionEvent | string>>;

const refreshDebounceMs = 400;
const statusCacheTtlMs = 500;
const heartbeatMs = 15_000;
const reconnectDelays = [250, 500, 1000, 2000, 4000] as const;
const statuses = new Set<IOpencodeSessionStatus>(["busy", "idle", "retry"]);

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

function aborted(error: unknown): boolean {
	if (error instanceof DOMException) {
		return error.name === "AbortError";
	}

	return record(error) && error.name === "AbortError";
}

function normalizeStatus(value: unknown): IOpencodeSessionStatus | undefined {
	if (
		typeof value === "string" &&
		statuses.has(value as IOpencodeSessionStatus)
	) {
		return value as IOpencodeSessionStatus;
	}

	if (record(value)) {
		return normalizeStatus(value.type);
	}

	return undefined;
}

function toSession(value: unknown): IOpencodeSession | undefined {
	if (
		!record(value) ||
		typeof value.id !== "string" ||
		typeof value.title !== "string" ||
		!record(value.time)
	) {
		return undefined;
	}

	if (
		typeof value.time.created !== "number" ||
		typeof value.time.updated !== "number"
	) {
		return undefined;
	}

	return {
		id: value.id,
		title: value.title,
		...(typeof value.parentID === "string" ? { parentID: value.parentID } : {}),
		time: {
			created: value.time.created,
			updated: value.time.updated,
		},
	};
}

function toSessionList(value: unknown): IOpencodeSession[] {
	if (!Array.isArray(value)) {
		throw new Error("Expected /session to return an array");
	}

	return value.flatMap((item) => {
		const session = toSession(item);
		return session ? [session] : [];
	});
}

function toStatusMap(value: unknown): IOpencodeSessionStatusMap {
	if (!record(value)) {
		throw new Error("Expected /session/status to return an object");
	}

	return Object.fromEntries(
		Object.entries(value).flatMap(([sessionID, status]) => {
			const normalized = normalizeStatus(status);
			return normalized ? [[sessionID, normalized]] : [];
		}),
	);
}

function eventSession(
	event: IOpencodeSessionEvent,
): IOpencodeSession | undefined {
	if (event.type === "created" || event.type === "updated") {
		return toSession(event.session);
	}

	return undefined;
}

function eventSessionID(event: IOpencodeSessionEvent): string | undefined {
	if ("sessionID" in event && typeof event.sessionID === "string") {
		return event.sessionID;
	}

	return eventSession(event)?.id;
}

function eventStatus(
	event: IOpencodeSessionEvent,
): IOpencodeSessionStatus | undefined {
	if ("status" in event) {
		return normalizeStatus(event.status);
	}

	return undefined;
}

function shareUrl(value: unknown): string | undefined {
	if (
		!record(value) ||
		!record(value.share) ||
		typeof value.share.url !== "string"
	) {
		return undefined;
	}

	return value.share.url;
}

async function defaultEventStreamFactory(
	url: string,
	signal: AbortSignal,
	fetchFn: OpencodeSessionsFetchFn,
): Promise<AsyncIterable<IOpencodeSessionEvent | string>> {
	// Task 4 chose fetch + ReadableStream instead of native EventSource so the service can inspect
	// status/content-type and keep cancellation under AbortController control.
	const response = await fetchFn(url, {
		headers: { Accept: "text/event-stream" },
		signal,
	});
	if (!response.ok) {
		throw new Error(
			`OpenCode sessions SSE failed with HTTP ${response.status}`,
		);
	}

	if (!response.headers.get("content-type")?.includes("text/event-stream")) {
		throw new Error(
			`OpenCode sessions SSE returned non-SSE content type: ${response.headers.get("content-type") ?? "missing"}`,
		);
	}

	if (!response.body) {
		throw new Error(
			"OpenCode sessions SSE response did not include a readable body",
		);
	}

	return createSSEStreamReader(response.body);
}

export class OpencodeSessionsService
	extends Disposable
	implements IOpencodeSessionsService
{
	declare readonly _serviceBrand: undefined;

	private readonly onDidChangeSessionsEmitter = this._register(
		new Emitter<void>(),
	);
	readonly onDidChangeSessions: Event<void> =
		this.onDidChangeSessionsEmitter.event;

	readonly state = {
		sessions: [] as readonly IOpencodeSession[],
		status: {} as IOpencodeSessionStatusMap,
		loading: false,
		error: undefined as string | undefined,
	};

	private apiBaseUrl: string | undefined;
	private started = false;
	private loadRun = 0;
	private sseRun = 0;
	private reconnectAttempt = 0;
	private statusCache:
		| { readonly ts: number; readonly value: IOpencodeSessionStatusMap }
		| undefined;
	private statusInflight: Promise<IOpencodeSessionStatusMap> | undefined;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private refreshPromise: Promise<void> | undefined;
	private resolveRefresh: (() => void) | undefined;
	private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private sseAbort: AbortController | undefined;

	constructor(
		private readonly logService: ILogService,
		private readonly spaProxyService: ISpaProxyService,
		private readonly contextService: IWorkspaceContextService,
		configurationService: IConfigurationService,
		private readonly fetchFn: OpencodeSessionsFetchFn = globalThis.fetch.bind(
			globalThis,
		),
		private readonly eventStreamFactory: OpencodeSessionsEventStreamFactory = defaultEventStreamFactory,
	) {
		super();
		void configurationService;
		this._register(
			this.contextService.onDidChangeWorkspaceFolders(() =>
				this.onWorkspaceSwitch(),
			),
		);
	}

	async start(): Promise<void> {
		if (this.started) {
			return;
		}

		this.started = true;
		await this.loadSessionsAndStatus();
		this.subscribeSSE();
	}

	stop(): void {
		this.started = false;
		this.loadRun += 1;
		this.abortSSE();
		this.clearRefreshTimer();
		this.resetApiState();
		this.resetState();
		this.onDidChangeSessionsEmitter.fire();
	}

	refresh(): Promise<void> {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}

		if (!this.refreshPromise) {
			this.refreshPromise = new Promise((resolve) => {
				this.resolveRefresh = resolve;
			});
		}

		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			const resolve = this.resolveRefresh;
			this.refreshPromise = undefined;
			this.resolveRefresh = undefined;
			this.statusCache = undefined;
			void this.loadSessionsAndStatus().finally(() => resolve?.());
		}, refreshDebounceMs);

		return this.refreshPromise;
	}

	async createSession(): Promise<string> {
		const value = await this.fetchJson("/session", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		const session = toSession(value);
		if (!session) {
			throw new Error("OpenCode create session returned an invalid session");
		}

		this.upsertSession(session);
		this.onDidChangeSessionsEmitter.fire();
		return session.id;
	}

	async deleteSession(id: string): Promise<void> {
		await this.fetchResponse(this.sessionPath(id), { method: "DELETE" });
		this.deleteSessionFromState(id);
		this.onDidChangeSessionsEmitter.fire();
	}

	async renameSession(id: string, title: string): Promise<void> {
		const value = await this.fetchJson(this.sessionPath(id), {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title }),
		});
		const session = toSession(value);
		if (!session) {
			throw new Error("OpenCode rename session returned an invalid session");
		}

		this.upsertSession(session);
		this.onDidChangeSessionsEmitter.fire();
	}

	async shareSession(id: string): Promise<string> {
		const value = await this.fetchJson(this.sessionPath(id, "/share"), {
			method: "POST",
		});
		const session = toSession(value);
		const url = shareUrl(value);
		if (!session || !url) {
			throw new Error("OpenCode share session returned an invalid share URL");
		}

		this.upsertSession(session);
		this.onDidChangeSessionsEmitter.fire();
		return url;
	}

	async forkSession(id: string): Promise<string> {
		const value = await this.fetchJson(this.sessionPath(id, "/fork"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		const session = toSession(value);
		if (!session) {
			throw new Error("OpenCode fork session returned an invalid session");
		}

		this.upsertSession(session);
		this.onDidChangeSessionsEmitter.fire();
		return session.id;
	}

	override dispose(): void {
		this.stop();
		super.dispose();
	}

	private async getApiBaseUrl(): Promise<string> {
		if (this.apiBaseUrl) {
			return this.apiBaseUrl;
		}

		const workspaceDir = this.currentWorkspaceDir();
		if (!workspaceDir) {
			throw new Error("OpenCode sessions require a workspace folder");
		}

		const url = new URL(await this.spaProxyService.url(workspaceDir));
		url.pathname = url.pathname.replace(/\/[^/]*\/?$/, "");
		url.search = "";
		url.hash = "";
		this.apiBaseUrl = url.toString().replace(/\/$/, "");
		return this.apiBaseUrl;
	}

	private async fetchSessions(): Promise<IOpencodeSession[]> {
		return toSessionList(await this.fetchJson("/session"));
	}

	private async fetchStatus(): Promise<IOpencodeSessionStatusMap> {
		const now = Date.now();
		if (this.statusCache && now - this.statusCache.ts < statusCacheTtlMs) {
			return this.statusCache.value;
		}

		if (this.statusInflight) {
			return this.statusInflight;
		}

		this.statusInflight = this.fetchJson("/session/status")
			.then(toStatusMap)
			.then((value) => {
				this.statusCache = { ts: Date.now(), value };
				return value;
			})
			.finally(() => {
				this.statusInflight = undefined;
			});

		return this.statusInflight;
	}

	private subscribeSSE(): void {
		this.abortSSE();
		if (!this.started || !this.currentWorkspaceDir()) {
			return;
		}

		const run = ++this.sseRun;
		this.reconnectAttempt = 0;
		void this.openSSE(run);
	}

	private handleSSEEvent(event: IOpencodeSessionEvent): void {
		if (event.type === "created" || event.type === "updated") {
			const session = eventSession(event);
			if (!session) {
				this.logService.warn(
					`[OpenCode] Ignoring invalid sessions SSE ${event.type} event`,
				);
				return;
			}

			this.upsertSession(session);
			this.onDidChangeSessionsEmitter.fire();
			return;
		}

		if (event.type === "deleted") {
			const id = eventSessionID(event);
			if (!id) {
				this.logService.warn(
					"[OpenCode] Ignoring invalid sessions SSE deleted event",
				);
				return;
			}

			this.deleteSessionFromState(id);
			this.onDidChangeSessionsEmitter.fire();
			return;
		}

		if (event.type === "idle" || event.type === "status") {
			const id = eventSessionID(event);
			const status = event.type === "idle" ? "idle" : eventStatus(event);
			if (!id || !status) {
				this.logService.warn(
					`[OpenCode] Ignoring invalid sessions SSE ${event.type} event`,
				);
				return;
			}

			this.state.status = { ...this.state.status, [id]: status };
			this.onDidChangeSessionsEmitter.fire();
		}
	}

	private async fetchJson(path: string, init?: RequestInit): Promise<unknown> {
		const response = await this.fetchResponse(path, init);
		const value: unknown = await response.json();
		return value;
	}

	private async fetchResponse(
		path: string,
		init?: RequestInit,
	): Promise<Response> {
		const response = await this.fetchFn(
			`${await this.getApiBaseUrl()}${path}`,
			init,
		);
		if (!response.ok) {
			throw new Error(
				`OpenCode API ${(init?.method ?? "GET").toUpperCase()} ${path} failed with HTTP ${response.status}`,
			);
		}

		return response;
	}

	private async loadSessionsAndStatus(): Promise<void> {
		const run = ++this.loadRun;
		this.state.loading = true;
		this.state.error = undefined;

		try {
			const [sessions, status] = await Promise.all([
				this.fetchSessions(),
				this.fetchStatus(),
			]);
			if (run !== this.loadRun) {
				return;
			}

			this.state.sessions = sessions;
			this.state.status = status;
			this.state.loading = false;
			this.state.error = undefined;
			this.onDidChangeSessionsEmitter.fire();
		} catch (error) {
			if (run !== this.loadRun) {
				return;
			}

			this.state.loading = false;
			this.state.error = errorMessage(error);
			this.logService.error("[OpenCode] Failed to fetch sessions", error);
			this.onDidChangeSessionsEmitter.fire();
		}
	}

	private async openSSE(run: number): Promise<void> {
		const controller = new AbortController();
		this.sseAbort = controller;
		this.armHeartbeat(run, controller);

		try {
			const stream = await this.eventStreamFactory(
				`${await this.getApiBaseUrl()}/event`,
				controller.signal,
				this.fetchFn,
			);
			if (!this.isCurrentSSE(run, controller)) {
				return;
			}

			this.reconnectAttempt = 0;
			this.armHeartbeat(run, controller);
			for await (const input of stream) {
				if (!this.isCurrentSSE(run, controller)) {
					return;
				}

				this.armHeartbeat(run, controller);
				const event = typeof input === "string" ? parseSSELine(input) : input;
				if (event) {
					this.handleSSEEvent(event);
				}
			}
		} catch (error) {
			if (!aborted(error)) {
				this.logService.warn(
					`[OpenCode] Sessions SSE disconnected: ${errorMessage(error)}`,
				);
			}
		} finally {
			if (this.sseAbort === controller) {
				this.sseAbort = undefined;
			}

			this.clearHeartbeatTimer();
		}

		this.scheduleReconnect(run);
	}

	private scheduleReconnect(run: number): void {
		if (!this.started || run !== this.sseRun || !this.currentWorkspaceDir()) {
			return;
		}

		const delay = reconnectDelays[this.reconnectAttempt];
		if (delay === undefined) {
			this.logService.warn(
				"[OpenCode] Sessions SSE stopped after maximum reconnect attempts",
			);
			return;
		}

		this.reconnectAttempt += 1;
		this.clearReconnectTimer();
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.openSSE(run);
		}, delay);
	}

	private onWorkspaceSwitch(): void {
		this.loadRun += 1;
		this.abortSSE();
		this.resetApiState();
		this.resetState();
		this.onDidChangeSessionsEmitter.fire();

		if (!this.started) {
			return;
		}

		void this.loadSessionsAndStatus().then(() => this.subscribeSSE());
	}

	private upsertSession(session: IOpencodeSession): void {
		this.state.sessions = [
			session,
			...this.state.sessions.filter((item) => item.id !== session.id),
		].sort((a, b) => b.time.updated - a.time.updated);
	}

	private deleteSessionFromState(id: string): void {
		this.state.sessions = this.state.sessions.filter((item) => item.id !== id);
		const { [id]: _deleted, ...status } = this.state.status;
		this.state.status = status;
	}

	private sessionPath(id: string, suffix = ""): string {
		return `/session/${encodeURIComponent(id)}${suffix}`;
	}

	private currentWorkspaceDir(): string {
		return this.contextService.getWorkspace().folders[0]?.uri.fsPath ?? "";
	}

	private resetState(): void {
		this.state.sessions = [];
		this.state.status = {};
		this.state.loading = false;
		this.state.error = undefined;
	}

	private resetApiState(): void {
		this.apiBaseUrl = undefined;
		this.statusCache = undefined;
		this.statusInflight = undefined;
	}

	private clearRefreshTimer(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}

		const resolve = this.resolveRefresh;
		this.refreshPromise = undefined;
		this.resolveRefresh = undefined;
		resolve?.();
	}

	private abortSSE(): void {
		this.sseRun += 1;
		this.clearHeartbeatTimer();
		this.clearReconnectTimer();
		this.sseAbort?.abort();
		this.sseAbort = undefined;
	}

	private isCurrentSSE(run: number, controller: AbortController): boolean {
		return (
			this.started &&
			run === this.sseRun &&
			this.sseAbort === controller &&
			!controller.signal.aborted
		);
	}

	private armHeartbeat(run: number, controller: AbortController): void {
		this.clearHeartbeatTimer();
		this.heartbeatTimer = setTimeout(() => {
			if (!this.isCurrentSSE(run, controller)) {
				return;
			}

			this.logService.warn(
				"[OpenCode] Sessions SSE heartbeat timed out; reconnecting",
			);
			controller.abort();
		}, heartbeatMs);
	}

	private clearHeartbeatTimer(): void {
		if (!this.heartbeatTimer) {
			return;
		}

		clearTimeout(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
	}

	private clearReconnectTimer(): void {
		if (!this.reconnectTimer) {
			return;
		}

		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
	}
}

ILogService(OpencodeSessionsService, "", 0);
ISpaProxyService(OpencodeSessionsService, "", 1);
IWorkspaceContextService(OpencodeSessionsService, "", 2);
IConfigurationService(OpencodeSessionsService, "", 3);
