import { Client, TextChannel } from 'discord.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReminderEmbed } from '../embeds/calendar.embeds.js';
import { logger } from '../utils/logger.js';
import type { Reminder } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REMINDERS_PATH = join(__dirname, '../../data/reminders.json');

function loadReminders(): Reminder[] {
  try {
    if (existsSync(REMINDERS_PATH)) {
      return JSON.parse(readFileSync(REMINDERS_PATH, 'utf-8'));
    }
  } catch {
    logger.warn('Failed to load reminders, using empty list');
  }
  return [];
}

function saveReminders(reminders: Reminder[]): void {
  try {
    const dir = dirname(REMINDERS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(REMINDERS_PATH, JSON.stringify(reminders, null, 2));
  } catch {
    logger.error('Failed to save reminders');
  }
}

export function addReminder(reminder: Reminder): void {
  const reminders = loadReminders();
  reminders.push(reminder);
  saveReminders(reminders);
  logger.info({ id: reminder.id, dueAt: reminder.dueAt }, 'Reminder saved');
}

export function getPendingReminders(): Reminder[] {
  return loadReminders().filter((r) => !r.notified);
}

export function startReminderMonitor(client: Client) {
  logger.info('Reminder monitor started (every 60s)');

  setInterval(() => pollReminders(client), 60_000);
}

async function pollReminders(client: Client) {
  try {
    const reminders = loadReminders();
    const now = new Date();
    let changed = false;

    for (const reminder of reminders) {
      if (reminder.notified) continue;
      if (new Date(reminder.dueAt) > now) continue;

      const channel = client.channels.cache.get(reminder.channelId) as TextChannel;
      if (!channel) continue;

      await channel.send({ embeds: [buildReminderEmbed(reminder)] });
      reminder.notified = true;
      changed = true;
      logger.info({ id: reminder.id, message: reminder.message }, 'Reminder sent');
    }

    if (changed) saveReminders(reminders);
  } catch (err) {
    logger.error({ err }, 'Reminder monitor error');
  }
}
