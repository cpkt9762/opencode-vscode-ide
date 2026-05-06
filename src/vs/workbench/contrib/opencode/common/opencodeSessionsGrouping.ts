/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// TEMP: replace with import once T1 lands
export interface IOpencodeSession {
	id: string;
	title: string;
	parentID?: string;
	time: { created: number; updated: number };
}

// TEMP: replace with import once T1 lands
export type SessionsGroupId = 'today' | 'yesterday' | 'thisWeek' | 'older';

// TEMP: replace with import once T1 lands
export interface IOpencodeSessionGroup {
	id: SessionsGroupId;
	label: string;
	sessions: IOpencodeSession[];
}

export function groupByDate(sessions: IOpencodeSession[], sortBy: 'created' | 'updated'): IOpencodeSessionGroup[] {
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const startOfYesterday = startOfToday - 86_400_000;
	const startOfWeek = startOfToday - 7 * 86_400_000;
	const groups = new Map<SessionsGroupId, IOpencodeSession[]>([
		['today', []],
		['yesterday', []],
		['thisWeek', []],
		['older', []],
	]);

	sessions.forEach(session => {
		groups.get(groupId(session.time[sortBy], startOfToday, startOfYesterday, startOfWeek))?.push(session);
	});

	return groupDefinitions
		.map(group => ({
			...group,
			sessions: (groups.get(group.id) ?? []).slice().sort((a, b) => b.time[sortBy] - a.time[sortBy]),
		}))
		.filter(group => group.sessions.length > 0);
}

export function formatRelativeTime(ts: number): string {
	const elapsed = Math.max(0, Date.now() - ts);
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	const month = 30 * day;
	const year = 365 * day;
	if (elapsed < minute) {
		return 'now';
	}
	if (elapsed < hour) {
		return `${Math.floor(elapsed / minute)}m ago`;
	}
	if (elapsed < day) {
		return `${Math.floor(elapsed / hour)}h ago`;
	}
	if (elapsed < month) {
		return `${Math.floor(elapsed / day)}d ago`;
	}
	if (elapsed < year) {
		return `${Math.floor(elapsed / month)}mo ago`;
	}
	return `${Math.floor(elapsed / year)}y ago`;
}

const groupDefinitions: readonly Pick<IOpencodeSessionGroup, 'id' | 'label'>[] = [
	{ id: 'today', label: 'Today' },
	{ id: 'yesterday', label: 'Yesterday' },
	{ id: 'thisWeek', label: 'This Week' },
	{ id: 'older', label: 'Older' },
];

function groupId(ts: number, startOfToday: number, startOfYesterday: number, startOfWeek: number): SessionsGroupId {
	if (ts >= startOfToday) {
		return 'today';
	}
	if (ts >= startOfYesterday) {
		return 'yesterday';
	}
	if (ts >= startOfWeek) {
		return 'thisWeek';
	}
	return 'older';
}
