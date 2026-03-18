import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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
  lastGmailCheck: null,
};

export function loadState(): MonitorState {
  try {
    if (existsSync(STATE_PATH)) {
      const raw = readFileSync(STATE_PATH, 'utf-8');
      return { ...defaultState, ...JSON.parse(raw) };
    }
  } catch (err) {
    logger.warn('Failed to load state, using defaults');
  }
  return { ...defaultState };
}

export function saveState(state: MonitorState): void {
  try {
    const dir = dirname(STATE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    logger.error('Failed to save state');
  }
}
