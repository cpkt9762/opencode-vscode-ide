/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import type { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon, themeColorFromId } from '../../../../base/common/themables.js';
import { formatRelativeTime } from '../common/opencodeSessionsGrouping.js';
import type { IOpencodeSession, IOpencodeSessionGroup, IOpencodeSessionStatus } from '../common/opencodeSessionsTypes.js';

const GROUP_TEMPLATE_ID = 'group';
const SESSION_TEMPLATE_ID = 'session';

export type IOpencodeListItem = IOpencodeGroupListItem | IOpencodeSessionListItem;

export interface IOpencodeGroupListItem {
	readonly kind: 'group';
	readonly group: IOpencodeSessionGroup;
	readonly collapsed?: boolean;
}

export interface IOpencodeSessionListItem {
	readonly kind: 'session';
	readonly session: IOpencodeSession;
	readonly status?: IOpencodeSessionStatus;
	readonly depth?: 0 | 1;
	readonly childCount?: number;
	readonly expanded?: boolean;
}

export interface IOpencodeGroupHeaderTemplate {
	readonly container: HTMLElement;
	readonly label: HTMLElement;
	readonly count: HTMLElement;
	readonly chevron: HTMLElement;
}

export interface IOpencodeSessionRowTemplate {
	readonly container: HTMLElement;
	readonly chevron: HTMLElement;
	readonly statusIcon: HTMLElement;
	readonly title: HTMLElement;
	readonly time: HTMLElement;
}

interface IStatusIconPresentation {
	readonly icon: ThemeIcon;
	readonly colorClass?: string;
}

export class OpencodeSessionsGroupHeaderRenderer implements IListRenderer<IOpencodeListItem, IOpencodeGroupHeaderTemplate> {

	readonly templateId = GROUP_TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IOpencodeGroupHeaderTemplate {
		const header = dom.append(container, dom.$('.sessions-group-header'));
		const label = dom.append(header, dom.$('span.label'));
		const count = dom.append(header, dom.$('span.count'));
		const chevron = dom.append(header, dom.$('.chevron'));

		return { container: header, label, count, chevron };
	}

	renderElement(element: IOpencodeListItem, _index: number, template: IOpencodeGroupHeaderTemplate): void {
		if (element.kind !== 'group') {
			return;
		}

		template.label.textContent = element.group.label;
		template.count.textContent = String(element.group.sessions.length);
		template.chevron.className = `chevron ${ThemeIcon.asClassName(element.collapsed ? Codicon.chevronRight : Codicon.chevronDown)}`;
	}

	disposeTemplate(template: IOpencodeGroupHeaderTemplate): void {
		template.container.remove();
	}
}

export class OpencodeSessionsRowRenderer implements IListRenderer<IOpencodeListItem, IOpencodeSessionRowTemplate> {

	readonly templateId = SESSION_TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IOpencodeSessionRowTemplate {
		const row = dom.append(container, dom.$('.sessions-session-row'));
		const chevron = dom.append(row, dom.$('.session-chevron'));
		const statusIcon = dom.append(row, dom.$('.status-icon'));
		const title = dom.append(row, dom.$('.title'));
		const time = dom.append(row, dom.$('.time'));

		return { container: row, chevron, statusIcon, title, time };
	}

	renderElement(element: IOpencodeListItem, _index: number, template: IOpencodeSessionRowTemplate): void {
		if (element.kind !== 'session') {
			return;
		}

		template.container.classList.toggle('is-child', element.depth === 1);

		template.title.textContent = element.session.title;
		template.title.title = element.session.title;
		template.time.textContent = formatRelativeTime(element.session.time.updated);

		template.chevron.dataset['sessionId'] = element.session.id;
		template.chevron.className = element.childCount
			? `session-chevron ${ThemeIcon.asClassName(element.expanded ? Codicon.chevronDown : Codicon.chevronRight)}`
			: 'session-chevron empty';

		const statusIcon = sessionStatusIcon(element.status);
		template.statusIcon.className = `status-icon ${ThemeIcon.asClassName(statusIcon.icon)}`;
		if (statusIcon.colorClass) {
			template.statusIcon.classList.add(statusIcon.colorClass);
		}
	}

	disposeTemplate(template: IOpencodeSessionRowTemplate): void {
		template.container.remove();
	}
}

export class OpencodeSessionsListVirtualDelegate implements IListVirtualDelegate<IOpencodeListItem> {

	getHeight(element: IOpencodeListItem): number {
		if (element.kind === 'group') {
			return 24;
		}
		return 44;
	}

	getTemplateId(element: IOpencodeListItem): string {
		if (element.kind === 'group') {
			return GROUP_TEMPLATE_ID;
		}
		return SESSION_TEMPLATE_ID;
	}
}

export const extractAgentName = (title: string): string | undefined => /@(\S+)\s+subagent/i.exec(title)?.[1];

function sessionStatusIcon(status: IOpencodeSessionStatus | undefined): IStatusIconPresentation {
	if (status === 'busy') {
		return {
			icon: { ...ThemeIcon.modify(Codicon.sync, 'spin'), color: themeColorFromId('charts.blue') },
			colorClass: 'charts-blue',
		};
	}
	if (status === 'idle') {
		return { icon: Codicon.check };
	}
	if (status === 'retry') {
		return { icon: Codicon.warning };
	}
	return { icon: Codicon.circleOutline };
}
