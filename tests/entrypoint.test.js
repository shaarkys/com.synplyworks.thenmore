'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('compiled app entrypoint exports the Homey App class directly', () => {
  const compiledApp = fs.readFileSync(path.join(__dirname, '..', '.homeybuild', 'app.js'), 'utf8');

  assert.match(compiledApp, /module\.exports = TimerApp;/);
  assert.doesNotMatch(compiledApp, /exports\.default = TimerApp;/);
});

test('settings controller loads after the settings page DOM', () => {
  const settingsPage = fs.readFileSync(path.join(__dirname, '..', 'settings', 'index.html'), 'utf8');
  const detailsIndex = settingsPage.indexOf('id="timer-details"');
  const controllerIndex = settingsPage.indexOf('src="timerController.js"');
  const bodyEndIndex = settingsPage.indexOf('</body>');

  assert.ok(detailsIndex >= 0);
  assert.ok(controllerIndex > detailsIndex);
  assert.ok(controllerIndex < bodyEndIndex);
});

test('settings controller exposes Homey lifecycle and marks the page ready first', () => {
  const controller = fs.readFileSync(
    path.join(__dirname, '..', 'settings', 'timerController.js'),
    'utf8',
  );
  const lifecycleIndex = controller.indexOf('function onHomeyReady(Homey)');
  const readyIndex = controller.indexOf('homeyClient.ready()', lifecycleIndex);
  const translationIndex = controller.indexOf('translatePage()', lifecycleIndex);

  assert.ok(lifecycleIndex >= 0);
  assert.ok(readyIndex > lifecycleIndex);
  assert.ok(readyIndex < translationIndex);
});

test('settings lifecycle dependencies are safe when Homey invokes the hoisted callback early', () => {
  const controller = fs.readFileSync(
    path.join(__dirname, '..', 'settings', 'timerController.js'),
    'utf8',
  );

  assert.match(controller, /var homeyClient;/);
  assert.match(controller, /var timers;/);
  assert.match(controller, /function byId\(id\)/);
  assert.doesNotMatch(controller, /let homeyClient|const byId/);
});

test('settings controller references existing page elements', () => {
  const settingsPage = fs.readFileSync(path.join(__dirname, '..', 'settings', 'index.html'), 'utf8');
  const controller = fs.readFileSync(
    path.join(__dirname, '..', 'settings', 'timerController.js'),
    'utf8',
  );
  const directReferences = Array.from(controller.matchAll(/byId\('([^']+)'\)/g), match => match[1]);
  const translationReferences = Array.from(
    controller.matchAll(/\s+'([^']+)': 'settings\.[^']+',?/g),
    match => match[1],
  );

  for (const elementId of new Set([...directReferences, ...translationReferences])) {
    assert.match(settingsPage, new RegExp(`id=["']${elementId}["']`), `Missing #${elementId}`);
  }
});

test('timer activity API routes remain additive to the existing timer API', () => {
  const composeManifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '.homeycompose', 'app.json'), 'utf8'),
  );
  const apiSource = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');

  assert.deepEqual(composeManifest.api.getTimers, { method: 'get', path: '/timers' });
  assert.deepEqual(composeManifest.api.deleteTimer, { method: 'delete', path: '/timers/:id' });
  assert.deepEqual(composeManifest.api.getTimerActivity, {
    method: 'get',
    path: '/timer-activity',
  });
  assert.deepEqual(composeManifest.api.clearTimerActivity, {
    method: 'delete',
    path: '/timer-activity',
  });
  assert.match(apiSource, /async getTimerActivity/);
  assert.match(apiSource, /async clearTimerActivity/);
});
