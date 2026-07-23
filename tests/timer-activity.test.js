'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  clearInactiveTimerActivity,
  getDateKey,
  incrementInvocation,
  pruneTimerActivity,
  updateTimerActivity,
} = require('../.homeybuild/lib/timer-activity');

function createEntry(overrides = {}) {
  return {
    device: { id: 'device-1', name: 'Light' },
    event: 'started',
    changedAt: Date.parse('2026-07-22T08:00:00Z'),
    counterDate: '2026-07-22',
    invocations: 2,
    capability: 'onoff',
    value: true,
    duration: 60,
    ...overrides,
  };
}

test('daily invocation counter increments and rolls over on a new date', () => {
  assert.deepEqual(incrementInvocation(createEntry(), '2026-07-22'), {
    counterDate: '2026-07-22',
    invocations: 3,
  });
  assert.deepEqual(incrementInvocation(createEntry(), '2026-07-23'), {
    counterDate: '2026-07-23',
    invocations: 1,
  });
});

test('lifecycle updates preserve same-day invocations and reset a stale daily count', () => {
  const cancelled = updateTimerActivity(createEntry(), {
    device: { id: 'device-1', name: 'Light' },
    event: 'cancelled_settings',
    changedAt: Date.parse('2026-07-22T09:00:00Z'),
    counterDate: '2026-07-22',
  });
  assert.equal(cancelled.invocations, 2);

  const completedNextDay = updateTimerActivity(cancelled, {
    device: cancelled.device,
    event: 'completed',
    changedAt: Date.parse('2026-07-23T09:00:00Z'),
    counterDate: '2026-07-23',
  });
  assert.equal(completedNextDay.invocations, 0);
});

test('date keys follow the configured Homey timezone', () => {
  const timestamp = Date.parse('2026-07-21T22:30:00Z');
  assert.equal(getDateKey(timestamp, 'Europe/Prague'), '2026-07-22');
  assert.equal(getDateKey(timestamp, 'America/New_York'), '2026-07-21');
});

test('activity pruning keeps recent and active entries only', () => {
  const now = Date.parse('2026-07-31T12:00:00Z');
  const entries = {
    active: createEntry({ device: { id: 'active', name: 'Active' }, changedAt: 0 }),
    recent: createEntry({ device: { id: 'recent', name: 'Recent' }, changedAt: now - 1000 }),
    stale: createEntry({ device: { id: 'stale', name: 'Stale' }, changedAt: 0 }),
  };

  const result = pruneTimerActivity(entries, now, new Set(['active']), 30 * 24 * 60 * 60 * 1000);
  assert.deepEqual(Object.keys(result).sort(), ['active', 'recent']);
});

test('clearing activity preserves active timer records only', () => {
  const entries = {
    active: createEntry({ device: { id: 'active', name: 'Active' } }),
    stopped: createEntry({ device: { id: 'stopped', name: 'Stopped' }, event: 'completed' }),
  };

  const result = clearInactiveTimerActivity(entries, new Set(['active']));
  assert.deepEqual(Object.keys(result), ['active']);
  assert.equal(result.active.event, 'started');
});
