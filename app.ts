import inspector from "node:inspector";

import Homey from "homey";

import {
  CapabilityValue,
  getTimeoutActions,
  getNextTimeoutDelay,
  mergeRestoreState,
  shouldCancelTimer,
  shouldStartTimer,
  validateDurationSeconds,
} from "./lib/timer-utils";

const DEBUG = process.env.DEBUG === "1";
const TIMELINE_DEBUG_SETTING_KEY = "timeline_debug_enabled";
const TIMERS_SETTING_KEY = "timers";
const SAVE_DEBOUNCE_MS = 2000;
const EXPIRATION_RETRY_MS = 30_000;

interface DeviceReference {
  id: string;
  name: string;
  icon?: string;
}

interface ApiCapability {
  value: CapabilityValue;
  setable?: boolean;
}

interface CapabilityInstance {
  destroy(): void;
}

interface ApiDevice extends DeviceReference {
  capabilitiesObj?: Record<string, ApiCapability>;
  iconObj?: { url?: string } | null;
}

interface ApiEndpoint {
  get(path: string): Promise<unknown>;
  put(path: string, body: unknown): Promise<unknown>;
  on(event: "realtime", listener: (event: string, data?: unknown) => void): this;
  removeListener(event: "realtime", listener: (event: string, data?: unknown) => void): this;
  unregister(): void;
}

type RestoreState = Record<string, CapabilityValue>;

interface Timer {
  id: NodeJS.Timeout | null;
  generation: symbol;
  device: DeviceReference;
  timeOn: number;
  startTime: number;
  offTime: number;
  capability: string;
  value: CapabilityValue;
  restoreState: RestoreState;
  capabilityInstance: CapabilityInstance;
}

interface StoredTimer {
  deviceId: string;
  deviceName?: string;
  timeOn: number;
  startTime: number;
  offTime: number;
  capability: string;
  value: CapabilityValue;
  restoreState?: RestoreState;
  oldValue?: CapabilityValue;
}

interface ExportedTimer {
  device: DeviceReference;
  timeOn: number;
  startTime: number;
  offTime: number;
  capability: string;
  value: CapabilityValue;
  oldValue: CapabilityValue;
  restoreState: RestoreState;
}

class TimerApp extends Homey.App {
  private timers: Record<string, Timer> = {};

  private devicesApi: ApiEndpoint | null = null;

  private cloudUrl = "";

  private timerFinishedTrigger: Homey.FlowCardTrigger | null = null;

  private saveTimersTimeout: NodeJS.Timeout | null = null;

  private deviceOperations = new Map<string, Promise<unknown>>();

  async onInit(): Promise<void> {
    this.log(`${this.id} is running...(debug mode ${DEBUG ? "on" : "off"})`);
    if (DEBUG) {
      inspector.open(9229, "127.0.0.1");
    }

    await this.initCloudUrl();
    this.initFlowCards();
    await this.restoreTimers();

    this.log("Timer App is running...");
  }

  async onUninit(): Promise<void> {
    for (const timer of Object.values(this.timers)) {
      if (timer.id) {
        clearTimeout(timer.id);
      }
    }

    await Promise.allSettled(this.deviceOperations.values());
    for (const timer of Object.values(this.timers)) {
      if (timer.id) {
        clearTimeout(timer.id);
      }
      timer.capabilityInstance.destroy();
    }
    await this.flushSaveTimers();
    this.devicesApi?.unregister();
    this.log(`${this.id} has stopped.`);
  }

  private async initCloudUrl(): Promise<void> {
    try {
      const image = await this.homey.images.createImage();
      try {
        const cloudUrl = (image as unknown as { cloudUrl?: string }).cloudUrl;
        this.cloudUrl = cloudUrl?.includes("/api/") ? cloudUrl.split("/api/")[0] : "";
      } finally {
        await image.unregister();
      }
    } catch (error) {
      this.error(`Unable to load device icons for Flow autocomplete: ${this.formatError(error)}`);
    }
  }

  private initFlowCards(): void {
    const thenMoreOnOff = this.homey.flow.getActionCard("then_more_on_off");
    thenMoreOnOff.registerRunListener(async (args: Record<string, unknown>) => this.runScript(
      args.device as DeviceReference,
      { capability: "onoff", value: true },
      this.getDurationSeconds(args),
      String(args.ignore_when_on),
      String(args.overrule_longer_timeouts),
    ));
    this.registerDeviceAutocompleteListener(thenMoreOnOff, "onoff");

    const thenMoreOffOn = this.homey.flow.getActionCard("then_more_off_on");
    thenMoreOffOn.registerRunListener(async (args: Record<string, unknown>) => this.runScript(
      args.device as DeviceReference,
      { capability: "onoff", value: false },
      this.getDurationSeconds(args),
      String(args.ignore_when_off),
      String(args.overrule_longer_timeouts),
      "yes",
    ));
    this.registerDeviceAutocompleteListener(thenMoreOffOn, "onoff");

    const thenMoreDim = this.homey.flow.getActionCard("then_more_dim");
    thenMoreDim.registerRunListener(async (args: Record<string, unknown>) => this.runScript(
      args.device as DeviceReference,
      { capability: "dim", value: args.brightness_level as number },
      this.getDurationSeconds(args),
      String(args.ignore_when_on),
      String(args.overrule_longer_timeouts),
      String(args.restore),
    ));
    this.registerDeviceAutocompleteListener(thenMoreDim, "dim");

    const cancelTimer = this.homey.flow.getActionCard("cancel_timer");
    cancelTimer.registerRunListener(async (args: Record<string, unknown>) => (
      this.cancelTimer(args.device as DeviceReference)
    ));
    this.registerDeviceAutocompleteListener(cancelTimer, "timer");

    this.timerFinishedTrigger = this.homey.flow.getTriggerCard("timer_finished");
    this.timerFinishedTrigger.registerRunListener((args: Record<string, unknown>, state: Record<string, unknown>) => {
      const device = args.device as DeviceReference | undefined;
      return device?.id === state.deviceId;
    });
    this.registerDeviceAutocompleteListener(this.timerFinishedTrigger, "timer");

    const isTimerRunning = this.homey.flow.getConditionCard("is_timer_running");
    isTimerRunning.registerRunListener((args: Record<string, unknown>) => {
      const device = args.device as DeviceReference;
      return Boolean(device?.id && this.timers[device.id]);
    });
    this.registerDeviceAutocompleteListener(isTimerRunning, "timer");
  }

  private registerDeviceAutocompleteListener(
    flowCard: Homey.FlowCardAction | Homey.FlowCardCondition | Homey.FlowCardTrigger,
    capabilityType: "onoff" | "dim" | "timer",
  ): void {
    flowCard.registerArgumentAutocompleteListener("device", async (query: string) => {
      const devices = capabilityType === "onoff"
        ? await this.getDevicesWithCapabilities(["onoff"])
        : capabilityType === "dim"
          ? await this.getDevicesWithCapabilities(["dim"])
          : await this.getDevicesWithCapabilities(["onoff", "dim"]);

      return devices
        .map((device) => {
          const relativeIconUrl = device.iconObj?.url;
          return {
            id: device.id,
            name: device.name.trim(),
            icon: relativeIconUrl && this.cloudUrl ? `${this.cloudUrl}${relativeIconUrl}` : undefined,
          };
        })
        .filter((device) => device.name.length > 0)
        .filter((device) => device.name.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  async runScript(
    device: DeviceReference,
    action: { capability: string; value: CapabilityValue },
    timeOn: number,
    ignoreWhenOn: string,
    overruleLongerTimeouts: string,
    restore = "no",
  ): Promise<boolean> {
    if (!device?.id) {
      throw new Error(this.homey.__("errors.invalid_device"));
    }

    try {
      return await this.enqueueDeviceOperation(device.id, async () => this.runScriptLocked(
        device,
        action,
        timeOn,
        ignoreWhenOn,
        overruleLongerTimeouts,
        restore,
      ));
    } catch (error) {
      this.error(
        `Unable to start timer for ${device.name} [${device.id}] `
        + `(${action.capability}=${action.value}): ${this.formatError(error)}`,
      );
      throw error;
    }
  }

  private async runScriptLocked(
    device: DeviceReference,
    action: { capability: string; value: CapabilityValue },
    timeOnInput: number,
    ignoreWhenOn: string,
    overruleLongerTimeouts: string,
    restore: string,
  ): Promise<boolean> {
    let timeOn: number;
    try {
      timeOn = validateDurationSeconds(timeOnInput);
    } catch (error) {
      throw new Error(this.homey.__("errors.invalid_duration"), { cause: error });
    }

    if (action.value === null) {
      throw new Error(this.homey.__("errors.invalid_capability_value"));
    }

    const apiDevice = await this.getDevice(device.id);
    const deviceCapability = apiDevice.capabilitiesObj?.[action.capability];
    if (!deviceCapability?.setable) {
      throw new Error(this.homey.__("errors.unsupported_capability", {
        device: device.name,
        capability: action.capability,
      }));
    }

    const currentTimer = this.timers[device.id];
    const hasOnOff = Boolean(apiDevice.capabilitiesObj?.onoff);
    const isCurrentlyOff = hasOnOff
      ? apiDevice.capabilitiesObj?.onoff.value === false
      : action.capability === "dim"
        ? deviceCapability.value === 0
        : deviceCapability.value === false;
    const isAlreadyInTimedState = action.capability === "onoff"
      ? deviceCapability.value === action.value
      : !isCurrentlyOff;
    const requestedOffTime = Date.now() + timeOn * 1000;
    const sameTarget = Boolean(
      currentTimer
      && currentTimer.capability === action.capability
      && currentTimer.value === action.value,
    );

    const shouldStart = shouldStartTimer({
      hasTimer: Boolean(currentTimer),
      sameTarget,
      isAlreadyInTimedState,
      ignoreCurrentState: ignoreWhenOn === "no",
      overrideLongerTimer: overruleLongerTimeouts === "yes",
      currentOffTime: currentTimer?.offTime,
      requestedOffTime,
    });

    if (!shouldStart) {
      this.log(
        `Skipped timer for device ${device.name} [${device.id}] because the current timer `
        + `or device state takes precedence (${timeOn} seconds requested)`,
      );
      await this.createTimelineDebugNotification("timeline.skipped", {
        device: device.name,
        seconds: timeOn,
      });
      return true;
    }

    const restoreState = restore === "yes"
      ? this.captureRestoreState(apiDevice, action.capability, currentTimer?.restoreState)
      : {};
    const isReplacingTimer = Boolean(currentTimer);

    if (currentTimer) {
      const remainingTime = Math.max(0, Math.round((currentTimer.offTime - Date.now()) / 1000));
      this.log(
        `Cancelling previous timer for device ${device.name} [${device.id}], `
        + `remaining time: ${remainingTime} seconds out of ${currentTimer.timeOn} seconds`,
      );
      await this.cancelTimerLocked(currentTimer.device, { emitTimeline: false });
    }

    if (action.capability === "dim" && hasOnOff && apiDevice.capabilitiesObj?.onoff.value === false) {
      await this.setDeviceCapabilityState(device, "onoff", true, apiDevice);
    }
    if (deviceCapability.value !== action.value) {
      await this.setDeviceCapabilityState(device, action.capability, action.value, apiDevice);
    }

    const generation = Symbol(device.id);
    const capabilityInstance = this.createCapabilityListener(
      apiDevice,
      action.capability,
      action.value,
      generation,
    );
    const startTime = Date.now();
    const timer: Timer = {
      id: null,
      generation,
      device: { id: apiDevice.id, name: apiDevice.name, icon: device.icon },
      timeOn,
      startTime,
      offTime: startTime + timeOn * 1000,
      capability: action.capability,
      value: action.value,
      restoreState,
      capabilityInstance,
    };
    this.timers[device.id] = timer;
    this.armTimer(timer);
    this.scheduleSaveTimers();
    this.log(
      `${isReplacingTimer ? "Replaced" : "Set"} timer for device ${device.name} [${device.id}] `
      + `to ${timeOn} seconds (${action.capability}=${action.value})`,
    );

    this.homey.api.realtime("timer_started", {
      timers: this.exportTimers(),
      device: timer.device,
      capability: action.capability,
      value: action.value,
      oldValue: restoreState[action.capability] ?? null,
    });

    await this.createTimelineDebugNotification(
      isReplacingTimer ? "timeline.replaced" : "timeline.started",
      {
        device: device.name,
        seconds: timeOn,
        capability: action.capability,
        value: action.value,
      },
    );

    return true;
  }

  async cancelTimer(device: DeviceReference): Promise<boolean> {
    if (!device?.id) {
      throw new Error(this.homey.__("errors.invalid_device"));
    }

    return this.enqueueDeviceOperation(device.id, async () => this.cancelTimerLocked(device));
  }

  async cancelTimerById(deviceId: string): Promise<boolean> {
    const timer = this.timers[deviceId];
    return this.cancelTimer(timer?.device ?? { id: deviceId, name: deviceId });
  }

  private async cancelTimerLocked(
    device: DeviceReference,
    options: { emitTimeline?: boolean } = {},
  ): Promise<boolean> {
    const timer = this.timers[device.id];
    if (!timer) {
      this.log(`WARNING: No timer to cancel for device ${device.name} [${device.id}]`);
      return true;
    }

    if (timer.id) {
      clearTimeout(timer.id);
    }
    this.log(`Cancelled timer for device ${timer.device.name} [${timer.device.id}]`);
    this.cleanupTimer(timer);

    if (options.emitTimeline !== false) {
      await this.createTimelineDebugNotification("timeline.cancelled", {
        device: timer.device.name,
      });
    }

    return true;
  }

  private cleanupTimer(timer: Timer): void {
    timer.capabilityInstance.destroy();
    delete this.timers[timer.device.id];
    this.scheduleSaveTimers();
    this.homey.api.realtime("timer_deleted", {
      timers: this.exportTimers(),
      device: timer.device,
    });
  }

  private armTimer(timer: Timer, delay?: number): void {
    const timeoutDelay = delay ?? getNextTimeoutDelay(timer.offTime);
    const timeoutId = setTimeout(() => {
      void this.enqueueDeviceOperation(timer.device.id, async () => {
        await this.handleTimerDeadline(timer.device.id, timeoutId);
      }).catch((error) => {
        this.error(`Timer handler failed for ${timer.device.name}: ${this.formatError(error)}`);
      });
    }, timeoutDelay);
    timer.id = timeoutId;
  }

  private async handleTimerDeadline(deviceId: string, timeoutId: NodeJS.Timeout): Promise<void> {
    const timer = this.timers[deviceId];
    if (!timer || timer.id !== timeoutId) {
      return;
    }

    if (Date.now() < timer.offTime) {
      this.armTimer(timer);
      return;
    }

    try {
      const apiDevice = await this.getDevice(deviceId);
      await this.applyTimeoutState(timer, apiDevice);
      this.cleanupTimer(timer);
      await this.createTimelineDebugNotification("timeline.expired", {
        device: timer.device.name,
        capability: timer.capability,
        value: this.describeTimeoutValue(timer),
      });
      await this.triggerTimerFinished(timer.device);
    } catch (error) {
      this.error(`Unable to finish timer for ${timer.device.name}: ${this.formatError(error)}`);
      await this.createTimelineDebugNotification("timeline.failed", {
        device: timer.device.name,
        error: this.formatError(error),
      });
      this.armTimer(timer, EXPIRATION_RETRY_MS);
      this.scheduleSaveTimers();
    }
  }

  private async applyTimeoutState(timer: Timer, apiDevice: ApiDevice): Promise<void> {
    const actions = getTimeoutActions(
      timer.capability,
      timer.restoreState,
      new Set(Object.keys(apiDevice.capabilitiesObj ?? {})),
    );
    for (const action of actions) {
      await this.setDeviceCapabilityState(timer.device, action.capability, action.value, apiDevice);
    }
  }

  private captureRestoreState(
    apiDevice: ApiDevice,
    capability: string,
    originalRestoreState: RestoreState = {},
  ): RestoreState {
    const restoreState: RestoreState = {};
    const capabilityValue = apiDevice.capabilitiesObj?.[capability]?.value;
    if (capabilityValue !== undefined) {
      restoreState[capability] = capabilityValue;
    }

    if (capability === "dim" && apiDevice.capabilitiesObj?.onoff) {
      restoreState.onoff = apiDevice.capabilitiesObj.onoff.value;
    }

    return mergeRestoreState(restoreState, originalRestoreState);
  }

  private createCapabilityListener(
    device: ApiDevice,
    capability: string,
    targetValue: CapabilityValue,
    generation: symbol,
  ): CapabilityInstance {
    const deviceApi = this.homey.api.getApi(`homey:device:${device.id}`) as ApiEndpoint;
    let destroyed = false;
    const onRealtime = (event: string, data?: unknown): void => {
      if (event !== "capability" || !this.isCapabilityEvent(data) || data.capabilityId !== capability) {
        return;
      }

      const value = data.value;
      if (!shouldCancelTimer(targetValue, value)) {
        return;
      }

      this.log(
        `Listener: Device ${device.name} [${device.id}] changed ${capability} `
        + `from timed value ${targetValue} to ${value}, disabling timer`,
      );
      void this.cancelTimerGeneration(device, generation).catch((error) => {
        this.error(`Unable to cancel changed timer for ${device.name}: ${this.formatError(error)}`);
      });
    };
    deviceApi.on("realtime", onRealtime);

    return {
      destroy: () => {
        if (destroyed) {
          return;
        }
        destroyed = true;
        deviceApi.removeListener("realtime", onRealtime);
        deviceApi.unregister();
      },
    };
  }

  private async cancelTimerGeneration(device: DeviceReference, generation: symbol): Promise<boolean> {
    return this.enqueueDeviceOperation(device.id, async () => {
      if (this.timers[device.id]?.generation !== generation) {
        return true;
      }
      return this.cancelTimerLocked(device);
    });
  }

  private async restoreTimers(): Promise<void> {
    const rawStoredTimers: unknown = this.homey.settings.get(TIMERS_SETTING_KEY);
    const storedTimers = Array.isArray(rawStoredTimers) ? rawStoredTimers as StoredTimer[] : [];

    for (const storedTimer of storedTimers) {
      try {
        if (!this.isStoredTimerValid(storedTimer)) {
          this.error(`Skipping invalid stored timer: ${JSON.stringify(storedTimer)}`);
          continue;
        }

        const device = await this.getDevice(storedTimer.deviceId);
        if (!device.capabilitiesObj?.[storedTimer.capability]?.setable) {
          this.error(
            `Device ${device.name} [${device.id}] no longer supports settable capability `
            + `${storedTimer.capability}. Removing stored timer.`,
          );
          continue;
        }

        const restoreState = storedTimer.restoreState
          ?? (storedTimer.oldValue !== null && storedTimer.oldValue !== undefined
            ? { [storedTimer.capability]: storedTimer.oldValue }
            : {});
        if (device.capabilitiesObj[storedTimer.capability].value !== storedTimer.value) {
          this.log(
            `Device ${device.name} [${device.id}] no longer has the stored timer value for `
            + `${storedTimer.capability}. Removing stored timer.`,
          );
          continue;
        }

        const generation = Symbol(device.id);
        const isExpired = storedTimer.offTime <= Date.now();
        const timer: Timer = {
          id: null,
          generation,
          device: { id: device.id, name: device.name },
          timeOn: storedTimer.timeOn,
          startTime: storedTimer.startTime,
          offTime: storedTimer.offTime,
          capability: storedTimer.capability,
          value: storedTimer.value,
          restoreState,
          capabilityInstance: isExpired
            ? { destroy: () => undefined }
            : this.createCapabilityListener(
              device,
              storedTimer.capability,
              storedTimer.value,
              generation,
            ),
        };
        this.timers[device.id] = timer;

        if (isExpired) {
          try {
            await this.applyTimeoutState(timer, device);
            this.cleanupTimer(timer);
            await this.createTimelineDebugNotification("timeline.offline_expired", {
              device: device.name,
              capability: timer.capability,
            });
            await this.triggerTimerFinished(timer.device);
          } catch (error) {
            this.error(`Unable to finish restored timer for ${device.name}: ${this.formatError(error)}`);
            timer.capabilityInstance = this.createCapabilityListener(
              device,
              storedTimer.capability,
              storedTimer.value,
              generation,
            );
            this.armTimer(timer, EXPIRATION_RETRY_MS);
          }
          continue;
        }

        this.armTimer(timer);
        this.log(
          `Restored timer for device ${device.name} [${device.id}] with `
          + `${(timer.offTime - Date.now()) / 1000} seconds remaining.`,
        );
        await this.createTimelineDebugNotification("timeline.restored", {
          device: device.name,
          seconds: Math.round((timer.offTime - Date.now()) / 1000),
        });
      } catch (error) {
        this.error(`Error restoring timer for device ${storedTimer?.deviceId}: ${this.formatError(error)}`);
      }
    }

    await this.flushSaveTimers();
  }

  private isStoredTimerValid(timer: StoredTimer): boolean {
    return Boolean(
      timer
      && typeof timer.deviceId === "string"
      && typeof timer.capability === "string"
      && typeof timer.timeOn === "number"
      && Number.isFinite(timer.timeOn)
      && timer.timeOn > 0
      && typeof timer.startTime === "number"
      && Number.isFinite(timer.startTime)
      && typeof timer.offTime === "number"
      && Number.isFinite(timer.offTime)
      && this.isCapabilityValue(timer.value)
      && (timer.restoreState === undefined || (
        timer.restoreState !== null
        && typeof timer.restoreState === "object"
        && Object.values(timer.restoreState).every((value) => this.isCapabilityValue(value))
      )),
    );
  }

  private async setDeviceCapabilityState(
    device: DeviceReference,
    capabilityId: string,
    value: Exclude<CapabilityValue, null>,
    existingDevice?: ApiDevice,
  ): Promise<void> {
    const apiDevice = existingDevice ?? await this.getDevice(device.id);
    if (!apiDevice.capabilitiesObj?.[capabilityId]?.setable) {
      throw new Error(this.homey.__("errors.unsupported_capability", {
        device: device.name,
        capability: capabilityId,
      }));
    }

    this.log(`Set device ${device.name} [${device.id}] capability ${capabilityId} to ${value}`);
    try {
      const devicesApi = this.getDevicesApi();
      await devicesApi.put(
        `/device/${encodeURIComponent(device.id)}/capability/${encodeURIComponent(capabilityId)}`,
        {
          value,
        },
      );
      apiDevice.capabilitiesObj[capabilityId].value = value;
    } catch (error) {
      throw new Error(this.homey.__("errors.capability_update_failed", {
        device: device.name,
        capability: capabilityId,
        error: this.formatError(error),
      }), { cause: error });
    }
  }

  private getDevicesApi(): ApiEndpoint {
    if (!this.devicesApi) {
      this.devicesApi = this.homey.api.getApi("homey:manager:devices") as ApiEndpoint;
    }
    return this.devicesApi;
  }

  private async getDevice(deviceId: string): Promise<ApiDevice> {
    try {
      const result = await this.getDevicesApi().get(`/device/${encodeURIComponent(deviceId)}`);
      if (!this.isApiDevice(result)) {
        throw new Error("Homey returned an invalid device response.");
      }
      return result;
    } catch (error) {
      throw new Error(this.homey.__("errors.device_load_failed", {
        device: deviceId,
        error: this.formatError(error),
      }), { cause: error });
    }
  }

  private async getDevicesWithCapabilities(capabilities: string[]): Promise<ApiDevice[]> {
    const result = await this.getDevicesApi().get("/device");
    const devices = (Array.isArray(result) ? result : Object.values(result as Record<string, unknown>))
      .filter((device): device is ApiDevice => this.isApiDevice(device));
    return devices.filter((device) => capabilities.some((capabilityId) => (
      device.capabilitiesObj?.[capabilityId]?.setable === true
    )));
  }

  exportTimers(): Record<string, ExportedTimer> {
    return Object.fromEntries(Object.values(this.timers).map((timer) => [
      timer.device.id,
      {
        device: timer.device,
        timeOn: timer.timeOn,
        startTime: timer.startTime,
        offTime: timer.offTime,
        capability: timer.capability,
        value: timer.value,
        oldValue: timer.restoreState[timer.capability] ?? null,
        restoreState: timer.restoreState,
      },
    ]));
  }

  private scheduleSaveTimers(): void {
    if (this.saveTimersTimeout) {
      clearTimeout(this.saveTimersTimeout);
    }

    this.saveTimersTimeout = setTimeout(() => {
      this.saveTimersTimeout = null;
      void this.saveTimers().catch((error) => {
        this.error(`Unable to persist timers: ${this.formatError(error)}`);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  private async flushSaveTimers(): Promise<void> {
    if (this.saveTimersTimeout) {
      clearTimeout(this.saveTimersTimeout);
      this.saveTimersTimeout = null;
    }
    await this.saveTimers();
  }

  private async saveTimers(): Promise<void> {
    const storedTimers: StoredTimer[] = Object.values(this.timers).map((timer) => ({
      deviceId: timer.device.id,
      deviceName: timer.device.name,
      timeOn: timer.timeOn,
      startTime: timer.startTime,
      offTime: timer.offTime,
      capability: timer.capability,
      value: timer.value,
      restoreState: timer.restoreState,
    }));
    await this.homey.settings.set(TIMERS_SETTING_KEY, storedTimers);
  }

  private getDurationSeconds(args: Record<string, unknown>): number {
    const duration = typeof args.duration === "number"
      ? args.duration / 1000
      : args.time_on ?? args.time_off;
    return typeof duration === "number" ? duration : Number.NaN;
  }

  private describeTimeoutValue(timer: Timer): string {
    const entries = Object.entries(timer.restoreState);
    if (entries.length === 0) {
      return timer.capability === "dim" ? "dim=0, onoff=false" : `${timer.capability}=false`;
    }
    return entries.map(([capability, value]) => `${capability}=${value}`).join(", ");
  }

  private async triggerTimerFinished(device: DeviceReference): Promise<void> {
    if (!this.timerFinishedTrigger) {
      return;
    }

    try {
      await this.timerFinishedTrigger.trigger({}, { deviceId: device.id });
    } catch (error) {
      this.error(`Failed to trigger timer_finished for ${device.name} [${device.id}]: ${this.formatError(error)}`);
    }
  }

  private isTimelineDebugEnabled(): boolean {
    return this.homey.settings.get(TIMELINE_DEBUG_SETTING_KEY) === true;
  }

  private async createTimelineDebugNotification(
    key: string,
    tags: Record<string, string | number | boolean>,
  ): Promise<void> {
    if (!this.isTimelineDebugEnabled()) {
      return;
    }

    try {
      await this.homey.notifications.createNotification({
        excerpt: this.homey.__(
          key,
          Object.fromEntries(Object.entries(tags).map(([tagKey, tagValue]) => [
            tagKey,
            this.formatTimelineTagValue(tagValue),
          ])),
        ),
      });
    } catch (error) {
      this.error(`Failed to create timeline debug notification for ${key}: ${this.formatError(error)}`);
    }
  }

  private formatTimelineTagValue(value: string | number | boolean): string {
    if (typeof value === "number") {
      return Number.isInteger(value) ? String(value) : value.toFixed(2);
    }
    return String(value);
  }

  private async enqueueDeviceOperation<T>(deviceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.deviceOperations.get(deviceId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.deviceOperations.set(deviceId, current);

    try {
      return await current;
    } finally {
      if (this.deviceOperations.get(deviceId) === current) {
        this.deviceOperations.delete(deviceId);
      }
    }
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isApiDevice(value: unknown): value is ApiDevice {
    return Boolean(
      value
      && typeof value === "object"
      && "id" in value
      && typeof value.id === "string"
      && "name" in value
      && typeof value.name === "string",
    );
  }

  private isCapabilityEvent(value: unknown): value is {
    capabilityId: string;
    value: CapabilityValue;
  } {
    return Boolean(
      value
      && typeof value === "object"
      && "capabilityId" in value
      && typeof value.capabilityId === "string"
      && "value" in value
      && this.isCapabilityValue(value.value),
    );
  }

  private isCapabilityValue(value: unknown): value is CapabilityValue {
    return value === null
      || typeof value === "boolean"
      || typeof value === "number"
      || typeof value === "string";
  }
}

export = TimerApp;
