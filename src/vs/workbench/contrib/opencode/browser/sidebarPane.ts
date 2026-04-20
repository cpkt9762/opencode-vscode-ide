/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { Orientation } from "../../../../base/browser/ui/sash/sash.js";
import { toDisposable } from "../../../../base/common/lifecycle.js";
import { FileAccess } from "../../../../base/common/network.js";
import * as nls from "../../../../nls.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { IContextKeyService } from "../../../../platform/contextkey/common/contextkey.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IHoverService } from "../../../../platform/hover/browser/hover.js";
import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { IKeybindingService } from "../../../../platform/keybinding/common/keybinding.js";
import { IOpenerService } from "../../../../platform/opener/common/opener.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import { IThemeService } from "../../../../platform/theme/common/themeService.js";
import {
	type IViewPaneOptions,
	ViewPane,
} from "../../../browser/parts/views/viewPane.js";
import { ViewPaneContainer } from "../../../browser/parts/views/viewPaneContainer.js";
import {
	type IViewContainersRegistry,
	IViewDescriptorService,
	type IViewsRegistry,
	ViewContainerLocation,
	Extensions as ViewExtensions,
} from "../../../common/views.js";
import { IOpencodeEditorService } from "../common/opencodeEditorService.js";
import { type IOpencodeMessage, MessageBridge } from "./messageBridge.js";
import { opencodeIcon } from "./opencodeIcons.js";

export const OPENCODE_VIEW_CONTAINER_ID = "workbench.view.opencode";
export const OPENCODE_VIEW_ID = "workbench.view.opencode.chat";

const opencodeMediaPath = "vs/workbench/contrib/opencode/media";
const opencodeContainerTitle = nls.localize2(
	"opencodeViewContainerTitle",
	"OpenCode",
);
const opencodeViewTitle = nls.localize2("opencodeViewTitle", "Chat");

const escapeAttribute = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;");

export class OpencodeSidebarPane extends ViewPane {
	private readonly html: string;
	private readonly messageBridge: MessageBridge;
	private iframe: HTMLIFrameElement | undefined;

	constructor(
		options: IViewPaneOptions,
		keybindingService: IKeybindingService,
		contextMenuService: IContextMenuService,
		configurationService: IConfigurationService,
		contextKeyService: IContextKeyService,
		viewDescriptorService: IViewDescriptorService,
		instantiationService: IInstantiationService,
		openerService: IOpenerService,
		themeService: IThemeService,
		hoverService: IHoverService,
		private readonly opencodeEditorService: IOpencodeEditorService,
	) {
		super(
			options,
			keybindingService,
			contextMenuService,
			configurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			hoverService,
		);

		this.messageBridge = this._register(new MessageBridge());
		this._register(
			this.messageBridge.onMessage((message) => {
				void this.handleMessage(message);
			}),
		);
		this.html = this.buildSpaHtml();
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.style.padding = "0";
		container.style.overflow = "hidden";
		container.style.height = "100%";

		const iframe = document.createElement("iframe");
		iframe.style.width = "100%";
		iframe.style.height = "100%";
		iframe.style.border = "0";
		iframe.style.display = "block";
		iframe.style.background = "transparent";
		iframe.setAttribute(
			"sandbox",
			"allow-downloads allow-forms allow-popups allow-same-origin allow-scripts",
		);
		iframe.srcdoc = this.html;

		container.appendChild(iframe);
		this.iframe = iframe;
		this.messageBridge.setIframe(iframe);
		this._register(
			toDisposable(() => {
				this.iframe = undefined;
				this.messageBridge.setIframe(undefined);
				iframe.remove();
			}),
		);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);

		if (!this.iframe) {
			return;
		}

		this.iframe.style.height = `${height}px`;
		this.iframe.style.width = `${width}px`;
	}

	private async handleMessage(message: IOpencodeMessage): Promise<void> {
		if (message.type === 'ready') {
			this.messageBridge.send({
				type: 'config',
				payload: {
					theme: this.themeService.getColorTheme().type,
					serverUrl: this.opencodeEditorService.getServerUrl(),
				},
			});
			return;
		}

		if (message.type !== 'llm-request') {
			return;
		}

		const prompt = this.getPrompt(message.payload);
		const response = await this.opencodeEditorService.sendLLMRequest(prompt);
		this.messageBridge.send({
			type: 'llm-response',
			id: message.id,
			payload: {
				prompt,
				response,
			},
		});
	}

	private getPrompt(payload: unknown): string {
		if (typeof payload === 'string') {
			return payload;
		}

		if (!payload || typeof payload !== 'object') {
			return '';
		}

		const prompt = (payload as { prompt?: unknown }).prompt;
		return typeof prompt === 'string' ? prompt : '';
	}

	private buildSpaHtml(): string {
		const baseHref = `${FileAccess.asBrowserUri(opencodeMediaPath).toString(true)}/`;
		const cssHref = FileAccess.asBrowserUri(
			`${opencodeMediaPath}/opencode-spa.css`,
		).toString(true);
		const scriptHref = FileAccess.asBrowserUri(
			`${opencodeMediaPath}/opencode-spa.js`,
		).toString(true);
		const serverUrl = this.opencodeEditorService.getServerUrl();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content" />
	<base href="${escapeAttribute(baseHref)}" />
	<link rel="stylesheet" href="${escapeAttribute(cssHref)}" />
	<style>
		html, body {
			margin: 0;
			width: 100%;
			height: 100%;
			background: var(--background-base, #1f1f1f);
		}

		body {
			position: relative;
			overflow: hidden;
		}

		#root {
			height: 100%;
		}

		#opencode-fallback {
			position: absolute;
			inset: 0;
			display: flex;
			align-items: center;
			justify-content: center;
			font-family: var(--font-family-sans, sans-serif);
			font-size: 14px;
			color: var(--vscode-foreground, #cccccc);
			background: linear-gradient(180deg, rgba(0, 0, 0, 0.18), rgba(0, 0, 0, 0.06));
			pointer-events: none;
		}
	</style>
</head>
<body class="antialiased overscroll-none text-12-regular overflow-hidden">
	<div id="root" class="flex flex-col h-dvh p-px"></div>
	<div id="opencode-fallback">OpenCode Chat</div>
	<script>
		(() => {
			const themeIdKey = "opencode-theme-id";
			const serverUrlKey = "opencode.settings.dat:defaultServerUrl";
			let themeId = "oc-2";
			let scheme = "system";

			try {
				themeId = localStorage.getItem(themeIdKey) || themeId;
				scheme = localStorage.getItem("opencode-color-scheme") || scheme;
				if (!localStorage.getItem(serverUrlKey)) {
					localStorage.setItem(serverUrlKey, ${JSON.stringify(serverUrl)});
				}
			} catch {
				// Ignore storage failures in sandboxed environments.
			}

			const isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
			document.documentElement.dataset.theme = themeId === "oc-1" ? "oc-2" : themeId;
			document.documentElement.dataset.colorScheme = isDark ? "dark" : "light";

			const root = document.getElementById("root");
			const fallback = document.getElementById("opencode-fallback");
			if (!(root instanceof HTMLElement) || !(fallback instanceof HTMLElement)) {
				return;
			}

			const syncFallback = () => {
				fallback.hidden = root.childElementCount > 0;
			};

			new MutationObserver(syncFallback).observe(root, { childList: true, subtree: true });
			window.addEventListener("load", syncFallback, { once: true });
			setTimeout(syncFallback, 2000);
		})();
	</script>
	<script type="module" src="${escapeAttribute(scriptHref)}"></script>
</body>
</html>`;
	}
}

IKeybindingService(OpencodeSidebarPane, "", 1);
IContextMenuService(OpencodeSidebarPane, "", 2);
IConfigurationService(OpencodeSidebarPane, "", 3);
IContextKeyService(OpencodeSidebarPane, "", 4);
IViewDescriptorService(OpencodeSidebarPane, "", 5);
IInstantiationService(OpencodeSidebarPane, "", 6);
IOpenerService(OpencodeSidebarPane, "", 7);
IThemeService(OpencodeSidebarPane, "", 8);
IHoverService(OpencodeSidebarPane, "", 9);
IOpencodeEditorService(OpencodeSidebarPane, "", 10);

const opencodeViewContainer = Registry.as<IViewContainersRegistry>(
	ViewExtensions.ViewContainersRegistry,
).registerViewContainer(
	{
		id: OPENCODE_VIEW_CONTAINER_ID,
		title: opencodeContainerTitle,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [
			OPENCODE_VIEW_CONTAINER_ID,
			{
				mergeViewWithContainerWhenSingleView: true,
				orientation: Orientation.VERTICAL,
			},
		]),
		icon: opencodeIcon,
		order: 100,
		hideIfEmpty: false,
		rejectAddedViews: true,
	},
	ViewContainerLocation.Sidebar,
	{ doNotRegisterOpenCommand: true },
);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews(
	[
		{
			id: OPENCODE_VIEW_ID,
			name: opencodeViewTitle,
			containerTitle: nls.localize("opencodeContainerTitle", "OpenCode"),
			singleViewPaneContainerTitle: nls.localize(
				"opencodeSingleViewPaneTitle",
				"OpenCode",
			),
			ctorDescriptor: new SyncDescriptor(OpencodeSidebarPane),
			canToggleVisibility: false,
			canMoveView: false,
			hideByDefault: false,
			weight: 100,
			order: 1,
			containerIcon: opencodeIcon,
		},
	],
	opencodeViewContainer,
);
