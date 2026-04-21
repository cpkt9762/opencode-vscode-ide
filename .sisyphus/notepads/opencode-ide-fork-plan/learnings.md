## 2026-04-21

- `iframe.srcdoc` in the VS Code workbench must receive `TrustedHTML` under the Trusted Types CSP; a plain string assignment fails before the sidebar can render.
- Creating a new trusted types policy is not sufficient by itself in this fork: the policy name must also be whitelisted in `src/vs/code/electron-browser/workbench/workbench.html` and `workbench-dev.html` under the `trusted-types` CSP directive.
- After whitelisting `opencodeSidebar`, the original `Failed to set the 'srcdoc' property on 'HTMLIFrameElement'` / `Fail to render view workbench.view.opencode.chat` error disappears from the smoke log, and the remaining failures move downstream into iframe app CSP / Trusted Types issues (`inline script`, `TrustedScript`, `innerHTML`) plus unrelated smoke failures.
