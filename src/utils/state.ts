import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MonitorState } from '../types.js';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, '../../data/state.json');

const defaultState: MonitorState = {
  lastUserCheck: new Date().toISOString(),
  lastVerifiedCheck: new Date().toISOString(),
  lastProductCheck: new Date().toISOString(),
  stockSnapshot: {},
  pageHashes: {},
  apiUp: true,
  apiDownSince: null,
  lastNudgeAt: null,
};

export function loadState(): MonitorState {
  try {
    if (existsSync(STATE_PATH)) {
      const raw = readFileSync(STATE_PATH, 'utf-8');
      return { ...defaultState, ...JSON.parse(raw) };
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load state, using defaults');
  }
  return { ...defaultState };
}

// Atomic write: a crash mid-write must never leave a truncated state.json
// (loadState would then silently reset every monitor baseline).
function writeStateFile(state: MonitorState): void {
  const dir = dirname(STATE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH);
}

export function saveState(state: MonitorState): void {
  try {
    writeStateFile(state);
  } catch (err) {
    logger.error({ err }, 'Failed to save state');
  }
}

/**
 * Merge-write for monitors: re-reads the file fresh and writes only the given
 * fields, so a slow poll in one monitor can no longer clobber another monitor's
 * just-written state with a stale full-object save.
 */
export function updateState(partial: Partial<MonitorState>): MonitorState {
  const merged = { ...loadState(), ...partial };
  try {
    writeStateFile(merged);
  } catch (err) {
    logger.error({ err }, 'Failed to update state');
  }
  return merged;
}
