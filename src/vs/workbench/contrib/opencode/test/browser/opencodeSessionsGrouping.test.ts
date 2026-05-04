/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// biome-ignore lint/style/useNodejsImportProtocol: browser unit tests load assert through the test runner bundle.
import * as assert from 'assert';
import { formatRelativeTime, groupByDate } from '../../common/opencodeSessionsGrouping.js';

suite('groupByDate', () => {
	const startOfToday = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;

	function session(id: string, created: number, updated = created) {
		return { id, title: id, time: { created, updated } };
	}

	function groupIds(groups: ReturnType<typeof groupByDate>) {
		return groups.map(group => group.id);
	}

	test('empty input returns empty output', () => {
		assert.deepStrictEqual(groupByDate([], 'created'), []);
	});

	test('all today sessions produce a single today group sorted by created time', () => {
		const sessions = [session('older-today', startOfToday + hour), session('newer-today', startOfToday + 2 * hour)];

		assert.deepStrictEqual(groupByDate(sessions, 'created'), [{
			id: 'today',
			label: 'Today',
			sessions: [sessions[1], sessions[0]],
		}]);
		assert.deepStrictEqual(sessions.map(item => item.id), ['older-today', 'newer-today']);
	});

	test('mixed buckets distribute sessions across all four groups', () => {
		const sessions = [
			session('older', startOfToday - 8 * day),
			session('this-week', startOfToday - 3 * day),
			session('yesterday', startOfToday - hour),
			session('today', startOfToday + hour),
		];

		assert.deepStrictEqual(groupByDate(sessions, 'created').map(group => [group.id, group.sessions.map(item => item.id)]), [
			['today', ['today']],
			['yesterday', ['yesterday']],
			['thisWeek', ['this-week']],
			['older', ['older']],
		]);
	});

	test('midnight boundary belongs to today', () => {
		assert.deepStrictEqual(groupByDate([session('midnight', startOfToday)], 'created').map(group => [group.id, group.sessions[0].id]), [
			['today', 'midnight'],
		]);
	});

	test('sortBy updated differs from sortBy created when timestamps differ', () => {
		const sessions = [
			session('created-first', startOfToday + 3 * hour, startOfToday + hour),
			session('updated-first', startOfToday + hour, startOfToday + 3 * hour),
		];

		assert.deepStrictEqual(groupByDate(sessions, 'created')[0].sessions.map(item => item.id), ['created-first', 'updated-first']);
		assert.deepStrictEqual(groupByDate(sessions, 'updated')[0].sessions.map(item => item.id), ['updated-first', 'created-first']);
	});

	test('empty groups are skipped', () => {
		assert.deepStrictEqual(groupIds(groupByDate([session('older', startOfToday - 8 * day)], 'created')), ['older']);
	});

	test('formatRelativeTime returns now for current timestamp', () => {
		assert.strictEqual(formatRelativeTime(Date.now()), 'now');
	});
});
