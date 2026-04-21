## 2026-04-21

- `iframe.srcdoc` in the VS Code workbench must receive `TrustedHTML` under the Trusted Types CSP; a plain string assignment fails before the sidebar can render.
- Creating a new trusted types policy is not sufficient by itself in this fork: the policy name must also be whitelisted in `src/vs/code/electron-browser/workbench/workbench.html` and `workbench-dev.html` under the `trusted-types` CSP directive.
- After whitelisting `opencodeSidebar`, the original `Failed to set the 'srcdoc' property on 'HTMLIFrameElement'` / `Fail to render view workbench.view.opencode.chat` error disappears from the smoke log, and the remaining failures move downstream into iframe app CSP / Trusted Types issues (`inline script`, `TrustedScript`, `innerHTML`) plus unrelated smoke failures.
- Moving the iframe bootstrap into a separate `opencode-spa-init.js` file removes the inline `<script>` CSP violation from the smoke log and lets us patch Trusted Types sinks before the SPA bundle executes.
- The vendored app bundle assumes a browser `location.origin`; inside the iframe it resolves the backend as `null/...` unless the bootstrap rewrites the effective server URL before the app initializes.
- After rewriting the effective server URL to `http://127.0.0.1:4096`, the next hard blocker is iframe `connect-src` CSP: requests to `/global/event`, `/path`, `/project`, `/session`, etc. are all denied by `connect-src 'self' https: ws:`.
- Once the iframe begins booting far enough to mount, it steals focus, which breaks later smoke steps that rely on Quick Input unless the iframe focus behavior is also tamed.
- Allowing loopback URLs in `workbench.html` / `workbench-dev.html` removes the `connect-src 'self' https: ws:` CSP violation for `http://127.0.0.1:4096/...`; round 4 no longer reports CSP-denied loopback requests.
- After the `connect-src` fix, the next blocker is transport-level availability: the iframe now reaches `http://127.0.0.1:4096`, but the smoke run shows `net::ERR_CONNECTION_REFUSED` for `/global/event`, `/project`, and `/path`.
- Round 4 still ends at `0 passing, 8 failing`, so the CSP change was necessary but not sufficient; the next round needs to investigate why the sidebar iframe cannot talk to the local backend during smoketests and whether iframe focus should be handed back after load.
