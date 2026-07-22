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
