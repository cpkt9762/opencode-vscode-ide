/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import * as dom from "../../../../base/browser/dom.js";
import type { HoverPosition } from "../../../../base/browser/ui/hover/hoverWidget.js";
import type { IListStyles } from "../../../../base/browser/ui/list/listWidget.js";
import { Codicon } from "../../../../base/common/codicons.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { ThemeIcon } from "../../../../base/common/themables.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IHoverService } from "../../../../platform/hover/browser/hover.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { IListService, WorkbenchList } from "../../../../platform/list/browser/listService.js";
import { IStorageService } from "../../../../platform/storage/common/storage.js";
import type { IStyleOverride } from "../../../../platform/theme/browser/defaultStyles.js";
import { IThemeService } from "../../../../platform/theme/common/themeService.js";
import { groupByDate } from "../common/opencodeSessionsGrouping.js";
import type { IOpencodeSession, IOpencodeSessionsControl } from "../common/opencodeSessionsTypes.js";
import { IOpencodeSessionsService } from "../common/opencodeSessionsTypes.js";
import {
	extractAgentName,
	OpencodeSessionsGroupHeaderRenderer,
	OpencodeSessionsListVirtualDelegate,
	OpencodeSessionsRowRenderer,
} from "./opencodeSessionsViewer.js";
import type { IOpencodeListItem } from "./opencodeSessionsViewer.js";

export interface IOpencodeSessionsControlOptions {
 	getHoverPosition(): HoverPosition;
 	readonly overrideStyles?: IStyleOverride<IListStyles>;
}

export class OpencodeSessionsControl extends Disposable implements IOpencodeSessionsControl {

	private sessionsContainer: HTMLElement | undefined;
	get element(): HTMLElement | undefined { return this.sessionsContainer; }

	private headerElement: HTMLElement | undefined;
	private listContainer: HTMLElement | undefined;
	private stateContainer: HTMLElement | undefined;
	private searchInput: HTMLInputElement | undefined;
	private clearSearchButton: HTMLButtonElement | undefined;
	private agentSelect: HTMLSelectElement | undefined;
	private filterBadge: HTMLElement | undefined;
	private streamStatusIndicator: HTMLElement | undefined;
	private sessionsList: WorkbenchList<IOpencodeListItem> | undefined;
	private renderedItems: readonly IOpencodeListItem[] = [];
	private searchDebounce: ReturnType<typeof setTimeout> | undefined;
	private agentOptionsKey = "";
	private filter: { readonly search: string; readonly agent: string | undefined } = { search: "", agent: undefined };
	private _navigate: ((sessionID: string) => void) | undefined;
	private readonly services: {
		readonly contextMenuService: IContextMenuService;
		readonly listService: IListService;
		readonly commandService: ICommandService;
		readonly themeService: IThemeService;
		readonly hoverService: IHoverService;
		readonly storageService: IStorageService;
	};

	constructor(
		private readonly parent: HTMLElement,
		private readonly options: IOpencodeSessionsControlOptions,
		private readonly instantiationService: IInstantiationService,
		contextMenuService: IContextMenuService,
		listService: IListService,
		commandService: ICommandService,
		private readonly sessionsService: IOpencodeSessionsService,
		themeService: IThemeService,
		hoverService: IHoverService,
		storageService: IStorageService,
	) {
		super();

		this.services = { contextMenuService, listService, commandService, themeService, hoverService, storageService };
		this.create(this.parent);
		this.registerListeners();
		this._register(toDisposable(() => this.clearSearchDebounce()));
		void this.sessionsService.start();
		this.renderSessions();
	}

 	setNavigateCallback(cb: (sessionID: string) => void): void {
 		this._navigate = cb;
 	}

 	refresh(): void {
 		void this.sessionsService.refresh();
 	}

 	openFind(): void { }

 	reveal(_sessionID: string): boolean {
 		return false;
 	}

	clearFocus(): void { }

	hasFocusOrSelection(): boolean {
		if (this.services.listService.lastFocusedList === this.sessionsList) {
			return false;
		}

		return false;
	}

 	resetSectionCollapseState(): void { }

 	collapseAllSections(): void { }

	override dispose(): void {
		super.dispose();
		this.sessionsContainer?.remove();
		this.sessionsContainer = undefined;
		this.headerElement = undefined;
		this.listContainer = undefined;
		this.stateContainer = undefined;
		this.searchInput = undefined;
		this.clearSearchButton = undefined;
		this.agentSelect = undefined;
		this.filterBadge = undefined;
		this.streamStatusIndicator = undefined;
		this.sessionsList = undefined;
	}

	private create(parent: HTMLElement): void {
		this.sessionsContainer = dom.append(parent, dom.$(".opencode-sessions-control"));
		this.sessionsContainer.style.display = "flex";
		this.sessionsContainer.style.flexDirection = "column";
		this.sessionsContainer.style.height = "100%";

		this.createHeader(this.sessionsContainer);
		this.createStateContainer(this.sessionsContainer);
		this.createList(this.sessionsContainer);
	}

	private createHeader(container: HTMLElement): void {
		this.headerElement = dom.append(container, dom.$(".opencode-sessions-header"));
		this.headerElement.style.display = "grid";
		this.headerElement.style.gap = "6px";
		this.headerElement.style.padding = "8px";

		const controls = dom.append(this.headerElement, dom.$(".opencode-sessions-filter-controls"));
		controls.style.display = "grid";
		controls.style.gridTemplateColumns = "minmax(0, 1fr) auto auto";
		controls.style.gap = "6px";
		controls.style.alignItems = "center";

		const searchWrapper = dom.append(controls, dom.$(".opencode-sessions-search-wrapper"));
		searchWrapper.style.position = "relative";
		searchWrapper.style.minWidth = "0";

		this.searchInput = dom.append(searchWrapper, dom.$<HTMLInputElement>("input.opencode-sessions-search", {
			type: "search",
			placeholder: "Search sessions...",
			"aria-label": "Search sessions",
		}));
		this.searchInput.style.boxSizing = "border-box";
		this.searchInput.style.width = "100%";
		this.searchInput.style.paddingRight = "24px";

		this.clearSearchButton = dom.append(searchWrapper, dom.$<HTMLButtonElement>("button.opencode-sessions-search-clear", {
			type: "button",
			title: "Clear search",
			"aria-label": "Clear search",
		}, "×"));
		this.clearSearchButton.style.position = "absolute";
		this.clearSearchButton.style.right = "4px";
		this.clearSearchButton.style.top = "50%";
		this.clearSearchButton.style.transform = "translateY(-50%)";
		this.clearSearchButton.style.border = "0";
		this.clearSearchButton.style.background = "transparent";
		this.clearSearchButton.style.cursor = "pointer";

		this.agentSelect = dom.append(controls, dom.$<HTMLSelectElement>("select.opencode-sessions-agent-filter", {
			"aria-label": "Filter sessions by agent",
		}));
		this.agentSelect.style.maxWidth = "120px";

		this.streamStatusIndicator = dom.append(controls, dom.$("span.opencode-sessions-stream-status"));
		this.streamStatusIndicator.style.width = "7px";
		this.streamStatusIndicator.style.height = "7px";
		this.streamStatusIndicator.style.borderRadius = "50%";
		this.streamStatusIndicator.style.background = "var(--vscode-charts-yellow)";
		this.streamStatusIndicator.style.opacity = "0";
		this.streamStatusIndicator.title = "Sessions stream reconnecting";

		this.filterBadge = dom.append(this.headerElement, dom.$("span.opencode-sessions-filter-badge"));
		this.filterBadge.style.fontSize = "11px";
		this.filterBadge.style.opacity = "0.75";
		this.updateSearchClearButton();
		this.updateFilterBadge(0, 0);
	}

	private createStateContainer(container: HTMLElement): void {
		this.stateContainer = dom.append(container, dom.$(".opencode-sessions-state"));
		this.stateContainer.style.flex = "1";
		this.stateContainer.style.minHeight = "0";
		this.stateContainer.style.alignItems = "center";
		this.stateContainer.style.justifyContent = "center";
		this.stateContainer.style.padding = "16px";
		this.stateContainer.style.textAlign = "center";
		dom.hide(this.stateContainer);
	}

	private createList(container: HTMLElement): void {
		this.listContainer = dom.append(container, dom.$(".opencode-sessions-list"));
		this.listContainer.style.flex = "1";
		this.listContainer.style.minHeight = "0";

		this.sessionsList = this._register(this.instantiationService.createInstance(
			WorkbenchList<IOpencodeListItem>,
			"opencode.sessions",
			this.listContainer,
			new OpencodeSessionsListVirtualDelegate(),
			[new OpencodeSessionsGroupHeaderRenderer(), new OpencodeSessionsRowRenderer()],
			{
				multipleSelectionSupport: false,
 				overrideStyles: this.options.overrideStyles,
 				selectionNavigation: true,
 			}
 		));
	}

	private registerListeners(): void {
		this._register(this.sessionsService.onDidChangeSessions(() => this.scheduleRender()));
		if (this.searchInput) {
			this._register(dom.addDisposableListener(this.searchInput, dom.EventType.INPUT, () => this.scheduleSearchFilter()));
		}

		if (this.clearSearchButton) {
			this._register(dom.addDisposableListener(this.clearSearchButton, dom.EventType.CLICK, () => this.clearSearchFilter()));
		}

		if (this.agentSelect) {
			this._register(dom.addDisposableListener(this.agentSelect, dom.EventType.CHANGE, () => this.updateFilter({ agent: this.agentSelect?.value || undefined })));
		}

		if (this.stateContainer) {
			this._register(dom.addDisposableListener(this.stateContainer, dom.EventType.CLICK, event => this.onStateActionClick(event)));
		}

		const sessionsList = this.sessionsList;
		if (!sessionsList) {
			return;
		}

		this._register(sessionsList.onDidOpen(event => this.openSession(event.element)));
	}

	private scheduleRender(): void {
		this.renderSessions();
	}

	private scheduleSearchFilter(): void {
		this.updateSearchClearButton();
		this.clearSearchDebounce();
		this.searchDebounce = setTimeout(() => {
			this.searchDebounce = undefined;
			this.updateFilter({ search: this.searchInput?.value.trim() ?? "" });
		}, 200);
	}

	private clearSearchFilter(): void {
		this.clearSearchDebounce();
		if (this.searchInput) {
			this.searchInput.value = "";
		}

		this.updateFilter({ search: "" });
	}

	private updateFilter(update: { readonly search?: string; readonly agent?: string | undefined }): void {
		const nextFilter = {
			search: update.search ?? this.filter.search,
			agent: update.agent === undefined && !("agent" in update) ? this.filter.agent : update.agent,
		};
		if (nextFilter.search === this.filter.search && nextFilter.agent === this.filter.agent) {
			this.updateSearchClearButton();
			return;
		}

		this.filter = nextFilter;
		this.updateSearchClearButton();
		this.renderSessions();
	}

	private renderSessions(): void {
		const sessions = this.sessionsService.state.sessions;
		this.updateAgentOptions(sessions);
		const filteredSessions = this.filteredSessions(sessions);
		this.renderedItems = groupByDate(filteredSessions, "updated").flatMap(group => [
			{ kind: "group", group },
			...group.sessions.map(session => ({
				kind: "session" as const,
				session,
				status: this.sessionsService.state.status[session.id],
			})),
		]);
		this.sessionsList?.splice(0, this.sessionsList.length, this.renderedItems);
		this.updateFilterBadge(filteredSessions.length, sessions.length);
		this.renderStateView();
		this.updateStreamStatusIndicator();
	}

	private renderStateView(): void {
		const stateContainer = this.stateContainer;
		const listContainer = this.listContainer;
		if (!stateContainer || !listContainer) {
			return;
		}

		stateContainer.replaceChildren();
		if (this.sessionsService.state.loading) {
			this.showStateView();
			this.renderStateMessage({
				icon: ThemeIcon.asClassName(ThemeIcon.modify(Codicon.sync, "spin")),
				title: "Loading sessions...",
			});
			return;
		}

		if (this.sessionsService.state.error) {
			this.showStateView();
			const backendNotRunning = this.isBackendNotRunningError(this.sessionsService.state.error);
			this.renderStateMessage({
				icon: ThemeIcon.asClassName(backendNotRunning ? Codicon.debugDisconnect : Codicon.warning),
				title: backendNotRunning ? "OpenCode backend not running" : "Failed to load sessions",
				message: this.truncatedError(this.sessionsService.state.error),
				action: "retry",
				actionLabel: "Retry",
			});
			return;
		}

		if (this.sessionsService.state.sessions.length === 0) {
			this.showStateView();
			this.renderStateMessage({
				icon: ThemeIcon.asClassName(Codicon.add),
				title: "No sessions yet",
				action: "new",
				actionLabel: "New Session",
			});
			return;
		}

		stateContainer.style.display = "none";
		dom.show(listContainer);
	}

	private showStateView(): void {
		if (!this.stateContainer || !this.listContainer) {
			return;
		}

		this.stateContainer.style.display = "flex";
		dom.hide(this.listContainer);
	}

	private renderStateMessage(state: {
		readonly icon: string;
		readonly title: string;
		readonly message?: string;
		readonly action?: "new" | "retry";
		readonly actionLabel?: string;
	}): void {
		const stateContainer = this.stateContainer;
		if (!stateContainer) {
			return;
		}

		const content = dom.append(stateContainer, dom.$(".opencode-sessions-state-content"));
		content.style.display = "grid";
		content.style.gap = "8px";
		content.style.justifyItems = "center";
		content.style.maxWidth = "260px";

		const icon = dom.append(content, dom.$(".opencode-sessions-state-icon"));
		icon.className = `opencode-sessions-state-icon ${state.icon}`;
		icon.style.fontSize = "20px";

		const title = dom.append(content, dom.$(".opencode-sessions-state-title"));
		title.textContent = state.title;
		title.style.fontWeight = "600";

		if (state.message) {
			const message = dom.append(content, dom.$(".opencode-sessions-state-message"));
			message.textContent = state.message;
			message.title = state.message;
			message.style.opacity = "0.75";
			message.style.overflowWrap = "anywhere";
		}

		if (state.action && state.actionLabel) {
			const button = dom.append(content, dom.$<HTMLButtonElement>("button.opencode-sessions-state-action", {
				type: "button",
			}, state.actionLabel));
			button.dataset.opencodeSessionsAction = state.action;
		}
	}

	private onStateActionClick(event: MouseEvent): void {
		const target = event.target;
		if (!(target instanceof HTMLElement)) {
			return;
		}

		const button = target.closest("button");
		if (!(button instanceof HTMLButtonElement)) {
			return;
		}

		if (button.dataset.opencodeSessionsAction === "new") {
			void this.services.commandService.executeCommand("opencode.sessions.new");
			return;
		}

		if (button.dataset.opencodeSessionsAction === "retry") {
			void this.sessionsService.refresh();
			this.renderSessions();
		}
	}

	private updateStreamStatusIndicator(): void {
		const indicator = this.streamStatusIndicator;
		if (!indicator) {
			return;
		}

		if (this.sessionsService.state.error) {
			indicator.style.opacity = "1";
			indicator.style.background = "var(--vscode-errorForeground)";
			indicator.title = this.isBackendNotRunningError(this.sessionsService.state.error) ? "OpenCode backend not running" : "Sessions stream reconnecting";
			return;
		}

		if (this.sessionsService.state.loading) {
			indicator.style.opacity = "1";
			indicator.style.background = "var(--vscode-charts-yellow)";
			indicator.title = "Loading sessions";
			return;
		}

		indicator.style.opacity = "0";
		indicator.title = "Sessions stream connected";
	}

	private isBackendNotRunningError(error: string): boolean {
		const message = error.toLocaleLowerCase();
		return message.includes("http 502") || message.includes(" 502") || message.includes("econnrefused") || message.includes("connection refused") || message.includes("failed to fetch");
	}

	private truncatedError(error: string): string {
		const message = error.trim();
		if (message.length <= 160) {
			return message;
		}

		return `${message.slice(0, 157)}...`;
	}

	private filteredSessions(sessions: readonly IOpencodeSession[]): IOpencodeSession[] {
		const search = this.filter.search.toLocaleLowerCase();
		return sessions.filter(session => {
			if (search && !session.title.toLocaleLowerCase().includes(search)) {
				return false;
			}

			if (this.filter.agent && extractAgentName(session.title) !== this.filter.agent) {
				return false;
			}

			return true;
		});
	}

	private updateAgentOptions(sessions: readonly IOpencodeSession[]): void {
		const agentSelect = this.agentSelect;
		if (!agentSelect) {
			return;
		}

		const agents = Array.from(new Set(sessions.flatMap(session => {
			const agent = extractAgentName(session.title);
			return agent ? [agent] : [];
		}))).sort((a, b) => a.localeCompare(b));
		const nextOptionsKey = agents.join("\n");
		if (nextOptionsKey !== this.agentOptionsKey) {
			this.agentOptionsKey = nextOptionsKey;
			agentSelect.replaceChildren(
				dom.$<HTMLOptionElement>("option", { value: "" }, "All agents"),
				...agents.map(agent => dom.$<HTMLOptionElement>("option", { value: agent }, agent)),
			);
		}

		const nextAgent = this.filter.agent && agents.includes(this.filter.agent) ? this.filter.agent : undefined;
		if (nextAgent !== this.filter.agent) {
			this.filter = { search: this.filter.search, agent: nextAgent };
		}

		agentSelect.value = nextAgent ?? "";
	}

	private updateFilterBadge(visibleCount: number, totalCount: number): void {
		if (!this.filterBadge) {
			return;
		}

		if (!this.isFilterActive()) {
			this.filterBadge.textContent = "";
			dom.hide(this.filterBadge);
			return;
		}

		this.filterBadge.textContent = `Showing ${visibleCount} of ${totalCount}`;
		dom.show(this.filterBadge);
	}

	private updateSearchClearButton(): void {
		if (!this.clearSearchButton) {
			return;
		}

		this.clearSearchButton.style.display = this.searchInput?.value ? "" : "none";
	}

	private clearSearchDebounce(): void {
		if (!this.searchDebounce) {
			return;
		}

		clearTimeout(this.searchDebounce);
		this.searchDebounce = undefined;
	}

	private isFilterActive(): boolean {
		return this.filter.search.length > 0 || this.filter.agent !== undefined;
	}

	private openSession(element: unknown): void {
		if (!this.isOpencodeSessionListItem(element)) {
			return;
		}

		this._navigate?.(element.session.id);
	}

	private isOpencodeSessionListItem(element: unknown): element is Extract<IOpencodeListItem, { readonly kind: "session" }> {
		return this.isRecord(element) && element.kind === "session" && this.isOpencodeSession(element.session);
	}

	private isOpencodeSession(element: unknown): element is IOpencodeSession {
		return this.isRecord(element) && typeof element.id === "string";
	}

	private isRecord(element: unknown): element is Record<string, unknown> {
		return typeof element === "object" && element !== null;
	}
}

IInstantiationService(OpencodeSessionsControl, undefined, 2);
IContextMenuService(OpencodeSessionsControl, undefined, 3);
IListService(OpencodeSessionsControl, undefined, 4);
ICommandService(OpencodeSessionsControl, undefined, 5);
IOpencodeSessionsService(OpencodeSessionsControl, undefined, 6);
IThemeService(OpencodeSessionsControl, undefined, 7);
IHoverService(OpencodeSessionsControl, undefined, 8);
IStorageService(OpencodeSessionsControl, undefined, 9);
