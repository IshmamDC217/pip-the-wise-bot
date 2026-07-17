import { Client, TextChannel } from 'discord.js';
import { config } from '../config.js';
import { loadState, updateState } from '../utils/state.js';
import { logger } from '../utils/logger.js';

const USERS = ['447033110773628930', '535658393562775562']; // Tobi, Ishmam

const nudges = [
  "hey {user}, it's been a few days — anything coming up you need on the calendar? lmk and i'll sort it",
  "yo {user}, got anything for the next couple weeks that needs scheduling? drop it here",
  "calendar check {user}: anything coming up? events, deadlines, whatever — i'll add it",
  "periodic nudge for {user}. anything to throw on the calendar before you forget?",
  "{user} it's that time again. any stalls, meetings, deadlines lurking? tell me and i'll handle it",
  "quick one {user} — need anything added to the calendar? i'm right here, might as well use me",
];

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check every hour if a nudge is due

export function startCalendarNudgeMonitor(client: Client): NodeJS.Timeout[] {
  logger.info(`Calendar nudge monitor started (nudge interval: ${config.NUDGE_INTERVAL_MS / 86400000}d, checking hourly)`);

  // Check immediately on startup, then every hour
  const initial = setTimeout(() => checkAndNudge(client), 10_000); // 10s after boot to let things settle
  const interval = setInterval(() => checkAndNudge(client), CHECK_INTERVAL_MS);
  return [initial, interval];
}

async function checkAndNudge(client: Client) {
  try {
    const state = loadState();
    const now = Date.now();

    // First run with no recorded nudge: seed the timer so the first nudge fires
    // one interval from now (defaulting to "now" without persisting meant the
    // elapsed time never accumulated and the nudge never fired).
    if (!state.lastNudgeAt) {
      updateState({ lastNudgeAt: new Date().toISOString() });
      return;
    }

    const elapsed = now - new Date(state.lastNudgeAt).getTime();
    if (elapsed < config.NUDGE_INTERVAL_MS) return;

    const channel = client.channels.cache.get(config.CHANNEL_GENERAL) as TextChannel;
    if (!channel) return;

    const userId = USERS[Math.floor(Math.random() * USERS.length)];
    const msg = nudges[Math.floor(Math.random() * nudges.length)].replace('{user}', `<@${userId}>`);
    await channel.send(msg);

    // Persist the nudge time (merge-write so other monitors' state survives)
    updateState({ lastNudgeAt: new Date().toISOString() });

    logger.info({ userId }, 'Calendar nudge sent');
  } catch (err) {
    logger.error({ err }, 'Calendar nudge error');
  }
}
