# OpenCode sessions SSE transport decision

## Chosen approach

Use `fetch + ReadableStream` for the sessions-panel SSE listener. Task 6 should open the events endpoint with `fetch()`, send `Accept: text/event-stream`, validate the response status and content type, then parse `response.body.getReader()` chunks until cancellation or disconnect.

Illustrative service stub only:

```ts
const response = await fetch(eventsUrl, { headers: { Accept: 'text/event-stream' }, signal });
const reader = response.body?.getReader();
const chunk = await reader?.read();
// feed chunk.value into the sessions SSE parser until chunk.done or signal aborts
```

## Rationale

1. **No native `EventSource` precedent was found in the VSCode source scan.** `grep -rn "new EventSource" src/vs/` returned no matches. A broader `EventSource` search only found unrelated enum/string names and MCP handle naming, not renderer-side construction of the DOM `EventSource` API.
2. **VSCode already has an SSE-over-fetch precedent.** `src/vs/workbench/api/common/extHostMcp.ts` sends `Accept: text/event-stream`, checks `content-type`, and consumes the stream through `res.body.getReader()` in `_doSSE()`. That precedent is not the OpenCode renderer service itself, but it is inside the VSCode workbench tree and uses the same web-standard stream primitives Task 6 needs.
3. **The OpenCode proxy explicitly supports fetch-style SSE negotiation.** `spaProxy.ts` treats either the incoming `Accept` header or upstream `Content-Type` as the live-stream signal, then disables buffering and pipes chunks through. `fetch` lets Task 6 set the `Accept` header intentionally and report non-SSE status/content-type failures before attaching the parser.
4. **Cancellation and diagnostics are clearer with `fetch`.** The sessions service can use `AbortController`/`CancellationToken` wiring, inspect HTTP status codes, log invalid content types, and close the reader explicitly. Native `EventSource` hides most response metadata and gives less control over lifecycle behavior.
5. **CSP risk is the same class for both candidates.** The workbench CSP allows `http://127.0.0.1:*` for `frame-src`, but `connect-src` currently lists only `'self'`, `https:`, and `ws:`. Both `fetch` and native `EventSource` are governed by connection policy, so choosing `EventSource` would not avoid that restriction.

Concrete findings:

- Native `new EventSource` usages in `src/vs/`: none found, including no renderer-side workbench usage.
- Fetch-SSE patterns: `src/vs/workbench/api/common/extHostMcp.ts` uses `Accept: text/event-stream`, content-type checks, and `res.body.getReader()`; the required `ReadableStream` grep under `src/vs/workbench/` mostly found VSCode `ReadableStreamEvents`/`VSBufferReadableStream` utilities rather than a renderer-side sessions precedent.
- CSP/fetch policy: `src/vs/code/electron-browser/workbench/workbench.html` and `workbench-dev.html` include `connect-src 'self' https: ws:` and do not list `http://127.0.0.1:*` for connections. That may block direct renderer HTTP SSE to the local proxy unless Task 6 routes through an allowed origin/path or a main-process bridge.

## Fallback plan

If Task 6 proves that workbench renderer CSP blocks direct `fetch` streaming to the loopback proxy, do not switch to native `EventSource`. Instead, keep the `fetch + ReadableStream` parser contract and move only the transport boundary behind an OpenCode-owned Electron-main IPC bridge under `src/vs/workbench/contrib/opencode/`. The bridge can read the same SSE endpoint from the main process and forward parsed session-change notifications to the renderer, avoiding global CSP changes and preserving the chosen stream parser/lifecycle model.

If the direct renderer request is allowed but the response body is missing or not streamable, fail closed: log the status/content type, disable realtime for that panel instance, and rely on explicit refresh until the transport is fixed.

## References

- `src/vs/workbench/contrib/opencode/electron-main/spaProxy.ts:702-707` — `sse()` detects `text/event-stream` in request/response headers.
- `src/vs/workbench/contrib/opencode/electron-main/spaProxy.ts:774-807` — `proxy()` marks SSE as live, flushes headers, disables socket buffering/timeouts, and writes upstream chunks directly to the response.
- `src/vs/workbench/api/common/extHostMcp.ts:422-427` — VSCode workbench precedent for sending `Accept: text/event-stream` through `fetch` headers.
- `src/vs/workbench/api/common/extHostMcp.ts:499-513` — VSCode workbench precedent for recognizing `text/event-stream` responses and dispatching them into an SSE parser.
- `src/vs/workbench/api/common/extHostMcp.ts:675-697` — VSCode workbench precedent for consuming SSE with `res.body.getReader()`.
- `src/vs/code/electron-browser/workbench/workbench.html:23-41` — production workbench CSP allows the OpenCode iframe origin in `frame-src`, but does not list loopback HTTP in `connect-src`.
- `src/vs/code/electron-browser/workbench/workbench-dev.html:23-42` — development workbench CSP has the same `frame-src`/`connect-src` shape.
- `https://html.spec.whatwg.org/multipage/server-sent-events.html` — HTML Standard section for Server-sent events and the native `EventSource` processing model.
