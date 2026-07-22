import type { CapabilityValue } from "./timer-utils";

export const TIMER_ACTIVITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type TimerActivityEvent =
  | "requested"
  | "started"
  | "replaced"
  | "restored"
  | "completed"
  | "cancelled_flow"
  | "cancelled_settings"
  | "cancelled_manual"
  | "cancelled_missing"
  | "skipped"
  | "failed";

const TIMER_ACTIVITY_EVENTS: readonly TimerActivityEvent[] = [
  "requested",
  "started",
  "replaced",
  "restored",
  "completed",
  "cancelled_flow",
  "cancelled_settings",
  "cancelled_manual",
  "cancelled_missing",
  "skipped",
  "failed",
];

export function isTimerActivityEvent(value: unknown): value is TimerActivityEvent {
  return typeof value === "string" && TIMER_ACTIVITY_EVENTS.includes(value as TimerActivityEvent);
}

export interface TimerActivityDevice {
  id: string;
  name: string;
  icon?: string;
}

export interface TimerActivityEntry {
  device: TimerActivityDevice;
  event: TimerActivityEvent;
  changedAt: number;
  counterDate: string;
  invocations: number;
  capability?: string;
  value?: CapabilityValue;
  previousValue?: CapabilityValue;
  duration?: number;
  offTime?: number;
  message?: string;
}

export interface TimerActivityUpdate {
  device: TimerActivityDevice;
  event: TimerActivityEvent;
  changedAt: number;
  counterDate: string;
  capability?: string;
  value?: CapabilityValue;
  previousValue?: CapabilityValue;
  duration?: number;
  offTime?: number;
  message?: string;
}

export function getDateKey(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function incrementInvocation(
  entry: TimerActivityEntry | undefined,
  counterDate: string,
): Pick<TimerActivityEntry, "counterDate" | "invocations"> {
  return {
    counterDate,
    invocations: entry?.counterDate === counterDate ? entry.invocations + 1 : 1,
  };
}

export function updateTimerActivity(
  entry: TimerActivityEntry | undefined,
  update: TimerActivityUpdate,
): TimerActivityEntry {
  const invocations = entry?.counterDate === update.counterDate ? entry.invocations : 0;
  return {
    ...entry,
    ...update,
    invocations,
  };
}

export function pruneTimerActivity(
  entries: Record<string, TimerActivityEntry>,
  now: number,
  activeDeviceIds: ReadonlySet<string>,
  retentionMs = TIMER_ACTIVITY_RETENTION_MS,
): Record<string, TimerActivityEntry> {
  return Object.fromEntries(Object.entries(entries).filter(([deviceId, entry]) => (
    activeDeviceIds.has(deviceId) || entry.changedAt >= now - retentionMs
  )));
}

export function clearInactiveTimerActivity(
  entries: Record<string, TimerActivityEntry>,
  activeDeviceIds: ReadonlySet<string>,
): Record<string, TimerActivityEntry> {
  return Object.fromEntries(Object.entries(entries).filter(([deviceId]) => activeDeviceIds.has(deviceId)));
}
