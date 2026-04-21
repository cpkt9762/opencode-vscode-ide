/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// biome-ignore lint/style/useNodejsImportProtocol: electron-main unit tests use node builtins directly.
import assert from 'assert';
// biome-ignore lint/style/useNodejsImportProtocol: electron-main unit tests use node builtins directly.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: electron-main unit tests use node builtins directly.
import { createServer, request, type Server } from 'http';
// biome-ignore lint/style/useNodejsImportProtocol: electron-main unit tests use node builtins directly.
import { tmpdir } from 'os';
// biome-ignore lint/style/useNodejsImportProtocol: electron-main unit tests use node builtins directly.
import { join } from 'path';
// biome-ignore lint/style/useNodejsImportProtocol: electron-main unit tests use node builtins directly.
import { runInNewContext } from 'vm';
import { API, BOOTSTRAP, decodeWorkspaceDir, encodeWorkspaceDir, reuse, stablePort, start } from '../../electron-main/spaProxy.js';

type ResponseData = {
	body: string;
	headers: Record<string, string | string[] | undefined>;
	status: number;
	type: string;
};

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function createDist(files: Record<string, string | Buffer>) {
	const dir = mkdtempSync(join(tmpdir(), 'spa-proxy-'));

	for (const [file, content] of Object.entries(files)) {
		const slash = file.lastIndexOf('/');
		if (slash >= 0) {
			mkdirSync(join(dir, file.slice(0, slash)), { recursive: true });
		}

		writeFileSync(join(dir, file), content);
	}

	return dir;
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<ResponseData> {
	return new Promise((resolve, reject) => {
		const outgoing = request(
			{
				headers,
				hostname: '127.0.0.1',
				method: 'GET',
				path,
				port,
			},
			response => {
				let body = '';
				response.on('data', chunk => body += chunk.toString());
				response.on('end', () => resolve({
					body,
					headers: response.headers,
					status: response.statusCode ?? 0,
					type: response.headers['content-type'] ?? '',
				}));
			},
		);

		outgoing.on('error', reject);
		outgoing.end();
	});
}

function extractBootstrap(body: string) {
	const match = body.match(/<script>([\s\S]*?)<\/script>/);
	assert.ok(match, 'missing bootstrap script');
	return match[1];
}

function runStorage(script: string, dir: string) {
	const storage = new Map<string, string>();
	const localStorage = {
		getItem(key: string) {
			return storage.get(key) ?? null;
		},
		setItem(key: string, value: string) {
			storage.set(key, value);
		},
	};
	const document = {
		activeElement: null,
		addEventListener() {},
		body: {
			appendChild() {},
			removeChild() {},
		},
		head: {
			appendChild() {},
		},
		createElement() {
			return {
				addEventListener() {},
				appendChild() {},
				getBoundingClientRect() {
					return { height: 0, width: 0 };
				},
				parentNode: { removeChild() {} },
				setAttribute() {},
				style: {},
				textContent: '',
				value: '',
			};
		},
		createRange() {
			return { selectNodeContents() {} };
		},
		createTextNode(text: string) {
			return { textContent: text };
		},
		execCommand() {
			return false;
		},
	};
	const window = {
		addEventListener() {},
		document,
		getSelection() {
			return {
				rangeCount: 0,
				toString() {
					return '';
				},
			};
		},
		innerHeight: 768,
		innerWidth: 1024,
		parent: { postMessage() {} },
		__opencodeVscodeApi: undefined,
	};
	class XMLHttpRequestStub {
		status = 200;
		responseText = '[]';

		open() {}
		send() {}
	}

	runInNewContext(script, {
		JSON,
		Object,
		Promise,
		XMLHttpRequest: XMLHttpRequestStub,
		atob(value: string) {
			const padding = (4 - (value.length % 4 || 4)) % 4;
			return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padding), 'base64').toString('binary');
		},
		decodeURIComponent,
		document,
		escape(value: string) {
			return value;
		},
		localStorage,
		location: {
			hostname: '127.0.0.1',
			origin: 'http://127.0.0.1:1',
			pathname: `/${encodeWorkspaceDir(dir)}`,
		},
		navigator: { platform: 'Mac' },
		window,
	});

	return storage;
}

suite('SpaProxy', () => {
	const paths = [
		'/global/health',
		'/auth/openai',
		'/doc',
		'/log',
		'/project/current',
		'/session',
		'/permission',
		'/question',
		'/provider',
		'/config',
		'/pty/spawn',
		'/mcp/status',
		'/experimental/workspace',
		'/tui/control',
		'/find?query=test',
		'/file?path=/tmp/file.txt',
		'/event',
		'/path',
		'/vcs',
		'/command',
		'/agent',
		'/skill',
		'/lsp',
		'/formatter',
		'/instance/dispose',
	];

	test('stable port hash determinism', () => {
		const backend = 'http://127.0.0.1:4096';
		const port = stablePort(backend);

		assert.strictEqual(stablePort(backend), port);
		assert.ok(port >= 49152 && port <= 65535);
	});

	test('reuse returns same port if health matches', async () => {
		const dist = createDist({ 'index.html': '<!doctype html><html><head></head><body></body></html>' });
		const backend = createServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ ok: true }));
		});
		await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
		const address = backend.address();
		const backendUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
		const site = await start({ backend: backendUrl, dist });

		try {
			assert.strictEqual(site.port, stablePort(backendUrl));
			assert.strictEqual(await reuse(site.port, backendUrl), true);
		} finally {
			await closeServer(site.server);
			await closeServer(backend);
			rmSync(dist, { force: true, recursive: true });
		}
	});

	test('25 API prefixes proxied', async () => {
		const dist = createDist({ 'index.html': '<!doctype html><html><head></head><body></body></html>' });
		const backend = createServer((request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ path: request.url, proxied: true }));
		});
		await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
		const address = backend.address();
		const backendUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
		const site = await start({ backend: backendUrl, dist });

		try {
			assert.strictEqual(API.length, 25);
			await Promise.all(paths.map(async path => {
				const response = await get(site.port, path);
				assert.strictEqual(response.status, 200, path);
				assert.ok(response.type.includes('application/json'), path);
				assert.deepStrictEqual(JSON.parse(response.body), { path, proxied: true }, path);
			}));
		} finally {
			await closeServer(site.server);
			await closeServer(backend);
			rmSync(dist, { force: true, recursive: true });
		}
	});

	test('SSE flush + stream', async () => {
		const dist = createDist({ 'index.html': '<!doctype html><html><head></head><body></body></html>' });
		const sent: number[] = [];
		const received: number[] = [];
		const head: number[] = [];
		const log: string[] = [];
		const chunks = ['data: 1\n\n', 'data: 2\n\n', 'data: 3\n\n'];
		const backend = createServer((_request, response) => {
			response.writeHead(200, {
				'cache-control': 'no-cache',
				connection: 'keep-alive',
				'content-type': 'text/event-stream',
			});
			response.flushHeaders();

			const step = (index: number) => {
				if (index >= chunks.length) {
					response.end();
					return;
				}

				setTimeout(() => {
					sent.push(Date.now());
					response.write(chunks[index]);
					step(index + 1);
				}, index === 0 ? 200 : 120);
			};

			step(0);
		});
		await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
		const address = backend.address();
		const backendUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
		const site = await start({ backend: backendUrl, dist, log: message => log.push(message) });

		try {
			const started = Date.now();
			await new Promise<void>((resolve, reject) => {
				const outgoing = request(
					{
						headers: { accept: 'text/event-stream' },
						hostname: '127.0.0.1',
						method: 'GET',
						path: '/event',
						port: site.port,
					},
					response => {
						head.push(Date.now() - started);
						response.on('data', () => received.push(Date.now() - started));
						response.on('end', resolve);
					},
				);

				outgoing.on('error', reject);
				outgoing.end();
			});

			assert.ok(log.includes('[SSE] proxy streaming /event'));
			assert.strictEqual(head.length, 1);
			assert.strictEqual(received.length, chunks.length);
			assert.ok(head[0] < sent[0] - started - 50, `expected headers before first event, got ${head[0]} >= ${sent[0] - started - 50}`);
			assert.ok(received[0] < sent[1] - started - 40, `expected first chunk before second write, got ${received[0]} >= ${sent[1] - started - 40}`);
			assert.ok(received[1] < sent[2] - started - 40, `expected second chunk before third write, got ${received[1]} >= ${sent[2] - started - 40}`);
		} finally {
			await closeServer(site.server);
			await closeServer(backend);
			rmSync(dist, { force: true, recursive: true });
		}
	});

	test('bootstrap injection', async () => {
		const dist = createDist({ 'index.html': '<!doctype html><html><head><title>Test</title></head><body></body></html>' });
		const backend = createServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('{}');
		});
		await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
		const address = backend.address();
		const site = await start({ backend: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, dist });

		try {
			const response = await get(site.port, '/');
			assert.ok(response.body.includes(BOOTSTRAP));
		} finally {
			await closeServer(site.server);
			await closeServer(backend);
			rmSync(dist, { force: true, recursive: true });
		}
	});

	test('health endpoint format', async () => {
		const dist = createDist({ 'index.html': '<!doctype html><html><head></head><body></body></html>' });
		const backend = createServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('{}');
		});
		await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
		const address = backend.address();
		const backendUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
		const site = await start({ backend: backendUrl, dist });

		try {
			const response = await get(site.port, '/opencode-spa-health');
			assert.strictEqual(response.status, 200);
			assert.ok(response.type.includes('application/json'));
			assert.deepStrictEqual(JSON.parse(response.body), { backend: `${backendUrl}/`, ok: true });
		} finally {
			await closeServer(site.server);
			await closeServer(backend);
			rmSync(dist, { force: true, recursive: true });
		}
	});

	test('502 when backend unreachable', async () => {
		const dist = createDist({ 'index.html': '<!doctype html><html><head></head><body></body></html>' });
		const site = await start({ backend: 'http://127.0.0.1:9', dist });

		try {
			const response = await get(site.port, '/project/current');
			assert.strictEqual(response.status, 502);
			assert.strictEqual(response.body, 'backend unavailable');
		} finally {
			await closeServer(site.server);
			rmSync(dist, { force: true, recursive: true });
		}
	});

	test('MIME type dispatch', async () => {
		const dist = createDist({
			'assets/app.css': 'body { color: red; }',
			'assets/app.js': 'console.log(1);',
			'index.html': '<!doctype html><html><head></head><body></body></html>',
			'page.html': '<!doctype html><html><head></head><body>page</body></html>',
		});
		const backend = createServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('{}');
		});
		await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
		const address = backend.address();
		const site = await start({ backend: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, dist });

		try {
			const script = await get(site.port, '/assets/app.js');
			const style = await get(site.port, '/assets/app.css');
			const html = await get(site.port, '/page.html');

			assert.ok(script.type.includes('application/javascript'));
			assert.ok(style.type.includes('text/css'));
			assert.ok(html.type.includes('text/html'));
		} finally {
			await closeServer(site.server);
			await closeServer(backend);
			rmSync(dist, { force: true, recursive: true });
		}
	});

	test('slug decode', () => {
		const dir = '/tmp/current/workspace';
		assert.strictEqual(decodeWorkspaceDir(`/${encodeWorkspaceDir(dir)}/chat`), dir);
	});

	test('index fallback', async () => {
		const dist = createDist({ 'index.html': '<!doctype html><html><head><title>Fallback</title></head><body></body></html>' });
		const backend = createServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('{}');
		});
		await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
		const address = backend.address();
		const site = await start({ backend: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, dist });

		try {
			const response = await get(site.port, `/${encodeWorkspaceDir('/tmp/current')}/nested/route`);
			assert.strictEqual(response.status, 200);
			assert.ok(response.type.includes('text/html'));
			assert.ok(response.body.includes('<title>Fallback</title>'));
		} finally {
			await closeServer(site.server);
			await closeServer(backend);
			rmSync(dist, { force: true, recursive: true });
		}
	});

	test('CORS header present', async () => {
		const dist = createDist({ 'index.html': '<!doctype html><html><head></head><body></body></html>' });
		const backend = createServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('{}');
		});
		await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
		const address = backend.address();
		const site = await start({ backend: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, dist });

		try {
			const response = await get(site.port, '/');
			assert.ok(response.headers['access-control-allow-origin']);
		} finally {
			await closeServer(site.server);
			await closeServer(backend);
			rmSync(dist, { force: true, recursive: true });
		}
	});

	test('localStorage key seeding', async () => {
		const dist = createDist({ 'index.html': '<!doctype html><html><head></head><body></body></html>' });
		const backend = createServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('{}');
		});
		await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
		const address = backend.address();
		const site = await start({ backend: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, dist });

		try {
			const response = await get(site.port, '/');
			const dir = '/tmp/current';
			const storage = runStorage(extractBootstrap(response.body), dir);
			const server = JSON.parse(storage.get('opencode.global.dat:server') ?? 'null');
			const layout = JSON.parse(storage.get('opencode.global.dat:layout') ?? 'null');
			const settings = JSON.parse(storage.get('settings.v3') ?? 'null');

			assert.deepStrictEqual(server.projects.local, [{ expanded: true, worktree: dir }]);
			assert.strictEqual(server.lastProject.local, dir);
			assert.deepStrictEqual(layout, { review: { diffStyle: 'split', panelOpened: false } });
			assert.deepStrictEqual(settings, {
				general: {
					editToolPartsExpanded: true,
					shellToolPartsExpanded: true,
				},
			});
		} finally {
			await closeServer(site.server);
			await closeServer(backend);
			rmSync(dist, { force: true, recursive: true });
		}
	});
});
