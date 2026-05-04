/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import type { HoverPosition } from "../../../../base/browser/ui/hover/hoverWidget.js";
import type { IListRenderer, IListVirtualDelegate } from "../../../../base/browser/ui/list/list.js";
import type { IListStyles } from "../../../../base/browser/ui/list/listWidget.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IHoverService } from "../../../../platform/hover/browser/hover.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { IListService, WorkbenchList } from "../../../../platform/list/browser/listService.js";
import { IStorageService } from "../../../../platform/storage/common/storage.js";
import type { IStyleOverride } from "../../../../platform/theme/browser/defaultStyles.js";
import { IThemeService } from "../../../../platform/theme/common/themeService.js";
import type { IOpencodeSession, IOpencodeSessionsControl } from "../common/opencodeSessionsTypes.js";
import { IOpencodeSessionsService } from "../common/opencodeSessionsTypes.js";

export interface IOpencodeSessionsControlOptions {
 	getHoverPosition(): HoverPosition;
 	readonly overrideStyles?: IStyleOverride<IListStyles>;
}

class OpencodeSessionsVirtualDelegate implements IListVirtualDelegate<unknown> {
 	getHeight(_element: unknown): number {
 		return 22;
 	}

 	getTemplateId(_element: unknown): string {
 		return OpencodeSessionsPlaceholderRenderer.templateId;
 	}
}

class OpencodeSessionsPlaceholderRenderer implements IListRenderer<unknown, void> {
 	static readonly templateId = "opencode.sessions.placeholder";
 	readonly templateId = OpencodeSessionsPlaceholderRenderer.templateId;

 	renderTemplate(_container: HTMLElement): void { }

	renderElement(_element: unknown, _index: number): void { }

	disposeTemplate(): void { }
}

export class OpencodeSessionsControl extends Disposable implements IOpencodeSessionsControl {

 	private sessionsContainer: HTMLElement | undefined;
 	get element(): HTMLElement | undefined { return this.sessionsContainer; }

	private sessionsList: WorkbenchList<unknown> | undefined;
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
 		this.sessionsList = undefined;
 	}

 	private create(parent: HTMLElement): void {
 		this.sessionsContainer = document.createElement("div");
 		this.sessionsContainer.className = "opencode-sessions-control";
 		parent.appendChild(this.sessionsContainer);

 		this.createList(this.sessionsContainer);
 	}

 	private createList(container: HTMLElement): void {
 		const listContainer = document.createElement("div");
 		listContainer.className = "opencode-sessions-list";
 		container.appendChild(listContainer);

 		this.sessionsList = this._register(this.instantiationService.createInstance(
 			WorkbenchList<unknown>,
 			"opencode.sessions",
 			listContainer,
 			new OpencodeSessionsVirtualDelegate(),
 			[new OpencodeSessionsPlaceholderRenderer()],
 			{
 				multipleSelectionSupport: false,
 				overrideStyles: this.options.overrideStyles,
 				selectionNavigation: true,
 			}
 		));
 	}

	private registerListeners(): void {
		this._register(this.sessionsService.onDidChangeSessions(() => this.scheduleRender()));

		const sessionsList = this.sessionsList;
		if (!sessionsList) {
			return;
		}

		this._register(sessionsList.onDidOpen(event => this.openSession(event.element)));
	}

 	private scheduleRender(): void { }

 	private openSession(element: unknown): void {
 		if (!this.isOpencodeSession(element)) {
 			return;
 		}

 		this._navigate?.(element.id);
 	}

 	private isOpencodeSession(element: unknown): element is IOpencodeSession {
 		return typeof element === "object" && element !== null && "id" in element && typeof element.id === "string";
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
