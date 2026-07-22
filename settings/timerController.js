'use strict';

var homeyClient;
var timers;
var timerActivity;
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
    'activity-title': 'settings.activity_title',
    'activity-hint': 'settings.activity_hint',
    'activity-empty': 'settings.no_activity',
    'clear-activity': 'settings.clear_activity',
    'activity-device-heading': 'settings.device_name',
    'activity-status-heading': 'settings.status',
    'activity-time-heading': 'settings.remaining_or_changed',
    'activity-invocations-heading': 'settings.invocations_today',
    'activity-action-heading': 'settings.action',
    'details-title': 'settings.details_title',
    'close-details': 'settings.close',
    'detail-device-id-label': 'settings.device_id',
    'detail-device-name-label': 'settings.device_name',
    'detail-capability-label': 'settings.capability',
    'detail-value-label': 'settings.current_value',
    'detail-old-value-label': 'settings.previous_value',
    'detail-status-label': 'settings.status',
    'detail-last-change-label': 'settings.last_change',
    'detail-invocations-label': 'settings.invocations_today',
    'detail-duration-label': 'settings.requested_duration',
    'detail-message-label': 'settings.diagnostic_message',
  };

  Object.entries(translations).forEach(([elementId, translationKey]) => {
    byId(elementId).textContent = homeyClient.__(translationKey);
  });
}

function remainingInSeconds(offTime) {
  return Math.max(0, Math.ceil((offTime - Date.now()) / 1000));
}

function formatTimestamp(timestamp) {
  return typeof timestamp === 'number' ? new Date(timestamp).toLocaleString() : '-';
}

function formatValue(value) {
  return value === null || value === undefined ? '-' : String(value);
}

function formatStatus(event) {
  return homeyClient.__(`settings.activity_status.${event || 'requested'}`);
}

function createButton(labelKey, clickHandler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'homey-button-secondary-shadow';
  button.textContent = homeyClient.__(labelKey);
  button.addEventListener('click', clickHandler);
  return button;
}

function getActivityRows() {
  const deviceIds = new Set([...Object.keys(timerActivity), ...Object.keys(timers)]);
  return Array.from(deviceIds).map((deviceId) => {
    const timer = timers[deviceId];
    const activity = timerActivity[deviceId] || {};
    return {
      deviceId,
      timer,
      activity,
      device: timer?.device || activity.device || { id: deviceId, name: deviceId },
      event: activity.event || (timer ? 'restored' : 'requested'),
      changedAt: activity.changedAt || timer?.startTime,
      invocationsToday: activity.invocationsToday || 0,
    };
  }).sort((left, right) => {
    if (Boolean(left.timer) !== Boolean(right.timer)) {
      return left.timer ? -1 : 1;
    }
    if (left.timer && right.timer) {
      return left.timer.offTime - right.timer.offTime;
    }
    return (right.changedAt || 0) - (left.changedAt || 0);
  });
}

function showDetails(row) {
  const timer = row.timer;
  const activity = row.activity;
  byId('detail-device-id').textContent = row.device.id;
  byId('detail-device-name').textContent = row.device.name;
  byId('detail-capability').textContent = activity.capability || timer?.capability || '-';
  byId('detail-value').textContent = formatValue(activity.value ?? timer?.value);
  byId('detail-old-value').textContent = formatValue(activity.previousValue ?? timer?.oldValue);
  byId('detail-status').textContent = formatStatus(row.event);
  byId('detail-last-change').textContent = formatTimestamp(row.changedAt);
  byId('detail-invocations').textContent = String(row.invocationsToday);
  byId('detail-duration').textContent = activity.duration
    ? homeyClient.__('settings.seconds_remaining', { seconds: activity.duration })
    : '-';
  byId('detail-message').textContent = activity.message || '-';
  const overlay = byId('timer-details-overlay');
  overlay.classList.remove('is-hidden');
  overlay.setAttribute('aria-hidden', 'false');
  byId('close-details').focus();
}

function hideDetails() {
  const overlay = byId('timer-details-overlay');
  overlay.classList.add('is-hidden');
  overlay.setAttribute('aria-hidden', 'true');
}

function cancelTimer(deviceId) {
  homeyClient.api('DELETE', `/timers/${encodeURIComponent(deviceId)}`, null, (error) => {
    if (error) {
      homeyClient.alert(error);
    }
  });
}

function clearActivity() {
  if (!window.confirm(homeyClient.__('settings.clear_activity_confirm'))) {
    return;
  }
  homeyClient.api('DELETE', '/timer-activity', null, (error, result) => {
    if (error) {
      homeyClient.alert(error);
      return;
    }
    updateActivity(result);
    hideDetails();
  });
}

function renderActivity() {
  const rows = getActivityRows();
  const body = byId('activity-body');
  const labels = {
    name: homeyClient.__('settings.device_name'),
    status: homeyClient.__('settings.status'),
    time: homeyClient.__('settings.remaining_or_changed'),
    invocations: homeyClient.__('settings.invocations_today'),
    action: homeyClient.__('settings.action'),
  };
  body.replaceChildren();

  for (const rowData of rows) {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    const statusCell = document.createElement('td');
    const timeCell = document.createElement('td');
    const invocationCell = document.createElement('td');
    const actionCell = document.createElement('td');
    const actions = document.createElement('div');

    nameCell.dataset.label = labels.name;
    nameCell.textContent = rowData.device.name;
    statusCell.dataset.label = labels.status;
    statusCell.textContent = formatStatus(rowData.event);
    statusCell.className = 'timer-status';
    timeCell.dataset.label = labels.time;
    if (rowData.timer) {
      timeCell.textContent = rowData.event === 'failed'
        ? homeyClient.__('settings.retrying')
        : homeyClient.__('settings.seconds_remaining', {
          seconds: remainingInSeconds(rowData.timer.offTime),
        });
    } else {
      timeCell.textContent = formatTimestamp(rowData.changedAt);
      timeCell.className = 'timer-meta';
    }
    invocationCell.dataset.label = labels.invocations;
    invocationCell.textContent = String(rowData.invocationsToday);
    actionCell.dataset.label = labels.action;
    actionCell.className = 'timer-actions-cell';
    actions.className = 'timer-actions';
    actions.append(createButton('settings.show_details', () => showDetails(rowData)));
    if (rowData.timer) {
      actions.append(createButton('settings.cancel_timer', () => cancelTimer(rowData.deviceId)));
    }
    actionCell.append(actions);
    row.append(nameCell, statusCell, timeCell, invocationCell, actionCell);
    body.append(row);
  }

  byId('activity-table').classList.toggle('is-hidden', rows.length === 0);
  byId('activity-empty').classList.toggle('is-hidden', rows.length > 0);
  byId('clear-activity').disabled = Object.keys(timerActivity).every(deviceId => timers[deviceId]);
}

function updateTimers(updatedTimers) {
  timers = updatedTimers && typeof updatedTimers === 'object' ? updatedTimers : {};
  renderActivity();
}

function updateActivity(updatedActivity) {
  timerActivity = updatedActivity && typeof updatedActivity === 'object' ? updatedActivity : {};
  renderActivity();
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

function loadActivity() {
  homeyClient.api('GET', '/timer-activity', null, (error, result) => {
    if (error) {
      homeyClient.alert(error);
      return;
    }
    updateActivity(result);
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
  timerActivity = {};
  homeyClient.ready();
  try {
    translatePage();
    byId('save-settings').addEventListener('click', saveSettings);
    byId('clear-activity').addEventListener('click', clearActivity);
    byId('close-details').addEventListener('click', hideDetails);
    byId('timer-details-overlay').addEventListener('click', (event) => {
      if (event.target === byId('timer-details-overlay')) {
        hideDetails();
      }
    });
    homeyClient.on('timer_started', event => updateTimers(event.timers));
    homeyClient.on('timer_deleted', event => updateTimers(event.timers));
    homeyClient.on('timer_activity', event => updateActivity(event.activity));
    loadSettings();
    loadTimers();
    loadActivity();
    refreshInterval = setInterval(renderActivity, 1000);
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideDetails();
      }
    });
    window.addEventListener('beforeunload', () => clearInterval(refreshInterval), { once: true });
  } catch (error) {
    homeyClient.alert(error instanceof Error ? error.message : String(error));
  }
}
