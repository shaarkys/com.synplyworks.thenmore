'use strict';

var homeyClient;
var timers;
var refreshInterval;

function byId(id) {
  return document.getElementById(id);
}

function translatePage() {
  const translations = {
    'page-title': 'settings.title',
    'page-subtitle': 'settings.subtitle',
    'debug-title': 'settings.debug_title',
    'debug-label': 'settings.debug_label',
    'debug-hint': 'settings.debug_hint',
    'save-settings': 'settings.save',
    'timers-title': 'settings.timers_title',
    'timers-empty': 'settings.no_timers',
    'timer-name-heading': 'settings.timer_name',
    'timer-remaining-heading': 'settings.time_remaining',
    'timer-action-heading': 'settings.action',
    'detail-device-id-label': 'settings.device_id',
    'detail-device-name-label': 'settings.device_name',
    'detail-capability-label': 'settings.capability',
    'detail-value-label': 'settings.current_value',
    'detail-old-value-label': 'settings.previous_value',
  };

  Object.entries(translations).forEach(([elementId, translationKey]) => {
    byId(elementId).textContent = homeyClient.__(translationKey);
  });
}

function remainingInSeconds(offTime) {
  return Math.max(0, Math.ceil((offTime - Date.now()) / 1000));
}

function createButton(labelKey, clickHandler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'homey-button-secondary-shadow';
  button.textContent = homeyClient.__(labelKey);
  button.addEventListener('click', clickHandler);
  return button;
}

function showDetails(timer) {
  byId('detail-device-id').textContent = timer.device.id;
  byId('detail-device-name').textContent = timer.device.name;
  byId('detail-capability').textContent = timer.capability;
  byId('detail-value').textContent = String(timer.value);
  byId('detail-old-value').textContent = timer.oldValue === null ? '-' : String(timer.oldValue);
  byId('timer-details').classList.remove('is-hidden');
}

function cancelTimer(deviceId) {
  homeyClient.api('DELETE', `/timers/${encodeURIComponent(deviceId)}`, null, (error) => {
    if (error) {
      homeyClient.alert(error);
    }
  });
}

function renderTimers() {
  const now = Date.now();
  timers = Object.fromEntries(Object.entries(timers).filter(([, timer]) => timer.offTime > now));

  const timerEntries = Object.values(timers).sort((a, b) => a.offTime - b.offTime);
  const body = byId('timers-body');
  body.replaceChildren();

  for (const timer of timerEntries) {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    const remainingCell = document.createElement('td');
    const actionCell = document.createElement('td');
    const actions = document.createElement('div');

    nameCell.textContent = timer.device.name;
    remainingCell.textContent = homeyClient.__('settings.seconds_remaining', {
      seconds: remainingInSeconds(timer.offTime),
    });
    actions.className = 'timer-actions';
    actions.append(
      createButton('settings.show_details', () => showDetails(timer)),
      createButton('settings.cancel_timer', () => cancelTimer(timer.device.id)),
    );
    actionCell.append(actions);
    row.append(nameCell, remainingCell, actionCell);
    body.append(row);
  }

  byId('timers-table').classList.toggle('is-hidden', timerEntries.length === 0);
  byId('timers-empty').classList.toggle('is-hidden', timerEntries.length > 0);
}

function updateTimers(updatedTimers) {
  timers = updatedTimers && typeof updatedTimers === 'object' ? updatedTimers : {};
  renderTimers();
}

function loadSettings() {
  homeyClient.get('timeline_debug_enabled', (error, result) => {
    if (error) {
      homeyClient.alert(error);
      return;
    }
    byId('timeline-debug-enabled').checked = result === true;
  });
}

function loadTimers() {
  homeyClient.api('GET', '/timers', null, (error, result) => {
    if (error) {
      homeyClient.alert(error);
      return;
    }
    updateTimers(result);
  });
}

function saveSettings() {
  homeyClient.set('timeline_debug_enabled', byId('timeline-debug-enabled').checked, (error) => {
    if (error) {
      homeyClient.alert(error);
      return;
    }
    homeyClient.alert(homeyClient.__('settings.saved'));
  });
}

// Homey invokes this global lifecycle callback.
// eslint-disable-next-line no-unused-vars
function onHomeyReady(Homey) {
  homeyClient = Homey;
  timers = {};
  homeyClient.ready();
  try {
    translatePage();
    byId('save-settings').addEventListener('click', saveSettings);
    homeyClient.on('timer_started', event => updateTimers(event.timers));
    homeyClient.on('timer_deleted', event => updateTimers(event.timers));
    loadSettings();
    loadTimers();
    refreshInterval = setInterval(renderTimers, 1000);
    window.addEventListener('beforeunload', () => clearInterval(refreshInterval), { once: true });
  } catch (error) {
    homeyClient.alert(error instanceof Error ? error.message : String(error));
  }
}
