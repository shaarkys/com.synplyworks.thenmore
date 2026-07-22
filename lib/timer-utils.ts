export type CapabilityValue = boolean | number | string | null;

export const MAX_NATIVE_TIMEOUT_MS = 2_147_483_647;

export interface TimerDecisionInput {
  hasTimer: boolean;
  sameTarget: boolean;
  isAlreadyInTimedState: boolean;
  ignoreCurrentState: boolean;
  overrideLongerTimer: boolean;
  currentOffTime?: number;
  requestedOffTime: number;
}

export interface CapabilityAction {
  capability: string;
  value: Exclude<CapabilityValue, null>;
}

export function validateDurationSeconds(value: unknown, now = Date.now()): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("Timer duration must be a positive, finite number.");
  }

  const offTime = now + value * 1000;
  if (!Number.isSafeInteger(Math.trunc(offTime))) {
    throw new Error("Timer duration is too large.");
  }

  return value;
}

export function getNextTimeoutDelay(offTime: number, now = Date.now()): number {
  const remaining = offTime - now;
  return Math.min(Math.max(remaining, 1), MAX_NATIVE_TIMEOUT_MS);
}

export function shouldStartTimer(input: TimerDecisionInput): boolean {
  if (!input.hasTimer) {
    return !input.isAlreadyInTimedState || input.ignoreCurrentState;
  }

  if (!input.sameTarget) {
    return true;
  }

  return input.overrideLongerTimer
    || input.currentOffTime === undefined
    || input.requestedOffTime > input.currentOffTime;
}

export function shouldCancelTimer(targetValue: CapabilityValue, value: CapabilityValue): boolean {
  return value !== targetValue;
}

export function mergeRestoreState(
  currentState: Record<string, CapabilityValue>,
  originalState: Record<string, CapabilityValue>,
): Record<string, CapabilityValue> {
  return { ...currentState, ...originalState };
}

export function getTimeoutActions(
  timedCapability: string,
  restoreState: Record<string, CapabilityValue>,
  availableCapabilities: ReadonlySet<string>,
): CapabilityAction[] {
  const actions: CapabilityAction[] = [];
  const restoreEntries = Object.entries(restoreState)
    .filter((entry): entry is [string, Exclude<CapabilityValue, null>] => entry[1] !== null);

  if (restoreEntries.length === 0) {
    if (timedCapability === "dim") {
      actions.push({ capability: "dim", value: 0 });
      if (availableCapabilities.has("onoff")) {
        actions.push({ capability: "onoff", value: false });
      }
      return actions;
    }

    return [{ capability: timedCapability, value: false }];
  }

  if (restoreState.onoff === true && availableCapabilities.has("onoff")) {
    actions.push({ capability: "onoff", value: true });
  }
  if (typeof restoreState.dim === "number" && availableCapabilities.has("dim")) {
    actions.push({ capability: "dim", value: restoreState.dim });
  }
  if (restoreState.onoff === false && availableCapabilities.has("onoff")) {
    actions.push({ capability: "onoff", value: false });
  }

  for (const [capability, value] of restoreEntries) {
    if (capability !== "onoff" && capability !== "dim" && availableCapabilities.has(capability)) {
      actions.push({ capability, value });
    }
  }

  return actions;
}
