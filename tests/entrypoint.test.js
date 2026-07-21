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
