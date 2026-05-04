/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import type { IView } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IOpencodeSessionsService, OpencodeSessionsViewerOrientation } from '../common/opencodeSessionsTypes.js';

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
    collapseAllSections?(): void;
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
        if (typeof args[0] !== 'string') {
            return;
        }

        await accessor.get(IOpencodeSessionsService).deleteSession(args[0]);
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
        if (typeof args[0] !== 'string' || typeof args[1] !== 'string') {
            return;
        }

        await accessor.get(IOpencodeSessionsService).renameSession(args[0], args[1]);
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
        if (typeof args[0] !== 'string') {
            return;
        }

        await accessor.get(IOpencodeSessionsService).shareSession(args[0]);
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
        if (typeof args[0] !== 'string') {
            return;
        }

        await accessor.get(IOpencodeSessionsService).forkSession(args[0]);
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
