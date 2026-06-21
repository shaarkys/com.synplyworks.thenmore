import { HomeyAPI as AthomHomeyAPI } from "athom-api";

import Homey = require("homey");
const { HomeyAPI } = require("homey-api");

import Device = AthomHomeyAPI.ManagerDevices.Device;

const DEBUG = process.env.DEBUG === "1";
const TIMELINE_DEBUG_SETTING_KEY = "timeline_debug_enabled";

interface Timer {
  id: NodeJS.Timeout;
  device: Device;
  timeOn: number; // Original duration of the timer in seconds
  startTime: number; // Timestamp when the timer started
  offTime: number; // Timestamp when the timer is supposed to end
  capability: string;
  value: any;
  oldValue: any;
  onOffCapabilityInstance: any;
}

interface StoredTimer {
  deviceId: string;
  timeOn: number;
  startTime: number;
  offTime: number;
  capability: string;
  value: any;
  oldValue: any;
}

export default class TimerApp extends Homey.App {
  private timers: { [deviceId: string]: Timer } = {};
  private api: any | null = null;
  private cloudUrl: string = "";

  // Keep track of devices currently setting a timer
  private settingTimer: { [deviceId: string]: boolean } = {};

  // Debouncing saveTimers
  private saveTimersTimeout: NodeJS.Timeout | null = null;

  async onInit() {
    this.log(`${this.id} is running...(debug mode ${DEBUG ? "on" : "off"})`);
    if (DEBUG) {
      require("inspector").open(9229, "0.0.0.0");
    }

    // Retrieve the cloudUrl
    const image = await this.homey.images.createImage();
    // @ts-ignore
    this.cloudUrl = image.cloudUrl.split("/api/")[0];
    await image.unregister();

    this.log("Timer App is initializing...");

    // Initialize flow cards
    this.initFlowCards();

    // Restore timers from persistent storage
    await this.restoreTimers();

    this.log("Timer App is running...");
  }

  /**
   * Ensures that any pending saveTimers operations are executed before the app shuts down.
   */
  async onUninit() {
    if (this.saveTimersTimeout) {
      clearTimeout(this.saveTimersTimeout);
      await this.saveTimers();
    }
    this.log(`${this.id} has stopped.`);
  }

  /**
   * Initializes all flow cards and registers their respective listeners.
   */
  initFlowCards() {
    // Action Card: then_more_on_off
    const thenMoreOnOff = this.homey.flow.getActionCard("then_more_on_off");
    thenMoreOnOff
      .registerRunListener(async (args: any) => {
        const timeOnSeconds = this.getTimeOnSeconds(args);
        return this.runScript(
          args.device,
          { capability: "onoff", value: true },
          timeOnSeconds,
          args.ignore_when_on,
          args.overrule_longer_timeouts
        );
      });
    this.registerDeviceAutocompleteListener(thenMoreOnOff, 'onoff');

    // Action Card: then_more_off_on
    const thenMoreOffOn = this.homey.flow.getActionCard("then_more_off_on");
    thenMoreOffOn
      .registerRunListener(async (args: any) => {
        const timeOffSeconds = this.getTimeOnSeconds(args);
        return this.runScript(
          args.device,
          { capability: "onoff", value: false },
          timeOffSeconds,
          args.ignore_when_off,
          args.overrule_longer_timeouts,
          "yes"
        );
      });
    this.registerDeviceAutocompleteListener(thenMoreOffOn, 'onoff');

    // Action Card: then_more_dim
    const thenMoreDim = this.homey.flow.getActionCard("then_more_dim");
    thenMoreDim
      .registerRunListener(async (args: any) => {
        const timeOnSeconds = this.getTimeOnSeconds(args);
        return this.runScript(
          args.device,
          { capability: "dim", value: args.brightness_level },
          timeOnSeconds,
          args.ignore_when_on,
          args.overrule_longer_timeouts,
          args.restore
        );
      });
    this.registerDeviceAutocompleteListener(thenMoreDim, 'dim');

    // Action Card: cancel_timer
    const cancelTimer = this.homey.flow.getActionCard("cancel_timer");
    cancelTimer
      .registerRunListener((args: any) => {
        return this.cancelTimer(args.device);
      });
    this.registerDeviceAutocompleteListener(cancelTimer, 'onoff');

    // Condition Card: is_timer_running
    const isTimerRunning = this.homey.flow.getConditionCard("is_timer_running");
    isTimerRunning
      .registerRunListener(async (args: any) => {
        return args.device.id in this.timers;
      });
    this.registerDeviceAutocompleteListener(isTimerRunning, 'onoff');
  }

  private isTimelineDebugEnabled(): boolean {
    return this.homey.settings.get(TIMELINE_DEBUG_SETTING_KEY) === true;
  }

  private formatTimelineTagValue(value: any): string {
    if (typeof value === "number") {
      return Number.isInteger(value) ? String(value) : value.toFixed(2);
    }

    if (typeof value === "boolean") {
      return value ? "true" : "false";
    }

    if (value === null || value === undefined) {
      return "null";
    }

    return String(value);
  }

  private async createTimelineDebugNotification(
    key: string,
    tags: Record<string, string | number | boolean>
  ): Promise<void> {
    if (!this.isTimelineDebugEnabled()) {
      return;
    }

    try {
      await this.homey.notifications.createNotification({
        excerpt: this.homey.__(
          key,
          Object.fromEntries(
            Object.entries(tags).map(([tagKey, tagValue]) => [tagKey, this.formatTimelineTagValue(tagValue)])
          )
        ),
      });
    } catch (error) {
      this.log(`Failed to create timeline debug notification for ${key}: ${error}`);
    }
  }

  /**
   * Registers an autocomplete listener for a given flow card based on the capability type.
   *
   * @param actionCard - The flow card (action or condition) to register the listener on.
   * @param capabilityType - The type of capability ('onoff' or 'dim') to filter devices.
   */
  private registerDeviceAutocompleteListener(
    actionCard: Homey.FlowCardAction | Homey.FlowCardCondition,
    capabilityType: 'onoff' | 'dim'
  ) {
    actionCard
      .getArgument("device")
      .registerAutocompleteListener(async (query: string, args: any) => {
        const devices = capabilityType === 'onoff' ? await this.getOnOffDevices() : await this.getDimDevices();
        const devicesWithIcons = await Promise.all(
          devices.map(async (device) => {
            const api = await this.getApi();
            const fullDevice = await api.devices.getDevice({ id: device.id });

            const iconUrl = fullDevice.iconObj?.url && this.cloudUrl ? `${this.cloudUrl}${fullDevice.iconObj.url}` : null;

            return {
              id: fullDevice.id,
              name: fullDevice.name.trim(),
              // Ensure 'icon' is 'string | undefined' by replacing 'null' with 'undefined'
              icon: iconUrl || undefined
            };
          })
        );
        const filteredDevices = devicesWithIcons
          .filter((device) => device.name.length > 0)
          .filter((device) => device.name.toLowerCase().includes(query.toLowerCase()))
          .sort((a, b) => a.name.localeCompare(b.name));

        return filteredDevices;
      });
  }

  /**
   * Restores timers from persistent storage and re-establishes them.
   */
  private async restoreTimers() {
    const storedTimers: StoredTimer[] = await this.homey.settings.get('timers') || [];
    const now = Date.now();

    for (const storedTimer of storedTimers) {
      let device: Device | null = null;
      try {
        const api = await this.getApi();
        device = await api.devices.getDevice({ id: storedTimer.deviceId });
      } catch (error) {
        this.log(`Error restoring timer for device ${storedTimer.deviceId}: ${error}`);
        continue;
      }
      if (!device) {
        this.log(`Device with ID ${storedTimer.deviceId} not found. Skipping timer restoration.`);
        continue;
      }

      const remainingTime = storedTimer.offTime - now;

      if (remainingTime <= 0) {
        // Timer has already expired while Homey was offline. Execute the timeout action immediately.
        this.log(`Restored timer for device ${device.name} [${device.id}] has already expired. Executing timeout action.`);
        await this.createTimelineDebugNotification("timeline.offline_expired", {
          device: device.name,
          capability: storedTimer.capability,
        });
        await this.executeTimeoutAction(device, storedTimer);
        continue;
      }

      // Re-establish the timer with the remaining time
      const timeoutId = setTimeout(() => {
        (async () => {
          this.log(`Timeout for ${device.name} [${device.id}]`);

          const currentTimer = this.timers[device.id];
          if (currentTimer && currentTimer.id === timeoutId) {
            this.cleanupTimer(device);
            let timeoutValue: any;

            if (currentTimer.oldValue !== null && currentTimer.oldValue !== undefined) {
              timeoutValue = currentTimer.oldValue;
              await this.setDeviceCapabilityState(device, currentTimer.capability, timeoutValue);
            } else {
              if (currentTimer.capability === "onoff") {
                timeoutValue = false;
                await this.setDeviceCapabilityState(device, "onoff", timeoutValue);
              } else if (currentTimer.capability === "dim") {
                timeoutValue = 0;
                await this.setDeviceCapabilityState(device, "dim", timeoutValue);
              } else {
                timeoutValue = false;
                await this.setDeviceCapabilityState(device, currentTimer.capability, timeoutValue);
              }
            }

            await this.createTimelineDebugNotification("timeline.expired", {
              device: device.name,
              capability: currentTimer.capability,
              value: timeoutValue,
            });
          } else {
            this.log(`Timer expired for ${device.name} [${device.id}], but it was already canceled or replaced with a new timer.`);
          }
        })().catch((error) => {
          this.log(`Error in timeout function for ${device.name} [${device.id}]: ${error}`);
        });
      }, remainingTime);

      // Re-establish the capability listener
      if (!device.capabilitiesObj || !(storedTimer.capability in device.capabilitiesObj)) {
        this.log(`Device ${device.name} [${device.id}] no longer supports capability ${storedTimer.capability}. Skipping timer restoration.`);
        continue;
      }

      const capabilityInstance = this.createCapabilityListener(device, storedTimer.capability, storedTimer.value);

      // Re-create the timer object with the capabilityInstance
      this.timers[device.id] = {
        id: timeoutId,
        device: device,
        timeOn: storedTimer.timeOn,
        startTime: storedTimer.startTime,
        offTime: storedTimer.offTime,
        capability: storedTimer.capability,
        value: storedTimer.value,
        oldValue: storedTimer.oldValue,
        onOffCapabilityInstance: capabilityInstance
      };

      this.log(`Restored timer for device ${device.name} [${device.id}] with ${remainingTime / 1000} seconds remaining.`);
      await this.createTimelineDebugNotification("timeline.restored", {
        device: device.name,
        seconds: Math.round(remainingTime / 1000),
      });
    }

    // Remove any expired timers from storage
    const validTimers = storedTimers.filter(timer => timer.offTime > now);
    await this.homey.settings.set('timers', validTimers);
  }

  /**
   * Executes the timeout action immediately for expired timers during restoration.
   *
   * @param device - The device associated with the expired timer.
   * @param storedTimer - The stored timer data.
   */
  private async executeTimeoutAction(device: Device, storedTimer: StoredTimer) {
    const timeoutValue = this.getTimeoutValue(storedTimer.capability, storedTimer.oldValue);
    await this.setDeviceCapabilityState(device, storedTimer.capability, timeoutValue);

    // Cleanup the timer, which destroys the capability listener and removes the timer reference
    if (this.timers[device.id]) {
      this.cleanupTimer(device);
    }
  }

  /**
   * Executes the script to set a timer on a device.
   *
   * @param device - The device to set the timer on.
   * @param action - The action to perform (capability and value).
   * @param timeOn - Duration of the timer in seconds.
   * @param ignoreWhenOn - Flag to ignore if the device is already on.
   * @param overruleLongerTimeouts - Flag to overrule longer existing timeouts.
   * @param restore - Flag to restore previous state after timer ends.
   * @returns A promise that resolves to true upon successful execution.
   */
  async runScript(
    device: Device,
    action: { capability: string; value: any },
    timeOn: number,
    ignoreWhenOn: string,
    overruleLongerTimeouts: string,
    restore: string = "no"
  ): Promise<boolean> {
    // Check if a timer is already being set for this device
    if (this.settingTimer[device.id]) {
      this.log(`WARNING: Timer is already being set for device ${device.name} [${device.id}]. Ignoring additional request.`);
      return true; // Exit early to prevent multiple timers
    }

    // Set the lock
    this.settingTimer[device.id] = true;

    try {
      const api = await this.getApi();
      const apiDevice = await api.devices.getDevice({ id: device.id });
      const deviceCapability = apiDevice.capabilitiesObj ? apiDevice.capabilitiesObj[action.capability] : null;
      if (!deviceCapability) {
        this.log(`Device ${device.name} [${device.id}] does not support capability ${action.capability}.`);
        return true;
      }
      const timer = this.timers[device.id];

      let oldValue: any = null;
      let capabilityInstance = null;
      const isDimCapability = action.capability === "dim";
      const hasOnOff = apiDevice.capabilitiesObj && apiDevice.capabilitiesObj.onoff;
      const isCurrentlyOff = hasOnOff
        ? apiDevice.capabilitiesObj.onoff.value === false
        : (isDimCapability ? deviceCapability.value === 0 : deviceCapability.value === false);
      const isAlreadyInTimedState =
        action.capability === "onoff"
          ? deviceCapability.value === action.value
          : !isCurrentlyOff;

      if (
        !isAlreadyInTimedState ||
        ignoreWhenOn === "no" ||
        (timer && (overruleLongerTimeouts === "yes" || Date.now() + timeOn * 1000 > timer.offTime))
      ) {
        const isReplacingTimer = !!timer;

        if (timer) {
          oldValue = restore === "yes" ? timer.oldValue : null;

          const remainingTime = Math.max(0, Math.round((timer.offTime - Date.now()) / 1000));
          const previousTimeOn = timer.timeOn;
          this.log(
            `Cancelling previous timer for device ${device.name} [${device.id}], ` +
              `remaining time: ${remainingTime} seconds out of ${previousTimeOn} seconds`
          );

          await this.cancelTimer(device, { emitTimeline: false });

          if (action.capability === "dim" && hasOnOff && apiDevice.capabilitiesObj.onoff.value === false) {
            await this.setDeviceCapabilityState(device, "onoff", true, apiDevice);
          }
          if (deviceCapability.value !== action.value) {
            await this.setDeviceCapabilityState(device, action.capability, action.value, apiDevice);
          }

          capabilityInstance = this.createCapabilityListener(apiDevice, action.capability, action.value);
        } else {
          if (restore === "yes") {
            oldValue = deviceCapability.value;
            this.log(`Remembered state for ${device.name} [${device.id}] oldValue: ${oldValue}`);
          }

          if (action.capability === "dim" && hasOnOff && apiDevice.capabilitiesObj.onoff.value === false) {
            await this.setDeviceCapabilityState(device, "onoff", true, apiDevice);
          }
          await this.setDeviceCapabilityState(device, action.capability, action.value, apiDevice);

          capabilityInstance = this.createCapabilityListener(apiDevice, action.capability, action.value);
        }

        let logMessage = `Set timer for device ${device.name} [${device.id}] to ${timeOn} seconds`;
        if (oldValue !== null && oldValue !== undefined) {
          logMessage += `, oldValue: ${oldValue}`;
        }
        this.log(logMessage);

        const timeoutId = setTimeout(() => {
          (async () => {
            this.log(`Timeout for ${device.name} [${device.id}]`);

            const currentTimer = this.timers[device.id];
            if (currentTimer && currentTimer.id === timeoutId) {
              this.cleanupTimer(device);
              const timeoutValue = this.getTimeoutValue(currentTimer.capability, currentTimer.oldValue);
              await this.setDeviceCapabilityState(device, currentTimer.capability, timeoutValue);

              await this.createTimelineDebugNotification("timeline.expired", {
                device: device.name,
                capability: currentTimer.capability,
                value: timeoutValue,
              });
            } else {
              this.log(`Timer expired for ${device.name} [${device.id}], but it was already canceled or replaced with a new timer.`);
            }
          })().catch((error) => {
            this.log(`Error in timeout function for ${device.name} [${device.id}]: ${error}`);
          });
        }, timeOn * 1000);

        // Store the timer with additional information
        this.timers[device.id] = {
          id: timeoutId,
          device: device,
          timeOn: timeOn,
          startTime: Date.now(),
          offTime: Date.now() + timeOn * 1000,
          capability: action.capability,
          value: action.value,
          oldValue: oldValue,
          onOffCapabilityInstance: capabilityInstance
        };

        await this.scheduleSaveTimers();

        this.homey.api.realtime("timer_started", {
          timers: this.exportTimers(),
          device: device,
          capability: action.capability,
          value: action.value,
          oldValue: oldValue
        });

        await this.createTimelineDebugNotification(
          isReplacingTimer ? "timeline.replaced" : "timeline.started",
          {
            device: device.name,
            seconds: timeOn,
            capability: action.capability,
            value: action.value,
          }
        );
      } else {
        await this.createTimelineDebugNotification("timeline.skipped", {
          device: device.name,
          seconds: timeOn,
        });
      }

      return true;
    } finally {
      // Release the lock
      this.settingTimer[device.id] = false;
    }
  }

  /**
   * Cancels an existing timer for a given device.
   *
   * @param device - The device whose timer is to be canceled.
   * @returns A promise that resolves to true upon successful cancellation.
   */
  async cancelTimer(device: Device, options: { emitTimeline?: boolean } = {}) {
    const timer = this.timers[device.id];
    const emitTimeline = options.emitTimeline !== false;
    // if timer is running cancel timer and remove reference
    if (timer) {
      clearTimeout(timer.id);
      this.log(`Cancelled timer for device ${device.name} [${device.id}]`);
      this.cleanupTimer(device);
      if (emitTimeline) {
        await this.createTimelineDebugNotification("timeline.cancelled", {
          device: device.name,
        });
      }
    } else {
      this.log(`WARNING: No timer to Cancel for device ${device.name} [${device.id}]`);
    }

    // **Replace direct saveTimers call with scheduleSaveTimers for debounced saving**
    await this.scheduleSaveTimers();

    return Promise.resolve(true);
  }

  /**
   * Cleans up the timer by removing listeners and references.
   *
   * @param device - The device whose timer is to be cleaned up.
   */
  cleanupTimer(device: Device): void {
    const timer = this.timers[device.id];
    if (timer) {
      // Clean up listener for off-state
      if (timer.onOffCapabilityInstance && typeof timer.onOffCapabilityInstance.destroy === 'function') {
        timer.onOffCapabilityInstance.destroy();
      }
      // Remove reference of timer for this device
      delete this.timers[device.id];
      // Emit event to signal settings page the timer can be removed
      this.homey.api.realtime("timer_deleted", {
        timers: this.exportTimers(),
        device: device
      });
    } else {
      this.log(`WARNING: No timer to cleanup for device ${device.name} [${device.id}]`);
    }

    // **Replace direct saveTimers call with scheduleSaveTimers for debounced saving**
    this.scheduleSaveTimers();
  }

  /**
   * Sets a device's capability to a specified value.
   *
   * @param device - The device to be updated.
   * @param capabilityId - The capability to be set.
   * @param value - The value to set the capability to.
   */
  async setDeviceCapabilityState(device: Device, capabilityId: string, value: any, apiDevice?: any) {
    this.log(`Set device ${device.name} [${device.id}] capability ${capabilityId} to ${value}`);
    try {
      const api = await this.getApi();
      if (!apiDevice) {
        try {
          apiDevice = await api.devices.getDevice({ id: device.id });
        } catch (error) {
          this.log(`Error loading device ${device.name} [${device.id}] for capability ${capabilityId}: ${error}`);
          return;
        }
      }
      if (!apiDevice.capabilitiesObj || !(capabilityId in apiDevice.capabilitiesObj)) {
        this.log(`Device ${device.name} [${device.id}] does not support capability ${capabilityId}.`);
        return;
      }
      await api.devices.setCapabilityValue({
        deviceId: device.id,
        capabilityId: capabilityId,
        value: value
      });
      // Update cache of apiDevice.capabilitiesObj
      if (apiDevice.capabilitiesObj && apiDevice.capabilitiesObj[capabilityId]) {
        apiDevice.capabilitiesObj[capabilityId].value = value;
      }

      // **Replace direct saveTimers call with scheduleSaveTimers for debounced saving**
      await this.scheduleSaveTimers();
    } catch (error) {
      this.log(`Error setting capability value: ${error}`);
    }
  }

  /**
   * Retrieves the Homey API instance. Initializes it if not already done.
   *
   * @returns The Homey API instance.
   */
  async getApi() {
    if (!this.api) {
      this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
    }
    return this.api;
  }

  /**
   * Exports the current timers without the timeout IDs.
   *
   * @returns An object representing the current timers.
   */
  exportTimers() {
    let data: any = {};
    // Clone timers, and remove the timeout-id
    for (let key in this.timers) {
      data[key] = Object.assign({}, this.timers[key]);
      delete data[key].id; // Remove timeout id which cannot be exported
    }
    return data;
  }

  /**
   * Schedules the current timers to be saved to persistent storage with debouncing.
   */
  private scheduleSaveTimers() {
    if (this.saveTimersTimeout) {
      clearTimeout(this.saveTimersTimeout);
    }
    this.saveTimersTimeout = setTimeout(() => {
      this.saveTimers();
      this.saveTimersTimeout = null;
    }, 2000); // 2-second debounce period
  }

  /**
   * Saves the current timers to persistent storage.
   */
  private async saveTimers() {
    const storedTimers: StoredTimer[] = Object.values(this.timers).map(timer => ({
      deviceId: timer.device.id,
      timeOn: timer.timeOn,
      startTime: timer.startTime,
      offTime: timer.offTime,
      capability: timer.capability,
      value: timer.value,
      oldValue: timer.oldValue
    }));
    await this.homey.settings.set('timers', storedTimers);
    this.log("Timers have been saved to persistent storage.");
  }

  /**
   * Returns duration in seconds.
   */
  private getTimeOnSeconds(args: any): number {
    if (args && typeof args.duration === "number") {
      return args.duration / 1000;
    }
    if (args && typeof args.time_on === "number") {
      return args.time_on;
    }
    if (args && typeof args.time_off === "number") {
      return args.time_off;
    }
    const fallback = Number(args?.duration ?? args?.time_on ?? args?.time_off);
    return Number.isFinite(fallback) ? fallback : 0;
  }

  private createCapabilityListener(device: any, capability: string, targetValue: any) {
    return device.makeCapabilityInstance(capability, (value: any) => {
      if (this.shouldCancelTimer(capability, targetValue, value)) {
        this.log(
          `Listener: Device ${device.name} [${device.id}] changed ${capability} from timed value ${targetValue} to ${value}, disabling timer`
        );
        void this.cancelTimer(device);
      }
    });
  }

  private shouldCancelTimer(capability: string, targetValue: any, value: any): boolean {
    if (capability === "dim") {
      return !value || value === 0;
    }

    if (capability === "onoff") {
      return value !== targetValue;
    }

    return value !== targetValue;
  }

  private getTimeoutValue(capability: string, oldValue: any): any {
    if (oldValue !== null && oldValue !== undefined) {
      return oldValue;
    }

    if (capability === "dim") {
      return 0;
    }

    return false;
  }

  /**
   * Retrieves all devices from Homey.
   *
   * @returns A promise that resolves to an array of all devices.
   */
  async getAllDevices(): Promise<Device[]> {
    const api = await this.getApi();
    const devices: { [id: string]: Device } = await api.devices.getDevices();
    return Object.values(devices);
  }

  /**
   * Loads all devices from Homey and filters those without the on/off capability.
   *
   * @returns A promise that resolves to an array of devices with the on/off capability.
   */
  async getOnOffDevices(): Promise<Device[]> {
    const allDevices = await this.getAllDevices();

    return allDevices.filter((device) => {
      return (
        device.capabilitiesObj &&
        "onoff" in device.capabilitiesObj &&
        // @ts-ignore
        device.capabilitiesObj.onoff.setable
      );
    });
  }

  /**
   * Loads all devices from Homey and filters those without the dim capability.
   *
   * @returns A promise that resolves to an array of devices with the dim capability.
   */
  async getDimDevices(): Promise<Device[]> {
    const allDevices = await this.getAllDevices();

    return allDevices.filter((device) => {
      return (
        device.capabilitiesObj &&
        "dim" in device.capabilitiesObj &&
        // @ts-ignore
        device.capabilitiesObj.dim.setable
      );
    });
  }
}

module.exports = TimerApp;
