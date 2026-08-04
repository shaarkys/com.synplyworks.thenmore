'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createElement() {
  const listeners = {};
  const classes = new Set();
  return {
    children: [],
    className: '',
    dataset: {},
    disabled: false,
    focused: false,
    placeholder: '',
    textContent: '',
    value: '',
    classList: {
      add(...names) {
        names.forEach(name => classes.add(name));
      },
      contains(name) {
        return classes.has(name);
      },
      remove(...names) {
        names.forEach(name => classes.delete(name));
      },
      toggle(name, force) {
        if (force === true || (force === undefined && !classes.has(name))) {
          classes.add(name);
          return true;
        }
        classes.delete(name);
        return false;
      },
    },
    addEventListener(event, listener) {
      listeners[event] = listener;
    },
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = children;
    },
    focus() {
      this.focused = true;
    },
    setAttribute(name, value) {
      this[name] = value;
    },
    listeners,
  };
}

function createSettingsControllerContext() {
  const settingsPage = fs.readFileSync(path.join(__dirname, '..', 'settings', 'index.html'), 'utf8');
  const controller = fs.readFileSync(
    path.join(__dirname, '..', 'settings', 'timerController.js'),
    'utf8',
  );
  const elements = Object.fromEntries(
    Array.from(settingsPage.matchAll(/id="([^"]+)"/g), match => [match[1], createElement()]),
  );
  elements['timer-details-overlay'].classList.add('is-hidden');
  const realtimeListeners = {};
  const apiRequests = [];
  const alerts = [];
  let readyCalls = 0;
  const Homey = {
    __(key, tags) {
      return tags ? `${key}:${JSON.stringify(tags)}` : key;
    },
    alert(message) {
      alerts.push(message);
    },
    api(method, requestPath, data, callback) {
      apiRequests.push({ method, path: requestPath, data });
      callback(null, {});
    },
    get(key, callback) {
      callback(null, false);
    },
    on(event, listener) {
      realtimeListeners[event] = listener;
    },
    ready() {
      readyCalls += 1;
    },
    set(key, value, callback) {
      callback(null);
    },
  };
  const context = vm.createContext({
    clearInterval() {},
    console,
    document: {
      createElement,
      getElementById(id) {
        return elements[id] || null;
      },
    },
    setInterval() {
      return 1;
    },
    window: {
      addEventListener() {},
      confirm() {
        return true;
      },
    },
  });

  vm.runInContext(controller, context);
  context.onHomeyReady(Homey);

  return {
    apiRequests,
    alerts,
    elements,
    readyCalls,
    realtimeListeners,
  };
}

test('settings controller initializes, loads activity, and renders realtime updates', () => {
  const settingsPage = fs.readFileSync(path.join(__dirname, '..', 'settings', 'index.html'), 'utf8');
  const controller = fs.readFileSync(
    path.join(__dirname, '..', 'settings', 'timerController.js'),
    'utf8',
  );
  const elements = Object.fromEntries(
    Array.from(settingsPage.matchAll(/id="([^"]+)"/g), match => [match[1], createElement()]),
  );
  elements['timer-details-overlay'].classList.add('is-hidden');
  const realtimeListeners = {};
  const apiRequests = [];
  const alerts = [];
  let readyCalls = 0;
  const Homey = {
    __(key, tags) {
      return tags ? `${key}:${JSON.stringify(tags)}` : key;
    },
    alert(message) {
      alerts.push(message);
    },
    api(method, requestPath, data, callback) {
      apiRequests.push({ method, path: requestPath, data });
      callback(null, {});
    },
    get(key, callback) {
      callback(null, false);
    },
    on(event, listener) {
      realtimeListeners[event] = listener;
    },
    ready() {
      readyCalls += 1;
    },
    set(key, value, callback) {
      callback(null);
    },
  };
  const context = vm.createContext({
    clearInterval() {},
    console,
    document: {
      createElement,
      getElementById(id) {
        return elements[id] || null;
      },
    },
    setInterval() {
      return 1;
    },
    window: {
      addEventListener() {},
      confirm() {
        return true;
      },
    },
  });

  vm.runInContext(controller, context);
  context.onHomeyReady(Homey);

  assert.equal(readyCalls, 1);
  assert.deepEqual(alerts, []);
  assert.deepEqual(apiRequests.map(request => `${request.method} ${request.path}`).sort(), [
    'GET /timer-activity',
    'GET /timers',
  ]);

  const device = { id: 'device-1', name: 'Hall light' };
  realtimeListeners.timer_activity({
    activity: {
      'device-1': {
        device,
        event: 'started',
        changedAt: Date.now(),
        counterDate: '2026-07-22',
        invocations: 3,
        invocationsToday: 3,
      },
    },
  });
  realtimeListeners.timer_started({
    timers: {
      'device-1': {
        device,
        startTime: Date.now(),
        offTime: Date.now() + 60_000,
        capability: 'onoff',
        value: true,
        oldValue: false,
      },
    },
  });

  assert.equal(elements['activity-body'].children.length, 1);
  const activityRow = elements['activity-body'].children[0];
  assert.equal(activityRow.children[0].textContent, 'Hall light');
  assert.equal(activityRow.children[0].dataset.label, 'settings.device_name');
  assert.equal(activityRow.children[3].textContent, '3');
  assert.equal(activityRow.children[4].className, 'timer-actions-cell');

  const detailsButton = activityRow.children[4].children[0].children[0];
  detailsButton.listeners.click();
  assert.equal(elements['timer-details-overlay'].classList.contains('is-hidden'), false);
  assert.equal(elements['timer-details-overlay']['aria-hidden'], 'false');
  assert.equal(elements['detail-device-name'].textContent, 'Hall light');
  assert.equal(elements['close-details'].focused, true);

  elements['close-details'].listeners.click();
  assert.equal(elements['timer-details-overlay'].classList.contains('is-hidden'), true);
  assert.equal(elements['timer-details-overlay']['aria-hidden'], 'true');
});

test('settings activity filters combine device search with running or stopped status', () => {
  const {
    elements,
    realtimeListeners,
  } = createSettingsControllerContext();

  assert.equal(elements['activity-empty'].classList.contains('is-hidden'), false);
  assert.equal(elements['activity-no-results'].classList.contains('is-hidden'), true);
  assert.equal(elements['activity-table'].classList.contains('is-hidden'), true);

  const now = Date.now();
  const runningDevice = { id: 'device-running', name: 'Hall light' };
  const stoppedDevice = { id: 'device-stopped', name: 'Kitchen fan' };
  realtimeListeners.timer_activity({
    activity: {
      'device-running': {
        device: runningDevice,
        event: 'started',
        changedAt: now,
        invocationsToday: 2,
      },
      'device-stopped': {
        device: stoppedDevice,
        event: 'started',
        changedAt: now - 1_000,
        invocationsToday: 1,
      },
    },
  });
  realtimeListeners.timer_started({
    timers: {
      'device-running': {
        device: runningDevice,
        startTime: now,
        offTime: now + 60_000,
        capability: 'onoff',
        value: true,
        oldValue: false,
      },
    },
  });

  elements['activity-status-filter'].value = 'running';
  elements['activity-status-filter'].listeners.change();
  assert.equal(elements['activity-body'].children.length, 1);
  assert.equal(elements['activity-body'].children[0].children[0].textContent, 'Hall light');

  elements['activity-status-filter'].value = 'stopped';
  elements['activity-status-filter'].listeners.change();
  assert.equal(elements['activity-body'].children.length, 1);
  assert.equal(elements['activity-body'].children[0].children[0].textContent, 'Kitchen fan');

  elements['activity-search'].value = 'DEVICE-STOPPED';
  elements['activity-search'].listeners.input();
  assert.equal(elements['activity-body'].children.length, 1);
  assert.equal(elements['activity-body'].children[0].children[0].textContent, 'Kitchen fan');

  elements['activity-search'].value = 'does-not-exist';
  elements['activity-search'].listeners.input();
  assert.equal(elements['activity-body'].children.length, 0);
  assert.equal(elements['activity-table'].classList.contains('is-hidden'), true);
  assert.equal(elements['activity-empty'].classList.contains('is-hidden'), true);
  assert.equal(elements['activity-no-results'].classList.contains('is-hidden'), false);
  assert.equal(elements['clear-activity'].disabled, false);
});
