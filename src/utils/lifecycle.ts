// Bridges ready.ts (which starts the monitors) and index.ts (which owns shutdown).
let stopMonitors: (() => void) | null = null;

export function setMonitorStopper(stop: () => void) {
  stopMonitors = stop;
}

export function stopAllMonitors() {
  stopMonitors?.();
  stopMonitors = null;
}
