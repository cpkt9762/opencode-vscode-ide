/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { DataTransfers } from "../../../../base/browser/dnd.js";
import { addDisposableListener, EventType } from "../../../../base/browser/dom.js";
import { Orientation } from "../../../../base/browser/ui/sash/sash.js";
import { toDisposable } from "../../../../base/common/lifecycle.js";
import { FileAccess } from "../../../../base/common/network.js";
import { relativePath } from "../../../../base/common/resources.js";
import { URI } from "../../../../base/common/uri.js";
import * as nls from "../../../../nls.js";
import { IClipboardService } from "../../../../platform/clipboard/common/clipboardService.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { IContextKeyService } from "../../../../platform/contextkey/common/contextkey.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import {
	CodeDataTransfers,
	containsDragType,
	extractEditorsAndFilesDropData,
} from "../../../../platform/dnd/browser/dnd.js";
import { IHoverService } from "../../../../platform/hover/browser/hover.js";
import { SyncDescriptor } from "../../../../platform/instantiation/common/descriptors.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { IKeybindingService } from "../../../../platform/keybinding/common/keybinding.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { IOpenerService } from "../../../../platform/opener/common/opener.js";
import { Registry } from "../../../../platform/registry/common/platform.js";
import {
	IStorageService,
	StorageScope,
	StorageTarget,
} from "../../../../platform/storage/common/storage.js";
import { IThemeService } from "../../../../platform/theme/common/themeService.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
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
import type { DiffEdit } from "../common/editCodeServiceTypes.js";
import { IOpencodeEditorService } from "../common/opencodeEditorService.js";
import { ISpaProxyService } from "../electron-main/spaProxyService.js";
import { IEditCodeService } from "./editCodeService.js";
import { type IOpencodeMessage, MessageBridge } from "./messageBridge.js";
import { opencodeIcon } from "./opencodeIcons.js";

export const OPENCODE_VIEW_CONTAINER_ID = "workbench.view.opencode";
export const OPENCODE_VIEW_ID = "workbench.view.opencode.chat";

const opencodeSpaPath = "vs/workbench/contrib/opencode/media/spa";
const opencodeContainerTitle = nls.localize2(
	"opencodeViewContainerTitle",
	"OpenCode",
);
const opencodeViewTitle = nls.localize2("opencodeViewTitle", "Chat");
const loadingTimeout = 8000;
const lastSessionStorageKey = "opencode.lastSessionId";
const allowedCommands = new Set([
	"workbench.action.terminal.toggleTerminal",
	"workbench.view.explorer",
]);

type SidebarState = "loading" | "ready" | "error" | "no-project";

export class OpencodeSidebarPane extends ViewPane {
	private readonly messageBridge: MessageBridge;
	private state: SidebarState = "loading";
	private loadingTimer: ReturnType<typeof setTimeout> | undefined;
	private bodyRoot: HTMLElement | undefined;
	private shell: HTMLElement | undefined;
	private loadingView: HTMLElement | undefined;
	private errorView: HTMLElement | undefined;
	private noProjectView: HTMLElement | undefined;
	private iframeUrl: string | undefined;
	private loadRequest = 0;
	private workspaceDir = "";
	private iframe: HTMLIFrameElement | undefined;
	private dragActive = false;

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
		private readonly editCodeService: IEditCodeService,
		private readonly contextService: IWorkspaceContextService,
		private readonly spaProxyService: ISpaProxyService,
		private readonly storageService: IStorageService,
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
		this._register(
			toDisposable(() => {
				this.clearLoadingTimer();
				this.loadRequest += 1;
			}),
		);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.style.padding = "0";
		container.style.overflow = "hidden";
		container.style.height = "100%";
		container.style.position = "relative";

		const animationStyle = document.createElement("style");
		animationStyle.textContent = "@keyframes opencodeSidebarSpin { to { transform: rotate(360deg); } }";
		container.appendChild(animationStyle);

		const root = document.createElement("div");
		root.style.position = "relative";
		root.style.width = "100%";
		root.style.height = "100%";
		root.style.background = "var(--vscode-sideBar-background)";

		const shell = document.createElement("div");
		shell.style.position = "absolute";
		shell.style.inset = "0";
		shell.style.zIndex = "1";
		shell.style.display = "flex";
		shell.style.alignItems = "center";
		shell.style.justifyContent = "center";
		shell.style.padding = "24px";
		shell.style.background = "var(--vscode-sideBar-background)";

		const box = document.createElement("div");
		box.style.width = "min(320px, calc(100% - 48px))";
		box.style.padding = "24px";
		box.style.border = "1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08))";
		box.style.borderRadius = "16px";
		box.style.background = "var(--vscode-editorWidget-background, var(--vscode-sideBar-background))";
		box.style.boxShadow = "0 18px 40px rgba(0, 0, 0, 0.2)";
		box.style.textAlign = "center";
		shell.appendChild(box);

		const loadingView = document.createElement("div");
		const spinner = document.createElement("div");
		spinner.setAttribute("aria-hidden", "true");
		spinner.style.width = "28px";
		spinner.style.height = "28px";
		spinner.style.margin = "0 auto 14px";
		spinner.style.border = "3px solid var(--vscode-progressBar-background, rgba(255, 255, 255, 0.2))";
		spinner.style.borderTopColor = "var(--vscode-textLink-foreground)";
		spinner.style.borderRadius = "999px";
		spinner.style.animation = "opencodeSidebarSpin 0.9s linear infinite";
		loadingView.appendChild(spinner);

		const loadingText = document.createElement("p");
		loadingText.textContent = nls.localize(
			"opencodeSidebar.loading",
			"Connecting to OpenCode…",
		);
		loadingText.style.margin = "0";
		loadingText.style.fontSize = "13px";
		loadingText.style.lineHeight = "1.5";
		loadingText.style.color = "var(--vscode-descriptionForeground, var(--vscode-foreground))";
		loadingView.appendChild(loadingText);
		box.appendChild(loadingView);

		const errorView = document.createElement("div");
		errorView.style.display = "none";

		const errorTitle = document.createElement("h2");
		errorTitle.textContent = nls.localize(
			"opencodeSidebar.errorTitle",
			"OpenCode unavailable",
		);
		errorTitle.style.margin = "0 0 8px";
		errorTitle.style.fontSize = "15px";
		errorView.appendChild(errorTitle);

		const errorText = document.createElement("p");
		errorText.textContent = nls.localize(
			"opencodeSidebar.errorText",
			"Start the local server, then try again.",
		);
		errorText.style.margin = "0 0 16px";
		errorText.style.fontSize = "13px";
		errorText.style.lineHeight = "1.5";
		errorText.style.color = "var(--vscode-descriptionForeground, var(--vscode-foreground))";
		errorView.appendChild(errorText);

		const retryButton = this.createActionButton(
			nls.localize("opencodeSidebar.retry", "Retry"),
			() => this.retryLoad(),
		);
		errorView.appendChild(retryButton);
		box.appendChild(errorView);

		const noProjectView = document.createElement("div");
		noProjectView.style.display = "none";

		const noProjectTitle = document.createElement("h2");
		noProjectTitle.textContent = nls.localize(
			"opencodeSidebar.noProjectTitle",
			"Open a folder to use OpenCode",
		);
		noProjectTitle.style.margin = "0 0 8px";
		noProjectTitle.style.fontSize = "15px";
		noProjectView.appendChild(noProjectTitle);

		const noProjectText = document.createElement("p");
		noProjectText.textContent = nls.localize(
			"opencodeSidebar.noProjectText",
			"This view needs an open workspace folder before the proxy can start.",
		);
		noProjectText.style.margin = "0 0 16px";
		noProjectText.style.fontSize = "13px";
		noProjectText.style.lineHeight = "1.5";
		noProjectText.style.color = "var(--vscode-descriptionForeground, var(--vscode-foreground))";
		noProjectView.appendChild(noProjectText);

		const openFolderButton = this.createActionButton(
			nls.localize("opencodeSidebar.openFolder", "Open Folder"),
			() => {
				void this.executeCommand("vscode.openFolder").then(undefined, (error) => {
					this.logError("[OpenCode] Failed to open folder picker", error);
				});
			},
		);
		noProjectView.appendChild(openFolderButton);
		box.appendChild(noProjectView);

		const iframe = document.createElement("iframe");
		iframe.title = "OpenCode";
		iframe.style.width = "100%";
		iframe.style.height = "100%";
		iframe.style.border = "0";
		iframe.style.display = "none";
		iframe.style.background = "transparent";
		iframe.allow = "clipboard-read; clipboard-write; autoplay";

		root.appendChild(iframe);
		root.appendChild(shell);
		container.appendChild(root);
		this.registerDropTargets(container);
		this.registerIframeDragPassthrough(container, iframe);

		this.bodyRoot = root;
		this.shell = shell;
		this.loadingView = loadingView;
		this.errorView = errorView;
		this.noProjectView = noProjectView;
		this.iframe = iframe;
		this.messageBridge.setIframe(iframe);
		this._register(this.contextService.onDidChangeWorkbenchState(() => this.updateWorkspace()));
		this._register(this.contextService.onDidChangeWorkspaceFolders(() => this.updateWorkspace()));
		this._register(
			toDisposable(() => {
				this.setIframeDragInterception(iframe, false);
				this.clearLoadingTimer();
				this.loadRequest += 1;
				this.bodyRoot = undefined;
				this.shell = undefined;
				this.loadingView = undefined;
				this.errorView = undefined;
				this.noProjectView = undefined;
				this.iframe = undefined;
				this.messageBridge.setIframe(undefined);
				animationStyle.remove();
				root.remove();
				iframe.remove();
			}),
		);

		this.renderState();
		this.updateWorkspace();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);

		if (!this.bodyRoot) {
			return;
		}

		this.bodyRoot.style.height = `${height}px`;
		this.bodyRoot.style.width = `${width}px`;
	}

	private async handleMessage(message: IOpencodeMessage): Promise<void> {
		switch (message.type) {
			case "opencode-web.frame-ready": {
				if (this.state !== "loading") {
					return;
				}

				const url = (message as IOpencodeMessage & { url?: unknown }).url;
				if (
					typeof url === "string" &&
					this.iframeUrl &&
					url !== this.iframeUrl
				) {
					return;
				}

				this.setState("ready");
				return;
			}

			case "opencode-web.session-changed": {
				const sessionId = (message as IOpencodeMessage & { sessionId?: unknown }).sessionId;
				if (typeof sessionId === "string" && sessionId) {
					this.storageService.store(
						lastSessionStorageKey,
						sessionId,
						StorageScope.WORKSPACE,
						StorageTarget.MACHINE,
					);
					return;
				}

				this.storageService.remove(lastSessionStorageKey, StorageScope.WORKSPACE);
				return;
			}

			case "ready": {
				this.messageBridge.send({
					type: "config",
					payload: {
						theme: this.themeService.getColorTheme().type,
						serverUrl: this.opencodeEditorService.getServerUrl(),
					},
				});
				return;
			}

			case "apply-diff-edit": {
				const { editorId, edits } = message.payload as { editorId: string; edits: DiffEdit[] };
				const zoneId = this.editCodeService.createDiffZone(editorId, edits);
				this.messageBridge.send({
					type: "diff-zone-created",
					id: message.id,
					payload: { zoneId },
				});
				return;
			}

			case "llm-request": {
				const { prompt } = message.payload as { prompt: string };
				const response = await this.opencodeEditorService.sendLLMRequest(prompt);
				this.messageBridge.send({
					type: "llm-response",
					id: message.id,
					payload: { response },
				});
				return;
			}

			case "opencode-web.clipboard-write":
			case "opencode.clipboard.write": {
				const text = (message as IOpencodeMessage & { text?: unknown }).text;
				if (typeof text !== "string") {
					return;
				}

				await this.writeClipboardText(text).then(undefined, (error) => {
					this.logError("[OpenCode] Failed to write clipboard text", error);
				});
				return;
			}

			case "opencode-web.clipboard-read": {
				await this.readClipboardText().then(
					(text) => {
						this.messageBridge.send({
							type: "opencode-web.clipboard-text",
							text,
						} as IOpencodeMessage & { text: string });
					},
					(error) => {
						this.logError("[OpenCode] Failed to read clipboard text", error);
					},
				);
				return;
			}

			case "opencode.vscode.command": {
				const command = (message as IOpencodeMessage & { command?: unknown }).command;
				if (typeof command !== "string") {
					return;
				}

				if (!allowedCommands.has(command)) {
					this.logWarning(`[OpenCode] Rejected command from iframe: ${command}`);
					return;
				}

				await this.executeCommand(command).then(undefined, (error) => {
					this.logError(`[OpenCode] Failed to execute command: ${command}`, error);
				});
				return;
			}
		}
	}

	private registerDropTargets(container: HTMLElement): void {
		this._register(addDisposableListener(container, EventType.DRAG_OVER, (event: DragEvent) => {
			if (!this.canHandleDrop(event)) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			if (event.dataTransfer) {
				event.dataTransfer.dropEffect = "copy";
			}
		}));
		this._register(addDisposableListener(container, EventType.DROP, (event: DragEvent) => {
			if (!this.canHandleDrop(event)) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			void this.handlePromptDrop(event);
		}));
	}

	private registerIframeDragPassthrough(container: HTMLElement, iframe: HTMLIFrameElement): void {
		const view = container.ownerDocument.defaultView;
		if (!view) {
			return;
		}

		const updateDragState = (event: DragEvent) => {
			this.setIframeDragInterception(
				iframe,
				this.isRelevantDrag(event.dataTransfer) && this.isEventInsideContainer(container, event),
			);
		};

		this._register(addDisposableListener(view, EventType.DRAG_ENTER, updateDragState, true));
		this._register(addDisposableListener(view, EventType.DRAG_OVER, updateDragState, true));
		this._register(addDisposableListener(view, EventType.DRAG_LEAVE, (event: DragEvent) => {
			if (!this.dragActive) {
				return;
			}

			if (event.clientX !== 0 || event.clientY !== 0) {
				return;
			}

			this.setIframeDragInterception(iframe, false);
		}, true));
		this._register(addDisposableListener(view, EventType.DROP, () => {
			this.setIframeDragInterception(iframe, false);
		}, true));
	}

	private canHandleDrop(event: DragEvent): boolean {
		return containsDragType(
			event,
			DataTransfers.FILES,
			"text/uri-list",
			CodeDataTransfers.FILES,
			CodeDataTransfers.EDITORS,
		);
	}

	private isRelevantDrag(dataTransfer: DataTransfer | null | undefined): boolean {
		const types = Array.from(dataTransfer?.types ?? []);
		return types.some(type =>
			type === DataTransfers.FILES ||
			type === "text/uri-list" ||
			type === CodeDataTransfers.FILES ||
			type === CodeDataTransfers.EDITORS,
		);
	}

	private isEventInsideContainer(container: HTMLElement, event: DragEvent): boolean {
		if (event.target instanceof Node && container.contains(event.target)) {
			return true;
		}

		if (event.clientX === 0 && event.clientY === 0) {
			return false;
		}

		const rect = container.getBoundingClientRect();
		return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
	}

	private setIframeDragInterception(iframe: HTMLIFrameElement, active: boolean): void {
		if (this.dragActive === active) {
			return;
		}

		this.dragActive = active;
		iframe.style.pointerEvents = active ? "none" : "";
	}

	private async handlePromptDrop(event: DragEvent): Promise<void> {
		const text = await this.getDropPromptText(event);
		if (!text) {
			return;
		}

		this.messageBridge.send({
			type: "opencode-web.insert-prompt",
			text,
		} as IOpencodeMessage & { text: string });
	}

	private async getDropPromptText(event: DragEvent): Promise<string | undefined> {
		const editors = await this.instantiationService.invokeFunction(accessor => extractEditorsAndFilesDropData(accessor, event));
		const fromEditors = editors
			.flatMap(editor => editor.resource ? [this.toPromptPath(editor.resource)] : [])
			.filter((path): path is string => Boolean(path));

		if (fromEditors.length > 0) {
			return [...new Set(fromEditors)].map(path => `@${path}`).join(" ");
		}

		const uriList = event.dataTransfer?.getData("text/uri-list");
		if (!uriList) {
			return undefined;
		}

		const paths = uriList
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line && !line.startsWith("#"))
			.flatMap(line => {
				try {
					const path = this.toPromptPath(URI.parse(line));
					return path ? [path] : [];
				} catch {
					return [];
				}
			});

		if (paths.length === 0) {
			return undefined;
		}

		return [...new Set(paths)].map(path => `@${path}`).join(" ");
	}

	private toPromptPath(resource: URI): string | undefined {
		const folder = this.contextService.getWorkspaceFolder(resource);
		if (folder) {
			const path = relativePath(folder.uri, resource);
			if (path) {
				return path;
			}
		}

		if (resource.scheme === "file") {
			return resource.fsPath;
		}

		return resource.path || undefined;
	}

	private createActionButton(label: string, run: () => void): HTMLButtonElement {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = label;
		button.onclick = run;
		button.style.border = "0";
		button.style.borderRadius = "999px";
		button.style.padding = "10px 16px";
		button.style.background = "var(--vscode-button-background)";
		button.style.color = "var(--vscode-button-foreground)";
		button.style.font = "inherit";
		button.style.cursor = "pointer";
		return button;
	}

	private setState(state: SidebarState, options?: { armTimeout?: boolean }): void {
		this.state = state;

		if (state === "loading" && options?.armTimeout !== false) {
			this.armLoadingTimer();
		}

		if (state !== "loading" || options?.armTimeout === false) {
			this.clearLoadingTimer();
		}

		this.renderState();
	}

	private renderState(): void {
		if (!this.shell || !this.loadingView || !this.errorView || !this.noProjectView) {
			return;
		}

		this.shell.style.display = this.state === "ready" ? "none" : "flex";
		this.loadingView.style.display = this.state === "loading" ? "block" : "none";
		this.errorView.style.display = this.state === "error" ? "block" : "none";
		this.noProjectView.style.display = this.state === "no-project" ? "block" : "none";

		if (!this.iframe) {
			return;
		}

		this.iframe.style.display = this.state === "ready" ? "block" : "none";
	}

	private armLoadingTimer(): void {
		this.clearLoadingTimer();
		this.loadingTimer = setTimeout(() => {
			if (this.state !== "loading") {
				return;
			}

			this.setState("error");
		}, loadingTimeout);
	}

	private clearLoadingTimer(): void {
		if (!this.loadingTimer) {
			return;
		}

		clearTimeout(this.loadingTimer);
		this.loadingTimer = undefined;
	}

	private updateWorkspace(): void {
		const workspaceDir = this.contextService.getWorkspace().folders[0]?.uri.fsPath ?? "";
		this.workspaceDir = workspaceDir;

		if (!workspaceDir) {
			this.loadRequest += 1;
			this.iframeUrl = undefined;
			this.setState("no-project");
			return;
		}

		this.loadWorkspace(workspaceDir);
	}

	private loadWorkspace(workspaceDir: string): void {
		const request = ++this.loadRequest;
		this.workspaceDir = workspaceDir;
		this.iframeUrl = undefined;
		this.setState("loading", { armTimeout: false });

		void this.startProxy(workspaceDir).then(
			(url) => {
				if (request !== this.loadRequest || !this.iframe) {
					return;
				}

				this.iframeUrl = url;
				this.navigateIframe(url, request);
			},
			(error) => {
				if (request !== this.loadRequest) {
					return;
				}

				this.logError("[OpenCode] Failed to start proxy", error);
				this.setState("error");
			},
		);
	}

	private navigateIframe(url: string, request: number): void {
		if (!this.iframe) {
			return;
		}

		const iframe = this.iframe;
		const navigate = () => {
			if (request !== this.loadRequest || this.iframe !== iframe) {
				return;
			}

			iframe.src = url;
			this.setState("loading");
		};

		if (iframe.src === url) {
			iframe.src = "about:blank";
			setTimeout(navigate, 0);
			return;
		}

		navigate();
	}

	private retryLoad(): void {
		if (!this.workspaceDir) {
			this.setState("no-project");
			return;
		}

		this.loadWorkspace(this.workspaceDir);
	}

	private async startProxy(workspaceDir: string): Promise<string> {
		await this.spaProxyService.start({
			dist: FileAccess.asFileUri(opencodeSpaPath).fsPath,
		});

		const url = await this.spaProxyService.url(workspaceDir);
		const sessionId = this.storageService.get(lastSessionStorageKey, StorageScope.WORKSPACE);
		if (!sessionId) {
			return url;
		}

		return `${url}/session/${encodeURIComponent(sessionId)}`;
	}

	private executeCommand(command: string): Promise<void> {
		return this.instantiationService.invokeFunction((accessor) =>
			accessor
				.get(ICommandService)
				.executeCommand(command)
				.then(() => undefined),
		);
	}

	private readClipboardText(): Promise<string> {
		return this.instantiationService.invokeFunction((accessor) =>
			accessor.get(IClipboardService).readText(),
		);
	}

	private writeClipboardText(text: string): Promise<void> {
		return this.instantiationService.invokeFunction((accessor) =>
			accessor.get(IClipboardService).writeText(text),
		);
	}

	private logError(message: string, error: unknown): void {
		this.instantiationService.invokeFunction((accessor) => {
			accessor.get(ILogService).error(message, error);
		});
	}

	private logWarning(message: string): void {
		this.instantiationService.invokeFunction((accessor) => {
			accessor.get(ILogService).warn(message);
		});
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
IEditCodeService(OpencodeSidebarPane, "", 11);
IWorkspaceContextService(OpencodeSidebarPane, "", 12);
ISpaProxyService(OpencodeSidebarPane, "", 13);
IStorageService(OpencodeSidebarPane, "", 14);

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
