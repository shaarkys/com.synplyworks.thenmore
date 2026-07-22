'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_NATIVE_TIMEOUT_MS,
  getNextTimeoutDelay,
  getTimeoutActions,
  mergeRestoreState,
  shouldCancelTimer,
  shouldStartTimer,
  validateDurationSeconds,
} = require('../.homeybuild/lib/timer-utils');

test('a shorter timer does not replace the same target when longest wins', () => {
  assert.equal(shouldStartTimer({
    hasTimer: true,
    sameTarget: true,
    isAlreadyInTimedState: true,
    ignoreCurrentState: true,
    overrideLongerTimer: false,
    currentOffTime: 60_000,
    requestedOffTime: 10_000,
  }), false);
});

test('a changed target replaces the current timer', () => {
  assert.equal(shouldStartTimer({
    hasTimer: true,
    sameTarget: false,
    isAlreadyInTimedState: false,
    ignoreCurrentState: false,
    overrideLongerTimer: false,
    currentOffTime: 60_000,
    requestedOffTime: 10_000,
  }), true);
});

test('invalid timer durations are rejected at runtime', () => {
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '10']) {
    assert.throws(() => validateDurationSeconds(value), /duration/i);
  }
});

test('long timers are split into safe native timeout chunks', () => {
  const now = 1_000;
  assert.equal(getNextTimeoutDelay(now + MAX_NATIVE_TIMEOUT_MS + 10_000, now), MAX_NATIVE_TIMEOUT_MS);
  assert.equal(getNextTimeoutDelay(now + 5_000, now), 5_000);
});

test('dim restoration returns a previously off light to its full prior state', () => {
  assert.deepEqual(
    getTimeoutActions('dim', { dim: 0.6, onoff: false }, new Set(['dim', 'onoff'])),
    [
      { capability: 'dim', value: 0.6 },
      { capability: 'onoff', value: false },
    ],
  );
});

test('restore state remains keyed by capability across replacements', () => {
  assert.deepEqual(
    mergeRestoreState({ onoff: true }, { dim: 0.4, onoff: false }),
    { onoff: false, dim: 0.4 },
  );
});

test('manual changes cancel timers for both boolean and dim values', () => {
  assert.equal(shouldCancelTimer(true, false), true);
  assert.equal(shouldCancelTimer(0.5, 0.7), true);
  assert.equal(shouldCancelTimer(0.5, 0.5), false);
});
