/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Lazy } from '../../../../base/common/lazy.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { type IPCServer, ProxyChannel, StaticRouter } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { ActiveWindowManager } from '../../../../platform/windows/node/windowTracker.js';
import type { ApplyEditRequest, ApplyPatchRequest, ApplyWriteRequest, IEditBridgeService } from '../common/editBridgeTypes.js';
import { stablePort } from './portUtils.js';

const BODY_LIMIT = 10 * 1024 * 1024;

export const IHostBridgeService = createDecorator<IHostBridgeService>('opencodeHostBridgeService');

export interface IHostBridgeService {
	readonly _serviceBrand: undefined;
	initialize(ipcServer: IPCServer<string>, activeWindowManager: ActiveWindowManager): Promise<void>;
	getPort(): number;
	stop(): Promise<void>;
}

function asHeader(value: string | string[] | undefined) {
	return Array.isArray(value) ? value[0] : value;
}

function isJsonContentType(value: string | string[] | undefined) {
	return asHeader(value)?.toLowerCase().includes('application/json') ?? false;
}

function message(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function status(error: unknown) {
	return /not implemented/i.test(message(error)) ? 501 : 500;
}

function writeJson(res: ServerResponse, code: number, body: unknown) {
	if (res.writableEnded) {
		return;
	}

	res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(body));
}

function port(server: Server) {
	const address = server.address();
	return typeof address === 'object' && address ? address.port : undefined;
}

function close(server: Server) {
	return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function parseJsonBody<T>(incoming: IncomingMessage, res: ServerResponse) {
	if (!isJsonContentType(incoming.headers['content-type'])) {
		writeJson(res, 415, { error: 'Content-Type must be application/json' });
		return Promise.resolve(undefined);
	}

	return new Promise<T | undefined>(resolve => {
		let done = false;
		let size = 0;
		const chunks: Buffer[] = [];
		const finish = (value: T | undefined) => {
			if (done) {
				return;
			}

			done = true;
			resolve(value);
		};

		incoming.on('data', chunk => {
			if (done) {
				return;
			}

			const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += value.byteLength;
			if (size > BODY_LIMIT) {
				writeJson(res, 413, { error: 'Payload too large' });
				incoming.destroy();
				finish(undefined);
				return;
			}

			chunks.push(value);
		});

		incoming.on('end', () => {
			if (done) {
				return;
			}

			try {
				finish(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
			} catch {
				writeJson(res, 400, { error: 'Invalid JSON body' });
				finish(undefined);
			}
		});

		incoming.on('error', error => {
			if (done) {
				return;
			}

			writeJson(res, 400, { error: message(error) });
			finish(undefined);
		});
	});
}

export class HostBridgeService extends Disposable implements IHostBridgeService {
	declare readonly _serviceBrand: undefined;

	private bridgeProxy: Lazy<IEditBridgeService> | undefined;
	private _port: number | undefined;
	private server: Server | undefined;

	constructor(
		private readonly logService: ILogService,
	) {
		super();
	}

	async initialize(ipcServer: IPCServer<string>, activeWindowManager: ActiveWindowManager): Promise<void> {
		if (this.server) {
			return;
		}

		const router = new StaticRouter<string>(ctx =>
			activeWindowManager.getActiveClientId().then(id =>
				id !== undefined ? ctx === id : true
			),
		);
		this.bridgeProxy = new Lazy(() =>
			ProxyChannel.toService<IEditBridgeService>(ipcServer.getChannel('opencodeEditBridge', router)),
		);

		const server = createServer((incoming, res) => {
			void this.handleRequest(server, incoming, res).catch(error => {
				this.logService.error('[opencode] hostBridge request failed', error);
				writeJson(res, status(error), { error: message(error) });
			});
		});
		const preferred = stablePort('opencode-edit-bridge');

		await new Promise<void>((resolve, reject) => {
			let finished = false;
			const complete = (error?: Error) => {
				if (finished) {
					return;
				}

				finished = true;
				if (error) {
					reject(error);
					return;
				}

				this.server = server;
				this._port = port(server);
				this.logService.info(`[opencode] hostBridge preferred=${preferred} actual=${this._port} stable=${this._port === preferred}`);
				resolve();
			};

			server.on('error', (error: NodeJS.ErrnoException) => {
				if (error.code !== 'EADDRINUSE') {
					complete(error);
					return;
				}

				this.logService.warn(`[opencode] hostBridge port ${preferred} in use, falling back to random`);
				server.listen(0, '127.0.0.1');
			});

			server.listen(preferred, '127.0.0.1', () => complete());
		});
	}

	getPort() {
		if (this._port === undefined) {
			throw new Error('HostBridgeService not initialized');
		}

		return this._port;
	}

	async stop() {
		if (!this.server) {
			this._port = undefined;
			return;
		}

		const server = this.server;
		this.server = undefined;
		this._port = undefined;
		this.bridgeProxy = undefined;
		await close(server);
	}

	private async handleRequest(server: Server, incoming: IncomingMessage, res: ServerResponse) {
		const expectedHost = `127.0.0.1:${port(server) ?? this._port ?? 0}`;
		if (asHeader(incoming.headers.host) !== expectedHost) {
			writeJson(res, 403, { error: 'Forbidden host' });
			return;
		}

		const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
		if (incoming.method === 'GET' && url.pathname === '/health') {
			writeJson(res, 200, { ok: true });
			return;
		}

		if (incoming.method === 'GET' && url.pathname === '/read-buffer') {
			const filePath = url.searchParams.get('path');
			if (!filePath) {
				writeJson(res, 400, { error: 'Missing path parameter' });
				return;
			}

			await this.respond(res, () => this.proxy.readBuffer(filePath));
			return;
		}

		if (incoming.method === 'POST' && url.pathname === '/apply-edit') {
			const body = await parseJsonBody<ApplyEditRequest>(incoming, res);
			if (!body) {
				return;
			}

			await this.respond(res, () => this.proxy.applyEdit(body));
			return;
		}

		if (incoming.method === 'POST' && url.pathname === '/apply-write') {
			const body = await parseJsonBody<ApplyWriteRequest>(incoming, res);
			if (!body) {
				return;
			}

			await this.respond(res, () => this.proxy.applyWrite(body));
			return;
		}

		if (incoming.method === 'POST' && url.pathname === '/apply-patch') {
			const body = await parseJsonBody<ApplyPatchRequest>(incoming, res);
			if (!body) {
				return;
			}

			await this.respond(res, () => this.proxy.applyPatch(body));
			return;
		}

		writeJson(res, 404, { error: 'Not found' });
	}

	private async respond(res: ServerResponse, fn: () => Promise<unknown>) {
		const maxRetries = 10;
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				writeJson(res, 200, await fn());
				return;
			} catch (error) {
				const msg = message(error);
				if (attempt < maxRetries && /timed out/i.test(msg)) {
					this.logService.info(`[opencode] hostBridge channel not ready, retry ${attempt + 1}/${maxRetries}`);
					await new Promise(r => setTimeout(r, 1000));
					continue;
				}
				writeJson(res, status(error), { error: msg });
				return;
			}
		}
	}

	private get proxy() {
		if (!this.bridgeProxy) {
			throw new Error('HostBridgeService not initialized');
		}

		return this.bridgeProxy.value;
	}
}

ILogService(HostBridgeService, '', 0);

registerSingleton(IHostBridgeService, HostBridgeService, InstantiationType.Eager);
