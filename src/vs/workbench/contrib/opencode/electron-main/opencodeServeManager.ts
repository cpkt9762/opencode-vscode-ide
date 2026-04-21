/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
	Disposable,
	type IDisposable,
} from "../../../../base/common/lifecycle.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { createDecorator } from "../../../../platform/instantiation/common/instantiation.js";
import { ILogService } from "../../../../platform/log/common/log.js";

const STARTUP_TIMEOUT = 15_000;
const HEALTH_TIMEOUT = 2_000;
const HEALTH_RETRY_DELAY = 250;
const STOP_GRACE_PERIOD = 2_000;
const RESPAWN_DELAY = 1_000;
const READY_URL_PATTERN =
	/(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+)/;
const SEARCH_DIRECTORIES = [
	join(homedir(), ".opencode", "bin"),
	"/usr/local/bin",
	join(homedir(), "bin"),
	join(homedir(), ".local", "bin"),
	...(platform() === "darwin"
		? [
				"/Applications/OpenCode.app/Contents/MacOS",
				"/Applications/OpenCode Beta.app/Contents/MacOS",
			]
		: []),
];

export const IOpencodeServeManager = createDecorator<IOpencodeServeManager>(
	"opencodeServeManager",
);

export interface IOpencodeServeManager extends IDisposable {
	readonly _serviceBrand: undefined;
	start(): Promise<string>;
	stop(): Promise<void>;
	readonly backendUrl: string | undefined;
}

type OpencodeProcessState = "starting" | "running" | "stopped";

export class OpencodeServeManager
	extends Disposable
	implements IOpencodeServeManager
{
	declare readonly _serviceBrand: undefined;

	private process: ChildProcess | undefined;
	private _backendUrl: string | undefined;
	private startTask: Promise<string> | undefined;
	private state: OpencodeProcessState = "stopped";
	private weStarted = false;
	private stopRequested = false;
	private respawnTimer: ReturnType<typeof setTimeout> | undefined;

	get backendUrl(): string | undefined {
		return this._backendUrl;
	}

	constructor(
		private readonly configurationService: IConfigurationService,
		private readonly logService: ILogService,
	) {
		super();

		if (this.getAutoStart()) {
			Promise.resolve()
				.then(() => this.start())
				.catch((error) =>
					this.logService.error(
						"[opencode] failed to auto-start opencode serve",
						error,
					),
				);
		}
	}

	start(): Promise<string> {
		if (this.startTask) {
			return this.startTask;
		}

		if (this.state === "running" && this._backendUrl) {
			return Promise.resolve(this._backendUrl);
		}

		const task = this.doStart().finally(() => {
			if (this.startTask === task) {
				this.startTask = undefined;
			}
		});

		this.startTask = task;
		return task;
	}

	async stop(): Promise<void> {
		this.clearRespawnTimer();
		this.stopRequested = true;
		this.weStarted = false;
		this.state = "stopped";
		this._backendUrl = undefined;

		const process = this.process;
		this.process = undefined;

		if (!process) {
			return;
		}

		const exited = this.waitForExit(process);
		this.kill(process, "SIGTERM");

		const finished = await Promise.race([
			exited.then(() => true),
			this.sleep(STOP_GRACE_PERIOD).then(() => false),
		]);

		if (finished) {
			return;
		}

		this.kill(process, "SIGKILL");
		await exited;
	}

	override dispose(): void {
		void this.stop();
		this.clearRespawnTimer();
		super.dispose();
	}

	private async doStart(): Promise<string> {
		this.clearRespawnTimer();
		this.stopRequested = false;

		const backendUrl = this.getConfiguredBackendUrl();
		if (await this.isHealthy(backendUrl)) {
			this.state = "running";
			this.weStarted = false;
			this._backendUrl = backendUrl;
			this.logService.info(
				"[opencode] using existing opencode serve",
				backendUrl,
			);
			return backendUrl;
		}

		const binaryPath = this.findBinaryPath();
		if (!binaryPath) {
			throw new Error(
				"Failed to find an opencode binary. Configure opencode.binaryPath or add opencode to PATH.",
			);
		}

		const port = this.getPort();
		const deadline = Date.now() + STARTUP_TIMEOUT;
		const process = spawn(
			binaryPath,
			[
				"serve",
				"--hostname",
				"127.0.0.1",
				"--port",
				String(port),
				"--print-logs",
			],
			{
				stdio: ["ignore", "pipe", "pipe"],
				shell: platform() === "win32" && binaryPath.endsWith(".cmd"),
			},
		);

		this.process = process;
		this.state = "starting";
		this.weStarted = true;
		this.watchProcess(process);

		try {
			const readyUrl = await this.waitForReadyUrl(process, deadline);
			const normalizedUrl = this.normalizeBackendUrl(readyUrl, port);
			await this.waitForHealthy(normalizedUrl, deadline);
			this.state = "running";
			this._backendUrl = normalizedUrl;
			this.logService.info("[opencode] opencode serve ready", normalizedUrl);
			return normalizedUrl;
		} catch (error) {
			this.state = "stopped";
			this._backendUrl = undefined;

			if (this.process === process) {
				this.process = undefined;
			}

			if (process.exitCode === null && process.signalCode === null) {
				this.kill(process, "SIGKILL");
				await this.waitForExit(process);
			}

			throw this.toError(error);
		}
	}

	private watchProcess(process: ChildProcess): void {
		process.on("error", (error) => {
			this.logService.error("[opencode] opencode serve process error", error);
		});

		process.on("exit", (code, signal) => {
			if (this.process === process) {
				this.process = undefined;
			}

			const shouldRespawn =
				this.weStarted && !this.stopRequested && this.state === "running";
			this._backendUrl = undefined;
			this.state = "stopped";

			if (this.stopRequested) {
				this.logService.info("[opencode] opencode serve stopped");
				return;
			}

			this.logService.warn("[opencode] opencode serve exited", {
				code,
				signal,
				respawn: shouldRespawn,
			});

			if (!shouldRespawn) {
				return;
			}

			this.clearRespawnTimer();
			this.respawnTimer = setTimeout(() => {
				this.respawnTimer = undefined;
				if (this.stopRequested) {
					return;
				}

				void this.start().catch((error) => {
					this.logService.error(
						"[opencode] failed to respawn opencode serve",
						error,
					);
				});
			}, RESPAWN_DELAY);
		});
	}

	private async waitForReadyUrl(
		process: ChildProcess,
		deadline: number,
	): Promise<string> {
		const timeout = Math.max(deadline - Date.now(), 1);

		return new Promise<string>((resolve, reject) => {
			let output = "";
			let settled = false;

			const complete = (callback: () => void) => {
				if (settled) {
					return;
				}

				settled = true;
				clearTimeout(timer);
				process.stdout?.off("data", onStdout);
				process.stderr?.off("data", onStderr);
				process.off("exit", onExit);
				process.off("error", onError);
				callback();
			};

			const onStdout = (chunk: Buffer | string) => {
				output += chunk.toString();
				const match = output.match(READY_URL_PATTERN)?.[1];
				if (!match) {
					return;
				}

				complete(() => resolve(match));
			};

			const onStderr = (chunk: Buffer | string) => {
				output += chunk.toString();
			};

			const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
				complete(() =>
					reject(
						new Error(
							`opencode serve exited before ready (code=${code ?? "unknown"} signal=${signal ?? "unknown"})${output ? `\n${output}` : ""}`,
						),
					),
				);
			};

			const onError = (error: Error) => {
				complete(() => reject(error));
			};

			const timer = setTimeout(() => {
				complete(() =>
					reject(
						new Error(
							`Timed out waiting for opencode serve to report its URL${output ? `\n${output}` : ""}`,
						),
					),
				);
			}, timeout);

			process.stdout?.on("data", onStdout);
			process.stderr?.on("data", onStderr);
			process.on("exit", onExit);
			process.on("error", onError);
		});
	}

	private async waitForHealthy(url: string, deadline: number): Promise<void> {
		while (Date.now() < deadline) {
			if (await this.isHealthy(url)) {
				return;
			}

			await this.sleep(HEALTH_RETRY_DELAY);
		}

		throw new Error(
			`Timed out waiting for ${url}/global/health to report healthy=true.`,
		);
	}

	private async isHealthy(url: string): Promise<boolean> {
		try {
			const body = await this.readHealth(url);
			return isHealthResponse(body);
		} catch {
			return false;
		}
	}

	private readHealth(url: string): Promise<unknown> {
		const endpoint = new URL("/global/health", url);
		const request = endpoint.protocol === "https:" ? httpsRequest : httpRequest;

		return new Promise<unknown>((resolve, reject) => {
			const req = request(endpoint, { method: "GET" }, (response) => {
				let body = "";

				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					body += chunk;
				});
				response.on("end", () => {
					if (
						(response.statusCode ?? 0) < 200 ||
						(response.statusCode ?? 0) >= 300
					) {
						reject(
							new Error(
								`Unexpected health status code: ${response.statusCode ?? "unknown"}`,
							),
						);
						return;
					}

					try {
						resolve(JSON.parse(body));
					} catch (error) {
						reject(this.toError(error));
					}
				});
			});

			req.setTimeout(HEALTH_TIMEOUT, () => {
				req.destroy(new Error(`Timed out waiting for ${endpoint.toString()}`));
			});
			req.on("error", reject);
			req.end();
		});
	}

	private findBinaryPath(): string | undefined {
		const configuredPath = this.getBinaryPath();
		if (configuredPath) {
			const resolvedPath = this.resolveConfiguredBinaryPath(configuredPath);
			if (resolvedPath) {
				return resolvedPath;
			}

			this.logService.warn(
				"[opencode] configured opencode.binaryPath is not executable",
				configuredPath,
			);
		}

		const pathBinary = this.findBinaryOnPath();
		if (pathBinary) {
			return pathBinary;
		}

		for (const directory of SEARCH_DIRECTORIES) {
			for (const candidateName of this.getCandidateBinaryNames()) {
				const candidatePath = join(directory, candidateName);
				if (this.isExecutable(candidatePath)) {
					return candidatePath;
				}
			}
		}

		return undefined;
	}

	private resolveConfiguredBinaryPath(
		configuredPath: string,
	): string | undefined {
		if (this.isExecutable(configuredPath)) {
			return configuredPath;
		}

		for (const candidateName of this.getCandidateBinaryNames()) {
			const candidatePath = join(configuredPath, candidateName);
			if (this.isExecutable(candidatePath)) {
				return candidatePath;
			}
		}

		return undefined;
	}

	private findBinaryOnPath(): string | undefined {
		const command =
			platform() === "win32" ? "where opencode" : "which opencode";

		try {
			const output = execSync(command, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			const path = output
				.split(/\r?\n/)
				.find((line) => Boolean(line.trim()))
				?.trim();
			return path && this.isExecutable(path) ? path : undefined;
		} catch {
			return undefined;
		}
	}

	private isExecutable(path: string): boolean {
		if (!existsSync(path)) {
			return false;
		}

		if (platform() === "win32") {
			return true;
		}

		try {
			accessSync(path, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}

	private getCandidateBinaryNames(): readonly string[] {
		return platform() === "win32"
			? ["opencode.exe", "opencode.cmd", "opencode"]
			: ["opencode"];
	}

	private getAutoStart(): boolean {
		return (
			this.configurationService.getValue<boolean>("opencode.autoStart") !==
			false
		);
	}

	private getPort(): number {
		const configuredPort =
			this.configurationService.getValue<number>("opencode.port");
		return typeof configuredPort === "number" &&
			Number.isInteger(configuredPort) &&
			configuredPort > 0 &&
			configuredPort <= 65_535
			? configuredPort
			: 4096;
	}

	private getBinaryPath(): string | undefined {
		const configuredPath = this.configurationService
			.getValue<string>("opencode.binaryPath")
			?.trim();
		return configuredPath ? configuredPath : undefined;
	}

	private getConfiguredBackendUrl(): string {
		return `http://127.0.0.1:${this.getPort()}`;
	}

	private normalizeBackendUrl(url: string, fallbackPort: number): string {
		const normalizedUrl = new URL(url);
		normalizedUrl.hostname = "127.0.0.1";
		normalizedUrl.port = normalizedUrl.port || String(fallbackPort);
		normalizedUrl.pathname = "/";
		normalizedUrl.search = "";
		normalizedUrl.hash = "";

		const result = normalizedUrl.toString();
		return result.endsWith("/") ? result.slice(0, -1) : result;
	}

	private waitForExit(process: ChildProcess): Promise<void> {
		if (process.exitCode !== null || process.signalCode !== null) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve) => {
			const onExit = () => {
				process.off("exit", onExit);
				resolve();
			};

			process.on("exit", onExit);
		});
	}

	private kill(process: ChildProcess, signal: NodeJS.Signals): void {
		if (platform() === "win32") {
			process.kill();
			return;
		}

		process.kill(signal);
	}

	private clearRespawnTimer(): void {
		if (!this.respawnTimer) {
			return;
		}

		clearTimeout(this.respawnTimer);
		this.respawnTimer = undefined;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			setTimeout(resolve, ms);
		});
	}

	private toError(error: unknown): Error {
		return error instanceof Error ? error : new Error(String(error));
	}
}

function isHealthResponse(value: unknown): value is { healthy: true } {
	return (
		typeof value === "object" &&
		value !== null &&
		"healthy" in value &&
		value.healthy === true
	);
}

IConfigurationService(OpencodeServeManager, "", 0);
ILogService(OpencodeServeManager, "", 1);
