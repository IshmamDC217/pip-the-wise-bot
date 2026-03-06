import { Client, TextChannel } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000;

const USERS = ['447033110773628930', '535658393562775562']; // Tobi, Ishmam

const nudges = [
  "hey {user}, it's been a few days — anything coming up you need on the calendar? lmk and i'll sort it",
  "yo {user}, got anything for the next couple weeks that needs scheduling? drop it here",
  "calendar check {user}: anything coming up? events, deadlines, whatever — i'll add it",
  "periodic nudge for {user}. anything to throw on the calendar before you forget?",
  "{user} it's that time again. any stalls, meetings, deadlines lurking? tell me and i'll handle it",
  "quick one {user} — need anything added to the calendar? i'm right here, might as well use me",
];

export function startCalendarNudgeMonitor(client: Client) {
  logger.info('Calendar nudge monitor started (every 4 days)');

  // First nudge after 4 days, then every 4 days
  setInterval(() => sendNudge(client), FOUR_DAYS_MS);
}

async function sendNudge(client: Client) {
  try {
    const channel = client.channels.cache.get(config.CHANNEL_GENERAL) as TextChannel;
    if (!channel) return;

    const userId = USERS[Math.floor(Math.random() * USERS.length)];
    const msg = nudges[Math.floor(Math.random() * nudges.length)].replace('{user}', `<@${userId}>`);
    await channel.send(msg);
    logger.info('Calendar nudge sent');
  } catch (err) {
    logger.error({ err }, 'Calendar nudge error');
  }
}
