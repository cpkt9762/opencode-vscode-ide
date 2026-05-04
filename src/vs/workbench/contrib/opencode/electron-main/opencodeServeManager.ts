/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// biome-ignore lint/style/useNodejsImportProtocol: bare specifier required for Electron renderer test loader compatibility.
import { type ChildProcess, type SpawnOptions, execSync, spawn } from "child_process";
// biome-ignore lint/style/useNodejsImportProtocol: bare specifier required for Electron renderer test loader compatibility.
import { randomBytes } from "crypto";
// biome-ignore lint/style/useNodejsImportProtocol: bare specifier required for Electron renderer test loader compatibility.
import { accessSync, constants, existsSync } from "fs";
// biome-ignore lint/style/useNodejsImportProtocol: bare specifier required for Electron renderer test loader compatibility.
import { request as httpRequest } from "http";
// biome-ignore lint/style/useNodejsImportProtocol: bare specifier required for Electron renderer test loader compatibility.
import { request as httpsRequest } from "https";
// biome-ignore lint/style/useNodejsImportProtocol: bare specifier required for Electron renderer test loader compatibility.
import { homedir, platform } from "os";
// biome-ignore lint/style/useNodejsImportProtocol: bare specifier required for Electron renderer test loader compatibility.
import { join } from "path";
import {
	Disposable,
	type IDisposable,
} from "../../../../base/common/lifecycle.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { IEnvironmentMainService } from "../../../../platform/environment/electron-main/environmentMainService.js";
import {
	InstantiationType,
	registerSingleton,
} from "../../../../platform/instantiation/common/extensions.js";
import { createDecorator } from "../../../../platform/instantiation/common/instantiation.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { getResolvedShellEnv } from "../../../../platform/shell/node/shellEnv.js";

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
	getPassword(): string | undefined;
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
	private password: string | undefined;
	private startTask: Promise<string> | undefined;
	private state: OpencodeProcessState = "stopped";
	private weStarted = false;
	private stopRequested = false;
	private respawnTimer: ReturnType<typeof setTimeout> | undefined;

	get backendUrl(): string | undefined {
		return this._backendUrl;
	}

	getPassword(): string | undefined {
		return this.password;
	}

	protected get _testWeStarted(): boolean {
		return this.weStarted;
	}

	protected get _testState(): OpencodeProcessState {
		return this.state;
	}

	constructor(
		private readonly configurationService: IConfigurationService,
		private readonly logService: ILogService,
		private readonly environmentMainService: IEnvironmentMainService,
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

	protected spawnProcess(
		command: string,
		args: readonly string[],
		options: SpawnOptions,
	): ChildProcess {
		return spawn(command, args, options);
	}

	private async doStart(): Promise<string> {
		this.clearRespawnTimer();
		this.stopRequested = false;
		this.password =
			this.getServerPassword() ??
			this.password ??
			randomBytes(16).toString("hex");

		const port = this.getPort();
		const backendUrl = this.getConfiguredBackendUrl();
		if (await this.isHealthy(backendUrl, this.password)) {
			this.state = "running";
			this.weStarted = false;
			this._backendUrl = backendUrl;
			this.logService.info(
				"[opencode] using existing opencode serve",
				backendUrl,
			);
			return backendUrl;
		}

		await this.killStaleServer(port);

		// macOS GUI launches inherit launchd's minimal PATH; resolve the user's login-shell
		// env so opencode serve and its child processes (e.g. rust-analyzer spawned by the
		// oh-my-opencode plugin) see the same PATH the user has in their terminal.
		const mergedEnv = await this.getMergedEnv();

		const binaryPath = this.findBinaryPath(mergedEnv);
		if (!binaryPath) {
			throw new Error(
				"Failed to find an opencode binary. Configure opencode.binaryPath or add opencode to PATH.",
			);
		}

		const deadline = Date.now() + STARTUP_TIMEOUT;
		const env = { ...mergedEnv };
		delete env.OPENCODE_SERVER_PASSWORD;
		env.OPENCODE_SERVER_PASSWORD = this.password;
		const proc = this.spawnProcess(
			binaryPath,
			[
				"serve",
				"--hostname",
				"127.0.0.1",
				"--port",
				String(port),
			],
			{
				env,
				stdio: ["ignore", "pipe", "pipe"],
				shell: platform() === "win32" && binaryPath.endsWith(".cmd"),
			},
		);

		this.process = proc;
		this.state = "starting";
		this.weStarted = true;
		this.watchProcess(proc);

		try {
			const readyUrl = await this.waitForReadyUrl(proc, deadline);
			const normalizedUrl = this.normalizeBackendUrl(readyUrl, port);
			await this.waitForHealthy(normalizedUrl, deadline, this.password);
			this.state = "running";
			this._backendUrl = normalizedUrl;
			this.logService.info("[opencode] opencode serve ready", normalizedUrl);
			return normalizedUrl;
		} catch (error) {
			this.state = "stopped";
			this._backendUrl = undefined;

			if (this.process === proc) {
				this.process = undefined;
			}

			if (proc.exitCode === null && proc.signalCode === null) {
				this.kill(proc, "SIGKILL");
				await this.waitForExit(proc);
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

	private async waitForHealthy(
		url: string,
		deadline: number,
		password: string | undefined,
	): Promise<void> {
		while (Date.now() < deadline) {
			if (await this.isHealthy(url, password)) {
				return;
			}

			await this.sleep(HEALTH_RETRY_DELAY);
		}

		throw new Error(
			`Timed out waiting for ${url}/global/health to report healthy=true.`,
		);
	}

	private async isHealthy(
		url: string,
		password: string | undefined,
	): Promise<boolean> {
		try {
			const response = await this.readHealth(url, password);
			return isHealthResponse(response.body);
		} catch {
			return false;
		}
	}

	private readHealth(
		url: string,
		password: string | undefined,
	): Promise<{ statusCode: number; body?: unknown }> {
		const endpoint = new URL("/global/health", url);
		const request = endpoint.protocol === "https:" ? httpsRequest : httpRequest;
		const authorization = password
			? `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
			: undefined;

		return new Promise<{ statusCode: number; body?: unknown }>((resolve, reject) => {
			const req = request(
				endpoint,
				{
					headers: authorization
						? { Authorization: authorization }
						: undefined,
					method: "GET",
				},
				(response) => {
				let body = "";

				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					body += chunk;
				});
				response.on("end", () => {
					const statusCode = response.statusCode ?? 0;

					if (statusCode === 401) {
						// opencode can require auth here before an API key is configured.
						resolve({ statusCode });
						return;
					}

					if (
						statusCode < 200 ||
						statusCode >= 300
					) {
						reject(
							new Error(
								`Unexpected health status code: ${response.statusCode ?? "unknown"}`,
							),
						);
						return;
					}

					try {
						resolve({ statusCode, body: JSON.parse(body) });
					} catch (error) {
						reject(this.toError(error));
					}
				});
				},
			);

			req.setTimeout(HEALTH_TIMEOUT, () => {
				req.destroy(new Error(`Timed out waiting for ${endpoint.toString()}`));
			});
			req.on("error", reject);
			req.end();
		});
	}

	private findBinaryPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
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

		const pathBinary = this.findBinaryOnPath(env);
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

	protected async getMergedEnv(): Promise<NodeJS.ProcessEnv> {
		let shellEnv: typeof process.env = {};
		try {
			shellEnv = await getResolvedShellEnv(
				this.configurationService,
				this.logService,
				this.environmentMainService.args,
				process.env,
			);
		} catch (error) {
			this.logService.error(
				"[opencode] failed to resolve shell environment for opencode serve",
				error,
			);
		}
		return { ...process.env, ...shellEnv };
	}

	protected async killStaleServer(port: number): Promise<void> {
		const url = `http://127.0.0.1:${port}/`;

		try {
			if (await this.isHealthy(url, this.password)) {
				return;
			}
		} catch {
			// Treat any error as not healthy.
		}

		const pid = await this.findProcessOnPort(port);
		if (pid === undefined) {
			return;
		}

		this.logService.warn("[opencode] killing stale process holding port", {
			pid,
			port,
		});
		try {
			process.kill(pid, "SIGKILL");
		} catch (error) {
			this.logService.warn("[opencode] failed to kill stale process", {
				pid,
				error,
			});
			return;
		}

		await this.sleep(500);
	}

	protected async findProcessOnPort(port: number): Promise<number | undefined> {
		if (platform() === "win32") {
			try {
				const output = execSync("netstat -ano -p tcp", { encoding: "utf8" });
				const re = new RegExp(
					`\\s127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)$`,
				);
				for (const line of output.split(/\r?\n/)) {
					const match = re.exec(line);
					if (match) {
						return Number(match[1]);
					}
				}
				return undefined;
			} catch {
				return undefined;
			}
		}

		try {
			const output = execSync(`lsof -t -iTCP:${port} -sTCP:LISTEN`, {
				encoding: "utf8",
			}).trim();
			if (!output) {
				return undefined;
			}

			const pid = Number(output.split(/\r?\n/)[0]);
			return Number.isFinite(pid) ? pid : undefined;
		} catch {
			return undefined;
		}
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

	private findBinaryOnPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
		const command =
			platform() === "win32" ? "where opencode" : "which opencode";

		try {
			const output = execSync(command, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				env,
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
		return this.configurationService.getValue<boolean>("opencode.autoStart") === true;
	}

	private getPort(): number {
		const configuredPort =
			this.configurationService.getValue<number>("opencode.port");
		return typeof configuredPort === "number" &&
			Number.isInteger(configuredPort) &&
			configuredPort > 0 &&
			configuredPort <= 65_535
			? configuredPort
			: 5888;
	}

	private getBinaryPath(): string | undefined {
		const configuredPath = this.configurationService
			.getValue<string>("opencode.binaryPath")
			?.trim();
		return configuredPath ? configuredPath : undefined;
	}

	private getServerPassword(): string | undefined {
		const configuredPassword = this.configurationService
			.getValue<string>("opencode.serverPassword")
			?.trim();
		return configuredPassword ? configuredPassword : undefined;
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
IEnvironmentMainService(OpencodeServeManager, "", 2);

registerSingleton(
	IOpencodeServeManager,
	OpencodeServeManager,
	InstantiationType.Eager,
);
