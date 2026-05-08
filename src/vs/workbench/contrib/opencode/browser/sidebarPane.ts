/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { DataTransfers } from "../../../../base/browser/dnd.js";
import { addDisposableListener, EventType } from "../../../../base/browser/dom.js";
import { HoverPosition } from "../../../../base/browser/ui/hover/hoverWidget.js";
import { Orientation } from "../../../../base/browser/ui/sash/sash.js";
import type { IView, SplitView } from "../../../../base/browser/ui/splitview/splitview.js";
import { Emitter, Event } from "../../../../base/common/event.js";
import { toDisposable } from "../../../../base/common/lifecycle.js";
import { FileAccess } from "../../../../base/common/network.js";
import { relativePath } from "../../../../base/common/resources.js";
import { URI } from "../../../../base/common/uri.js";
import * as nls from "../../../../nls.js";
import { IClipboardService } from "../../../../platform/clipboard/common/clipboardService.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import type { IContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { IContextKeyService, RawContextKey } from "../../../../platform/contextkey/common/contextkey.js";
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
import {
	listActiveSelectionBackground,
	listActiveSelectionForeground,
	listFocusBackground,
	listFocusForeground,
	listHoverBackground,
	listHoverForeground,
	listInactiveSelectionBackground,
	listInactiveSelectionForeground,
} from "../../../../platform/theme/common/colors/listColors.js";
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
import { IWorkbenchLayoutService, Parts } from "../../../services/layout/browser/layoutService.js";
import type { DiffEdit } from "../common/editCodeServiceTypes.js";
import { IOpencodeEditorService } from "../common/opencodeEditorService.js";
import type { IOpencodeSessionsControl } from "../common/opencodeSessionsTypes.js";
import { OpencodeSessionsViewerOrientation } from "../common/opencodeSessionsTypes.js";
import { ISpaProxyService } from "../electron-main/spaProxyService.js";
import { IEditCodeService } from "./editCodeService.js";
import { type IOpencodeMessage, MessageBridge } from "./messageBridge.js";
import { opencodeIcon } from "./opencodeIcons.js";
import type { IOpencodeSessionsControlOptions, OpencodeSessionsControl as OpencodeSessionsControlCtor } from "./opencodeSessionsControl.js";

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
const chatViewIndex = 0;
const sessionsViewIndex = 1;
const chatMinimumWidth = 320;
const sessionsMinimumWidth = 240;
const sideBySideMinimumWidth = 600;
const sideBySideMaximumAutoWidth = 800;
const defaultChatSashRatio = 0.65;
const sessionsOrientationStorageKey = "opencode.sessions.orientation";
const sessionsSashPositionStorageKey = "opencode.sessions.sashPosition";
const opencodeSessionsOrientationStacked = "stacked";
const opencodeSessionsOrientationSideBySide = "sideBySide";
const opencodeSessionsViewerVisibleContext = new RawContextKey<boolean>("opencodeSessionsViewerVisible", false);
const opencodeSessionsViewerOrientationContext = new RawContextKey<SessionsOrientationContextValue>(
	"opencodeSessionsViewerOrientation",
	opencodeSessionsOrientationStacked,
);
const allowedCommands = new Set([
	"workbench.action.terminal.toggleTerminal",
	"workbench.view.explorer",
]);

type SidebarState = "loading" | "ready" | "error" | "no-project";
type SessionsOrientationContextValue = typeof opencodeSessionsOrientationStacked | typeof opencodeSessionsOrientationSideBySide;
type SessionsOrientationInput = SessionsOrientationContextValue | OpencodeSessionsViewerOrientation;

export class OpencodeSidebarPane extends ViewPane {
	private readonly messageBridge: MessageBridge;
	private readonly _onDidChangeOrientation = this._register(new Emitter<OpencodeSessionsViewerOrientation>());
	readonly onDidChangeOrientation = this._onDidChangeOrientation.event;
	private readonly sessionsViewerVisibleContextKey: IContextKey<boolean>;
	private readonly sessionsViewerOrientationContextKey: IContextKey<SessionsOrientationContextValue>;
	private state: SidebarState = "loading";
	private loadingTimer: ReturnType<typeof setTimeout> | undefined;
	private bodyRoot: HTMLElement | undefined;
	private splitView: SplitView<number, IView<number>> | undefined;
	private chatView: IView<number> | undefined;
	private sessionsView: IView<number> | undefined;
	private sessionsHostElement: HTMLElement | undefined;
	private _sessionsControl: IOpencodeSessionsControl | undefined;
	private _OpencodeSessionsControlCtor: typeof OpencodeSessionsControlCtor | undefined;
	private shell: HTMLElement | undefined;
	private loadingView: HTMLElement | undefined;
	private errorView: HTMLElement | undefined;
	private noProjectView: HTMLElement | undefined;
	private iframeUrl: string | undefined;
	private loadRequest = 0;
	private workspaceDir = "";
	private iframe: HTMLIFrameElement | undefined;
	private dragActive = false;
	private sessionsOrientation = OpencodeSessionsViewerOrientation.Stacked;
	private sessionsSashRatio = defaultChatSashRatio;
	private _sashWriteTimer: ReturnType<typeof setTimeout> | undefined;
	private didRunSideBySideAutoWiden = false;
	private lastLayoutWidth = 0;
	private lastLayoutHeight = 0;

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
		private readonly layoutService: IWorkbenchLayoutService,
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

		this.sessionsViewerVisibleContextKey = opencodeSessionsViewerVisibleContext.bindTo(contextKeyService);
		this.sessionsViewerOrientationContextKey = opencodeSessionsViewerOrientationContext.bindTo(contextKeyService);
		this.sessionsOrientation = this._loadOrientation();
		this.sessionsSashRatio = this._loadSashRatio();
		this.updateSessionsContextKeys();
		this.messageBridge = this._register(new MessageBridge());
		this._register(
			this.messageBridge.onMessage((message) => {
				void this.handleMessage(message);
			}),
		);
		this._register(
			toDisposable(() => {
				this.flushSessionsSashPosition();
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

		const chatElement = document.createElement("div");
		chatElement.className = "opencode-chat-view";
		chatElement.style.position = "relative";
		chatElement.style.width = "100%";
		chatElement.style.height = "100%";
		chatElement.style.overflow = "hidden";
		chatElement.style.background = "var(--vscode-sideBar-background)";

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

		const sessionsElement = document.createElement("div");
		sessionsElement.className = "opencode-sessions-view";
		sessionsElement.style.position = "relative";
		sessionsElement.style.width = "100%";
		sessionsElement.style.height = "100%";
		sessionsElement.style.overflow = "hidden";
		sessionsElement.style.background = "var(--vscode-sideBar-background)";

		const sessionsHostElement = document.createElement("div");
		sessionsHostElement.className = "opencode-sessions-host";
		sessionsHostElement.style.position = "absolute";
		sessionsHostElement.style.inset = "0";
		sessionsElement.appendChild(sessionsHostElement);

		chatElement.appendChild(iframe);
		chatElement.appendChild(shell);
		root.appendChild(chatElement);
		container.appendChild(root);
		let disposed = false;
		this.registerDropTargets(container);
		this.registerIframeDragPassthrough(container, iframe);

		this.bodyRoot = root;
		this.sessionsHostElement = sessionsHostElement;
		this.shell = shell;
		this.loadingView = loadingView;
		this.errorView = errorView;
		this.noProjectView = noProjectView;
		this.iframe = iframe;
		this.messageBridge.setIframe(iframe);
		void Promise.all([
			import("../../../../base/browser/ui/splitview/splitview.js"),
			import("./opencodeSessionsControl.js"),
		]).then(([{ Sizing, SplitView }, controlModule]) => {
			if (disposed || this.bodyRoot !== root) {
				return;
			}

			this._OpencodeSessionsControlCtor = controlModule.OpencodeSessionsControl;
			const chatView = this.createChatView(chatElement, iframe);
			const sessionsView = this.createSessionsView(sessionsElement, sessionsHostElement);
			const splitView = this._register(new SplitView<number, IView<number>>(root, { orientation: Orientation.HORIZONTAL }));
			splitView.el.style.width = "100%";
			splitView.el.style.height = "100%";
			splitView.addView(chatView, Sizing.Distribute, chatViewIndex);
			splitView.addView(sessionsView, Sizing.Distribute, sessionsViewIndex);
			// T5 "Visibility toggling approach": keep the sessions view registered and hide it for Stacked mode.
			splitView.setViewVisible(sessionsViewIndex, this.sessionsOrientation === OpencodeSessionsViewerOrientation.SideBySide);
			this._register(splitView.onDidSashChange(() => this.updateSessionsSashRatio()));
			this._register(splitView.onDidSashReset(() => this.resetSessionsSplitToDefault()));

			this.splitView = splitView;
			this.chatView = chatView;
			this.sessionsView = sessionsView;
			if (this.sessionsOrientation === OpencodeSessionsViewerOrientation.SideBySide) {
				this.ensureSessionsControl();
			}

			this.layoutSplitView(this.lastLayoutWidth, this.lastLayoutHeight);
			this.applySessionsSashRatio();
		});
		this._register(this.contextService.onDidChangeWorkbenchState(() => this.updateWorkspace()));
		this._register(this.contextService.onDidChangeWorkspaceFolders(() => this.updateWorkspace()));
		this._register(
			toDisposable(() => {
				disposed = true;
				this.setIframeDragInterception(iframe, false);
				this.clearLoadingTimer();
				this.loadRequest += 1;
				this.bodyRoot = undefined;
				this.splitView = undefined;
				this.chatView = undefined;
				this.sessionsView = undefined;
				this.sessionsHostElement = undefined;
				this._sessionsControl = undefined;
				this.shell = undefined;
				this.loadingView = undefined;
				this.errorView = undefined;
				this.noProjectView = undefined;
				this.iframe = undefined;
				this.messageBridge.setIframe(undefined);
				animationStyle.remove();
				root.remove();
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

		this.lastLayoutWidth = width;
		this.lastLayoutHeight = height;
		this.bodyRoot.style.height = `${height}px`;
		this.bodyRoot.style.width = `${width}px`;
		this.layoutSplitView(width, height);
		this.applySessionsSashRatio();
	}

	private layoutSplitView(width: number, height: number): void {
		if (!this.splitView || !this.chatView || !this.sessionsView) {
			return;
		}

		this.splitView.layout(width, height);
		this.chatView.layout(this.splitView.getViewSize(chatViewIndex), 0, height);
		if (this.splitView.isViewVisible(sessionsViewIndex)) {
			this.sessionsView.layout(this.splitView.getViewSize(sessionsViewIndex), this.splitView.getViewSize(chatViewIndex), height);
		}
	}

	private createChatView(chatElement: HTMLElement, iframe: HTMLIFrameElement): IView<number> {
		return {
			element: chatElement,
			minimumSize: chatMinimumWidth,
			maximumSize: Number.POSITIVE_INFINITY,
			onDidChange: Event.None,
			layout: (width, _offset, height) => {
				this.layoutChatView(chatElement, iframe, width, height ?? this.lastLayoutHeight);
			},
		};
	}

	private createSessionsView(sessionsElement: HTMLElement, sessionsHostElement: HTMLElement): IView<number> {
		return {
			element: sessionsElement,
			minimumSize: sessionsMinimumWidth,
			maximumSize: Number.POSITIVE_INFINITY,
			onDidChange: Event.None,
			layout: (width, _offset, height) => {
				this.layoutSessionsView(sessionsElement, sessionsHostElement, width, height ?? this.lastLayoutHeight);
			},
		};
	}

	private layoutChatView(chatElement: HTMLElement, iframe: HTMLIFrameElement, width: number, height: number): void {
		chatElement.style.width = `${width}px`;
		chatElement.style.height = `${height}px`;
		iframe.style.width = "100%";
		iframe.style.height = "100%";
	}

	private layoutSessionsView(sessionsElement: HTMLElement, sessionsHostElement: HTMLElement, width: number, height: number): void {
		sessionsElement.style.width = `${width}px`;
		sessionsElement.style.height = `${height}px`;
		sessionsHostElement.style.width = "100%";
		sessionsHostElement.style.height = "100%";
	}

	setSessionsOrientation(orientation: SessionsOrientationContextValue): void;
	setSessionsOrientation(orientation: OpencodeSessionsViewerOrientation): void;
	setSessionsOrientation(orientation: SessionsOrientationInput): void {
		const nextOrientation = this.toSessionsOrientation(orientation);
		if (this.sessionsOrientation === nextOrientation) {
			return;
		}

		const previousOrientation = this.sessionsOrientation;
		this.sessionsOrientation = nextOrientation;
		this.applySessionsOrientation(previousOrientation);
		this.updateSessionsContextKeys();
		this._persistOrientation();
		this._onDidChangeOrientation.fire(this.sessionsOrientation);
	}

	getSessionsOrientation(): OpencodeSessionsViewerOrientation {
		return this.sessionsOrientation;
	}

	getSessionsControl(): IOpencodeSessionsControl | undefined {
		return this._sessionsControl;
	}

	navigateToSession(sessionId: string): void {
		this._navigateToSession(sessionId);
	}

	collapseAllSections(): void {
		this._sessionsControl?.collapseAllSections();
	}

	private applySessionsOrientation(previousOrientation: OpencodeSessionsViewerOrientation): void {
		if (this.sessionsOrientation === OpencodeSessionsViewerOrientation.Stacked) {
			this.updateSessionsSashRatio();
			this.splitView?.setViewVisible(sessionsViewIndex, false);
			this._persistSashPosition();
			this.applySessionsSashRatio();
			return;
		}

		this.ensureSessionsControl();
		this.splitView?.setViewVisible(sessionsViewIndex, true);
		if (previousOrientation === OpencodeSessionsViewerOrientation.Stacked && !this.didRunSideBySideAutoWiden) {
			this.autoWidenForSideBySide();
		}

		this.applySessionsSashRatio();
	}

	private ensureSessionsControl(): IOpencodeSessionsControl | undefined {
		if (this._sessionsControl || !this.sessionsHostElement || !this._OpencodeSessionsControlCtor) {
			return this._sessionsControl;
		}

		this._sessionsControl = this._register(this.instantiationService.createInstance(
			this._OpencodeSessionsControlCtor,
			this.sessionsHostElement,
			this.createSessionsControlOptions(),
		));
		this._sessionsControl.setNavigateCallback(sessionId => this._navigateToSession(sessionId));
		return this._sessionsControl;
	}

	private createSessionsControlOptions(): IOpencodeSessionsControlOptions {
		return {
			getHoverPosition: () => HoverPosition.ABOVE,
			overrideStyles: {
				listActiveSelectionBackground,
				listActiveSelectionForeground,
				listFocusBackground,
				listFocusForeground,
				listHoverBackground,
				listHoverForeground,
				listInactiveSelectionBackground,
				listInactiveSelectionForeground,
			},
		};
	}

	private _navigateToSession(sessionId: string): void {
		if (!sessionId) {
			return;
		}

		this.messageBridge.send({
			type: "opencode-web.navigate",
			sessionId,
		} as IOpencodeMessage & { sessionId: string });
	}

	private autoWidenForSideBySide(): void {
		this.didRunSideBySideAutoWiden = true;
		const currentSize = this.layoutService.getSize(Parts.SIDEBAR_PART);
		if (currentSize.width >= sideBySideMinimumWidth) {
			return;
		}

		// T5 "Auto-widen on first SideBySide toggle": mirror the native agent-sessions width request.
		this.layoutService.setSize(Parts.SIDEBAR_PART, {
			width: Math.max(
				sideBySideMinimumWidth,
				Math.min(this.layoutService.mainContainerDimension.width / 2, sideBySideMaximumAutoWidth),
			),
			height: currentSize.height,
		});
	}

	private resetSessionsSplitToDefault(): void {
		this.sessionsSashRatio = defaultChatSashRatio;
		this.applySessionsSashRatio();
		this._persistSashPosition();
	}

	private applySessionsSashRatio(): void {
		if (
			!this.splitView ||
			this.sessionsOrientation !== OpencodeSessionsViewerOrientation.SideBySide ||
			!this.splitView.isViewVisible(sessionsViewIndex) ||
			this.lastLayoutWidth <= 0
		) {
			return;
		}

		this.splitView.resizeView(chatViewIndex, Math.round(this.lastLayoutWidth * this.getClampedSessionsSashRatio()));
	}

	private updateSessionsSashRatio(): void {
		if (!this.splitView || this.lastLayoutWidth <= 0 || !this.splitView.isViewVisible(sessionsViewIndex)) {
			return;
		}

		this.sessionsSashRatio = this.splitView.getViewSize(chatViewIndex) / this.lastLayoutWidth;
		this._persistSashPosition();
	}

	private getClampedSessionsSashRatio(width = this.lastLayoutWidth): number {
		if (width <= 0) {
			return this.sessionsSashRatio;
		}

		return Math.max(
			chatMinimumWidth / width,
			Math.min(this.sessionsSashRatio, 1 - (sessionsMinimumWidth / width)),
		);
	}

	private toSessionsOrientation(orientation: SessionsOrientationInput): OpencodeSessionsViewerOrientation {
		if (orientation === opencodeSessionsOrientationStacked || orientation === OpencodeSessionsViewerOrientation.Stacked) {
			return OpencodeSessionsViewerOrientation.Stacked;
		}

		return OpencodeSessionsViewerOrientation.SideBySide;
	}

	private toSessionsOrientationContextValue(orientation: OpencodeSessionsViewerOrientation): SessionsOrientationContextValue {
		if (orientation === OpencodeSessionsViewerOrientation.SideBySide) {
			return opencodeSessionsOrientationSideBySide;
		}

		return opencodeSessionsOrientationStacked;
	}

	private updateSessionsContextKeys(): void {
		this.sessionsViewerOrientationContextKey.set(this.toSessionsOrientationContextValue(this.sessionsOrientation));
		this.sessionsViewerVisibleContextKey.set(this.sessionsOrientation === OpencodeSessionsViewerOrientation.SideBySide);
	}

	private _loadOrientation(): OpencodeSessionsViewerOrientation {
		return this.storageService.get(
			sessionsOrientationStorageKey,
			StorageScope.PROFILE,
			opencodeSessionsOrientationStacked,
		) === opencodeSessionsOrientationSideBySide
			? OpencodeSessionsViewerOrientation.SideBySide
			: OpencodeSessionsViewerOrientation.Stacked;
	}

	private _loadSashRatio(): number {
		return this.storageService.getNumber(
			sessionsSashPositionStorageKey,
			StorageScope.PROFILE,
			defaultChatSashRatio,
		);
	}

	private _persistOrientation(orientation = this.sessionsOrientation): void {
		this.storageService.store(
			sessionsOrientationStorageKey,
			this.toSessionsOrientationContextValue(orientation),
			StorageScope.PROFILE,
			StorageTarget.USER,
		);
	}

	private _persistSashPosition(ratio = this.sessionsSashRatio): void {
		if (this._sashWriteTimer) {
			clearTimeout(this._sashWriteTimer);
		}

		this._sashWriteTimer = setTimeout(() => {
			this._sashWriteTimer = undefined;
			this.storageService.store(
				sessionsSashPositionStorageKey,
				ratio,
				StorageScope.PROFILE,
				StorageTarget.USER,
			);
		}, 500);
	}

	private flushSessionsSashPosition(): void {
		if (!this._sashWriteTimer) {
			return;
		}

		clearTimeout(this._sashWriteTimer);
		this._sashWriteTimer = undefined;
		this.storageService.store(
			sessionsSashPositionStorageKey,
			this.sessionsSashRatio,
			StorageScope.PROFILE,
			StorageTarget.USER,
		);
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

			case "opencode-web.clipboard-image-read": {
				const requestId = (message as IOpencodeMessage & { id?: unknown }).id;
				await this.readClipboardImage().then(
					(data) => {
						this.messageBridge.send({
							type: "opencode-web.clipboard-image",
							id: requestId,
							data,
						} as IOpencodeMessage & { id?: unknown; data: string | null });
					},
					(error: unknown) => {
						this.logError("[OpenCode] Failed to read clipboard image", error);
						this.messageBridge.send({
							type: "opencode-web.clipboard-image",
							id: requestId,
							data: null,
						} as IOpencodeMessage & { id?: unknown; data: string | null });
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
				this.isRelevantDrag(event.dataTransfer),
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
		this._register(addDisposableListener(view, EventType.DRAG_END, () => {
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

	private setIframeDragInterception(iframe: HTMLIFrameElement, active: boolean): void {
		if (this.dragActive === active) {
			return;
		}

		this.dragActive = active;
		iframe.style.pointerEvents = active ? "none" : "";
	}

	private async handlePromptDrop(event: DragEvent): Promise<void> {
		const uriList = event.dataTransfer?.getData("text/uri-list") || undefined;
		this.logTrace(`[OpenCode] Prompt drop snapshot types=${JSON.stringify(Array.from(event.dataTransfer?.types ?? []))} uriList=${JSON.stringify(uriList)}`);
		const text = await this.getDropPromptText(event, uriList);
		if (!text) {
			this.logWarning(`[OpenCode] Prompt drop produced no text (snapshotUriList=${JSON.stringify(uriList)})`);
			return;
		}

		this.logTrace(`[OpenCode] Prompt drop sending ${JSON.stringify(text)}`);
		this.messageBridge.send({
			type: "opencode-web.insert-prompt",
			text,
		} as IOpencodeMessage & { text: string });
	}

	private async getDropPromptText(event: DragEvent, uriListSnapshot?: string): Promise<string | undefined> {
		const editors = await this.instantiationService.invokeFunction(accessor => extractEditorsAndFilesDropData(accessor, event));
		const fromEditors = editors
			.flatMap(editor => editor.resource ? [this.toPromptPath(editor.resource)] : [])
			.filter((path): path is string => Boolean(path));

		if (fromEditors.length > 0) {
			return [...new Set(fromEditors)].map(path => `@${path}`).join(" ");
		}

		const uriList = uriListSnapshot ?? event.dataTransfer?.getData("text/uri-list");
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

	private readClipboardImage(): Promise<string | null> {
		return this.instantiationService.invokeFunction(async (accessor) => {
			const imageData = await accessor.get(IClipboardService).readImage();
			if (imageData.byteLength === 0) {
				return null;
			}
			const chunks: string[] = [];
			for (let i = 0; i < imageData.byteLength; i += 0x8000) {
				chunks.push(String.fromCharCode(...imageData.subarray(i, i + 0x8000)));
			}
			return btoa(chunks.join(""));
		});
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

	private logTrace(message: string): void {
		this.instantiationService.invokeFunction((accessor) => {
			accessor.get(ILogService).trace(message);
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
IWorkbenchLayoutService(OpencodeSidebarPane, "", 15);

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
