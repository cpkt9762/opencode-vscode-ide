/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import type { IView } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import type { IOpencodeSessionsControl } from '../common/opencodeSessionsTypes.js';
import { IOpencodeSessionsService, OpencodeSessionsViewerOrientation } from '../common/opencodeSessionsTypes.js';
import { OpencodeSessionsService } from './opencodeSessionsService.js';

export const OPENCODE_SESSIONS_CATEGORY = localize2('opencode.sessions.category', "OpenCode Sessions");

const OPENCODE_CHAT_VIEW_ID = 'workbench.view.opencode.chat';
const OPENCODE_SESSION_VIEW_ITEM = 'opencodeSession';
const OPENCODE_SESSIONS_ORIENTATION_STACKED = 'stacked';
const OPENCODE_SESSIONS_ORIENTATION_SIDE_BY_SIDE = 'sideBySide';

type OpencodeSessionsViewerOrientationContext = typeof OPENCODE_SESSIONS_ORIENTATION_STACKED | typeof OPENCODE_SESSIONS_ORIENTATION_SIDE_BY_SIDE;

export const OpencodeSessionsViewerVisibleContext = new RawContextKey<boolean>('opencodeSessionsViewerVisible', false);
export const OpencodeSessionsViewerOrientationContext = new RawContextKey<OpencodeSessionsViewerOrientationContext>('opencodeSessionsViewerOrientation', OPENCODE_SESSIONS_ORIENTATION_STACKED);

interface IOpencodeSessionsView extends IView {
    getSessionsOrientation?(): OpencodeSessionsViewerOrientation | undefined;
    setSessionsOrientation?(orientation: OpencodeSessionsViewerOrientation): void | Promise<void>;
    getSessionsControl?(): IOpencodeSessionsControl | undefined;
    navigateToSession?(sessionId: string): void;
    collapseAllSections?(): void;
}

interface IOpencodeSessionCommandContext {
    readonly id: string;
    readonly title: string;
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

function sessionContext(service: IOpencodeSessionsService, args: readonly unknown[]): IOpencodeSessionCommandContext | undefined {
    const candidate = args[0];
    if (typeof candidate === 'string') {
        const session = service.state.sessions.find(item => item.id === candidate);
        return {
            id: candidate,
            title: session?.title ?? (typeof args[1] === 'string' ? args[1] : candidate),
        };
    }

    const session = record(candidate) && record(candidate.session) ? candidate.session : candidate;
    if (!record(session) || typeof session.id !== 'string') {
        return undefined;
    }

    const knownSession = service.state.sessions.find(item => item.id === session.id);
    return {
        id: session.id,
        title: knownSession?.title ?? (typeof session.title === 'string' ? session.title : session.id),
    };
}

function optimisticSessionsService(service: IOpencodeSessionsService): OpencodeSessionsService | undefined {
    if (service instanceof OpencodeSessionsService) {
        return service;
    }

    return undefined;
}

function notifyError(notificationService: INotificationService, message: string, error: unknown): void {
    notificationService.error(`${message}: ${errorMessage(error)}`);
}

const SHOW_SESSIONS_SIDEBAR_ACTION = {
    id: 'opencode.sessions.showSidebar',
    title: localize2('opencode.sessions.showSidebar', "Show Sessions Sidebar"),
} as const;

const HIDE_SESSIONS_SIDEBAR_ACTION = {
    id: 'opencode.sessions.hideSidebar',
    title: localize2('opencode.sessions.hideSidebar', "Hide Sessions Sidebar"),
} as const;

const TOGGLE_SESSIONS_SIDEBAR_ACTION = {
    id: 'opencode.sessions.toggleSidebar',
    title: localize2('opencode.sessions.toggleSidebar', "Toggle Sessions Sidebar"),
} as const;

const REFRESH_SESSIONS_ACTION = {
    id: 'opencode.sessions.refresh',
    title: localize2('opencode.sessions.refresh', "Refresh Sessions"),
} as const;

const NEW_SESSION_ACTION = {
    id: 'opencode.sessions.new',
    title: localize2('opencode.sessions.new', "New Session"),
} as const;

const COLLAPSE_ALL_SESSIONS_ACTION = {
    id: 'opencode.sessions.collapseAll',
    title: localize2('opencode.sessions.collapseAll', "Collapse All Sessions"),
} as const;

const DELETE_SESSION_ACTION = {
    id: 'opencode.sessions.delete',
    title: localize2('opencode.sessions.delete', "Delete"),
} as const;

const RENAME_SESSION_ACTION = {
    id: 'opencode.sessions.rename',
    title: localize2('opencode.sessions.rename', "Rename"),
} as const;

const SHARE_SESSION_ACTION = {
    id: 'opencode.sessions.share',
    title: localize2('opencode.sessions.share', "Share"),
} as const;

const FORK_SESSION_ACTION = {
    id: 'opencode.sessions.fork',
    title: localize2('opencode.sessions.fork', "Fork"),
} as const;

const opencodeChatViewWhen = ContextKeyExpr.equals('view', OPENCODE_CHAT_VIEW_ID);
const opencodeSessionItemWhen = ContextKeyExpr.equals('viewItem', OPENCODE_SESSION_VIEW_ITEM);
const opencodeSessionsStackedWhen = OpencodeSessionsViewerOrientationContext.isEqualTo(OPENCODE_SESSIONS_ORIENTATION_STACKED);
const opencodeSessionsSideBySideWhen = OpencodeSessionsViewerOrientationContext.isEqualTo(OPENCODE_SESSIONS_ORIENTATION_SIDE_BY_SIDE);

registerAction2(class ShowSessionsSidebarAction extends Action2 {
    constructor() {
        super({
            id: SHOW_SESSIONS_SIDEBAR_ACTION.id,
            title: SHOW_SESSIONS_SIDEBAR_ACTION.title,
            category: OPENCODE_SESSIONS_CATEGORY,
            f1: true,
            icon: Codicon.layoutSidebarRightOff,
            precondition: opencodeSessionsStackedWhen,
        });
    }

    async run(accessor: ServicesAccessor): Promise<void> {
        accessor.get(IOpencodeSessionsService);

        // TODO(Task 10): SidebarPane exposes setSessionsOrientation once the SplitView host lands.
        await accessor.get(IViewsService)
            .getViewWithId<IOpencodeSessionsView>(OPENCODE_CHAT_VIEW_ID)
            ?.setSessionsOrientation?.(OpencodeSessionsViewerOrientation.SideBySide);
    }
});

registerAction2(class HideSessionsSidebarAction extends Action2 {
    constructor() {
        super({
            id: HIDE_SESSIONS_SIDEBAR_ACTION.id,
            title: HIDE_SESSIONS_SIDEBAR_ACTION.title,
            category: OPENCODE_SESSIONS_CATEGORY,
            f1: true,
            icon: Codicon.layoutSidebarRight,
            precondition: opencodeSessionsSideBySideWhen,
        });
    }

    async run(accessor: ServicesAccessor): Promise<void> {
        accessor.get(IOpencodeSessionsService);

        // TODO(Task 10): SidebarPane exposes setSessionsOrientation once the SplitView host lands.
        await accessor.get(IViewsService)
            .getViewWithId<IOpencodeSessionsView>(OPENCODE_CHAT_VIEW_ID)
            ?.setSessionsOrientation?.(OpencodeSessionsViewerOrientation.Stacked);
    }
});

registerAction2(class ToggleSessionsSidebarAction extends Action2 {
    constructor() {
        super({
            id: TOGGLE_SESSIONS_SIDEBAR_ACTION.id,
            title: TOGGLE_SESSIONS_SIDEBAR_ACTION.title,
            category: OPENCODE_SESSIONS_CATEGORY,
            f1: true,
            keybinding: {
                primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyS,
                weight: KeybindingWeight.WorkbenchContrib,
            },
        });
    }

    async run(accessor: ServicesAccessor): Promise<void> {
        accessor.get(IOpencodeSessionsService);

        const commandService = accessor.get(ICommandService);
        const currentOrientation = accessor.get(IViewsService)
            .getViewWithId<IOpencodeSessionsView>(OPENCODE_CHAT_VIEW_ID)
            ?.getSessionsOrientation?.();

        if (currentOrientation === OpencodeSessionsViewerOrientation.SideBySide) {
            await commandService.executeCommand(HIDE_SESSIONS_SIDEBAR_ACTION.id);
            return;
        }

        await commandService.executeCommand(SHOW_SESSIONS_SIDEBAR_ACTION.id);
    }
});

registerAction2(class RefreshSessionsAction extends Action2 {
    constructor() {
        super({
            id: REFRESH_SESSIONS_ACTION.id,
            title: REFRESH_SESSIONS_ACTION.title,
            category: OPENCODE_SESSIONS_CATEGORY,
            f1: true,
            icon: Codicon.refresh,
        });
    }

    async run(accessor: ServicesAccessor): Promise<void> {
        await accessor.get(IOpencodeSessionsService).refresh();
    }
});

registerAction2(class NewSessionAction extends Action2 {
    constructor() {
        super({
            id: NEW_SESSION_ACTION.id,
            title: NEW_SESSION_ACTION.title,
            category: OPENCODE_SESSIONS_CATEGORY,
            f1: true,
            icon: Codicon.add,
        });
    }

    async run(accessor: ServicesAccessor): Promise<void> {
        await accessor.get(IOpencodeSessionsService).createSession();
        // TODO(Task 11/13): navigate to the created session once the chat bridge/action UX is wired.
    }
});

registerAction2(class CollapseAllSessionsAction extends Action2 {
    constructor() {
        super({
            id: COLLAPSE_ALL_SESSIONS_ACTION.id,
            title: COLLAPSE_ALL_SESSIONS_ACTION.title,
            category: OPENCODE_SESSIONS_CATEGORY,
            f1: true,
            icon: Codicon.collapseAll,
        });
    }

    run(accessor: ServicesAccessor): void {
        accessor.get(IOpencodeSessionsService);

        // TODO(Task 10): SidebarPane exposes collapseAllSections once it owns the sessions control.
        accessor.get(IViewsService)
            .getViewWithId<IOpencodeSessionsView>(OPENCODE_CHAT_VIEW_ID)
            ?.collapseAllSections?.();
    }
});

registerAction2(class DeleteSessionAction extends Action2 {
    constructor() {
        super({
            id: DELETE_SESSION_ACTION.id,
            title: DELETE_SESSION_ACTION.title,
            category: OPENCODE_SESSIONS_CATEGORY,
        });
    }

    async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
        const service = accessor.get(IOpencodeSessionsService);
        const context = sessionContext(service, args);
        if (!context) {
            return;
        }

        const dialogService = accessor.get(IDialogService);
        const notificationService = accessor.get(INotificationService);
        const logService = accessor.get(ILogService);
        const confirmation = await dialogService.confirm({
            message: 'Delete session?',
            detail: context.title,
            primaryButton: 'Delete',
            type: 'warning',
        });
        if (!confirmation.confirmed) {
            return;
        }

        const rollback = optimisticSessionsService(service)?.applyOptimisticDelete(context.id);
        try {
            await service.deleteSession(context.id);
        } catch (error) {
            rollback?.();
            logService.error('[OpenCode] Failed to delete session', error);
            notifyError(notificationService, 'Failed to delete session', error);
        }
    }
});

registerAction2(class RenameSessionAction extends Action2 {
    constructor() {
        super({
            id: RENAME_SESSION_ACTION.id,
            title: RENAME_SESSION_ACTION.title,
            category: OPENCODE_SESSIONS_CATEGORY,
        });
    }

    async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
        const service = accessor.get(IOpencodeSessionsService);
        const context = sessionContext(service, args);
        if (!context) {
            return;
        }

        const newTitle = (await accessor.get(IQuickInputService).input({
            value: context.title,
            prompt: 'Rename session',
        }))?.trim();
        if (!newTitle || newTitle === context.title) {
            return;
        }

        const notificationService = accessor.get(INotificationService);
        const logService = accessor.get(ILogService);
        const rollback = optimisticSessionsService(service)?.applyOptimisticRename(context.id, newTitle);
        try {
            await service.renameSession(context.id, newTitle);
        } catch (error) {
            rollback?.();
            logService.error('[OpenCode] Failed to rename session', error);
            notifyError(notificationService, 'Failed to rename session', error);
        }
    }
});

registerAction2(class ShareSessionAction extends Action2 {
    constructor() {
        super({
            id: SHARE_SESSION_ACTION.id,
            title: SHARE_SESSION_ACTION.title,
            category: OPENCODE_SESSIONS_CATEGORY,
        });
    }

    async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
        const service = accessor.get(IOpencodeSessionsService);
        const context = sessionContext(service, args);
        if (!context) {
            return;
        }

        const clipboardService = accessor.get(IClipboardService);
        const notificationService = accessor.get(INotificationService);
        const logService = accessor.get(ILogService);
        try {
            await clipboardService.writeText(await service.shareSession(context.id));
            notificationService.info('Share URL copied');
        } catch (error) {
            logService.error('[OpenCode] Failed to share session', error);
            notifyError(notificationService, 'Failed to share session', error);
        }
    }
});

registerAction2(class ForkSessionAction extends Action2 {
    constructor() {
        super({
            id: FORK_SESSION_ACTION.id,
            title: FORK_SESSION_ACTION.title,
            category: OPENCODE_SESSIONS_CATEGORY,
        });
    }

    async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
        const service = accessor.get(IOpencodeSessionsService);
        const context = sessionContext(service, args);
        if (!context) {
            return;
        }

        const dialogService = accessor.get(IDialogService);
        const notificationService = accessor.get(INotificationService);
        const logService = accessor.get(ILogService);
        const confirmation = await dialogService.confirm({
            message: 'Fork session?',
            detail: context.title,
            primaryButton: 'Fork',
            type: 'warning',
        });
        if (!confirmation.confirmed) {
            return;
        }

        const commandService = accessor.get(ICommandService);
        try {
            const newId = await service.forkSession(context.id);
            await commandService.executeCommand(SHOW_SESSIONS_SIDEBAR_ACTION.id);
            const view = accessor.get(IViewsService).getViewWithId<IOpencodeSessionsView>(OPENCODE_CHAT_VIEW_ID);
            if (!view?.getSessionsControl?.()?.reveal(newId)) {
                view?.navigateToSession?.(newId);
            }
        } catch (error) {
            logService.error('[OpenCode] Failed to fork session', error);
            notifyError(notificationService, 'Failed to fork session', error);
        }
    }
});

MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
    command: {
        id: SHOW_SESSIONS_SIDEBAR_ACTION.id,
        title: SHOW_SESSIONS_SIDEBAR_ACTION.title,
        icon: Codicon.layoutSidebarRightOff,
    },
    group: 'navigation',
    order: 1,
    when: ContextKeyExpr.and(opencodeChatViewWhen, opencodeSessionsStackedWhen),
});

MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
    command: {
        id: HIDE_SESSIONS_SIDEBAR_ACTION.id,
        title: HIDE_SESSIONS_SIDEBAR_ACTION.title,
        icon: Codicon.layoutSidebarRight,
    },
    group: 'navigation',
    order: 1,
    when: ContextKeyExpr.and(opencodeChatViewWhen, opencodeSessionsSideBySideWhen),
});

MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
    command: {
        id: NEW_SESSION_ACTION.id,
        title: NEW_SESSION_ACTION.title,
        icon: Codicon.add,
    },
    group: 'navigation',
    order: 2,
    when: ContextKeyExpr.and(opencodeChatViewWhen, opencodeSessionsSideBySideWhen),
});

MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
    command: {
        id: REFRESH_SESSIONS_ACTION.id,
        title: REFRESH_SESSIONS_ACTION.title,
        icon: Codicon.refresh,
    },
    group: 'navigation',
    order: 3,
    when: ContextKeyExpr.and(opencodeChatViewWhen, opencodeSessionsSideBySideWhen),
});

MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
    command: {
        id: COLLAPSE_ALL_SESSIONS_ACTION.id,
        title: COLLAPSE_ALL_SESSIONS_ACTION.title,
        icon: Codicon.collapseAll,
    },
    group: 'navigation',
    order: 4,
    when: ContextKeyExpr.and(opencodeChatViewWhen, opencodeSessionsSideBySideWhen),
});

MenuRegistry.appendMenuItem(MenuId.ViewItemContext, {
    command: RENAME_SESSION_ACTION,
    group: 'navigation',
    order: 1,
    when: opencodeSessionItemWhen,
});

MenuRegistry.appendMenuItem(MenuId.ViewItemContext, {
    command: SHARE_SESSION_ACTION,
    group: 'navigation',
    order: 2,
    when: opencodeSessionItemWhen,
});

MenuRegistry.appendMenuItem(MenuId.ViewItemContext, {
    command: FORK_SESSION_ACTION,
    group: 'navigation',
    order: 3,
    when: opencodeSessionItemWhen,
});

MenuRegistry.appendMenuItem(MenuId.ViewItemContext, {
    command: DELETE_SESSION_ACTION,
    group: 'destructive',
    order: 4,
    when: opencodeSessionItemWhen,
});
