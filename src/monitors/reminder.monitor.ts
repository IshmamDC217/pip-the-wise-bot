import { Client, TextChannel } from 'discord.js';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReminderEmbed } from '../embeds/calendar.embeds.js';
import { logger } from '../utils/logger.js';
import type { Reminder } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REMINDERS_PATH = join(__dirname, '../../data/reminders.json');

// Drop notified reminders after 30 days, and un-notified ones whose channel has
// been missing for several consecutive polls (deleted channel = undeliverable).
const NOTIFIED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CHANNEL_MISSES = 3;
const channelMisses = new Map<string, number>();

function loadFromDisk(): Reminder[] {
  try {
    if (existsSync(REMINDERS_PATH)) {
      return JSON.parse(readFileSync(REMINDERS_PATH, 'utf-8'));
    }
  } catch {
    logger.warn('Failed to load reminders, using empty list');
  }
  return [];
}

// Single in-memory store is the source of truth; every save serializes it whole.
// The old read-modify-write-per-caller pattern lost reminders added mid-poll.
const reminders: Reminder[] = loadFromDisk();

function save(): void {
  try {
    const dir = dirname(REMINDERS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Atomic write: a crash mid-write must not wipe the file
    const tmp = `${REMINDERS_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(reminders, null, 2));
    renameSync(tmp, REMINDERS_PATH);
  } catch {
    logger.error('Failed to save reminders');
  }
}

export function addReminder(reminder: Reminder): void {
  reminders.push(reminder);
  save();
  logger.info({ id: reminder.id, dueAt: reminder.dueAt }, 'Reminder saved');
}

export function getPendingReminders(): Reminder[] {
  return reminders.filter((r) => !r.notified);
}

export type CancelResult =
  | { ok: true; reminder: Reminder }
  | { ok: false; reason: 'none' | 'ambiguous' | 'forbidden'; matches?: Reminder[] };

/**
 * Cancel a pending reminder matched by free-text query ("cancel the float
 * reminder"). Only the creator or an admin may cancel; an empty query works
 * when exactly one reminder is pending.
 */
export function cancelReminder(query: string, requesterId: string, isAdmin: boolean): CancelResult {
  const pending = getPendingReminders();
  if (pending.length === 0) return { ok: false, reason: 'none' };

  const q = query.trim().toLowerCase();
  let matches = q ? pending.filter((r) => r.message.toLowerCase().includes(q)) : pending;
  if (q && matches.length === 0) {
    const words = q.split(/\s+/).filter((w) => w.length > 2);
    matches = pending.filter((r) => words.some((w) => r.message.toLowerCase().includes(w)));
  }

  if (matches.length === 0) return { ok: false, reason: 'none' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous', matches };

  const target = matches[0];
  if (!isAdmin && target.createdById && target.createdById !== requesterId) {
    return { ok: false, reason: 'forbidden' };
  }

  reminders.splice(reminders.indexOf(target), 1);
  channelMisses.delete(target.id);
  save();
  logger.info({ id: target.id, message: target.message }, 'Reminder cancelled');
  return { ok: true, reminder: target };
}

export function startReminderMonitor(client: Client): NodeJS.Timeout {
  logger.info('Reminder monitor started (every 60s)');

  return setInterval(() => pollReminders(client), 60_000);
}

function purgeStale(): boolean {
  const cutoff = Date.now() - NOTIFIED_RETENTION_MS;
  let removed = false;
  for (let i = reminders.length - 1; i >= 0; i--) {
    const r = reminders[i];
    const expired = r.notified && new Date(r.dueAt).getTime() < cutoff;
    const undeliverable = !r.notified && (channelMisses.get(r.id) ?? 0) >= MAX_CHANNEL_MISSES;
    if (expired || undeliverable) {
      if (undeliverable) logger.warn({ id: r.id, channelId: r.channelId }, 'Dropping undeliverable reminder (channel missing)');
      reminders.splice(i, 1);
      channelMisses.delete(r.id);
      removed = true;
    }
  }
  return removed;
}

async function pollReminders(client: Client) {
  try {
    const now = new Date();
    let changed = purgeStale();

    for (const reminder of reminders) {
      if (reminder.notified) continue;
      if (new Date(reminder.dueAt) > now) continue;

      const channel = client.channels.cache.get(reminder.channelId) as TextChannel;
      if (!channel) {
        channelMisses.set(reminder.id, (channelMisses.get(reminder.id) ?? 0) + 1);
        continue;
      }
      channelMisses.delete(reminder.id);

      // Per-reminder try/catch and an immediate save: one failed send must not
      // re-trigger reminders that already went out this cycle.
      try {
        // Ping the creator — a bare embed notifies nobody and gets missed
        await channel.send({
          content: reminder.createdById ? `<@${reminder.createdById}>` : undefined,
          embeds: [buildReminderEmbed(reminder)],
        });
        reminder.notified = true;
        save();
        changed = false;
        logger.info({ id: reminder.id, message: reminder.message }, 'Reminder sent');
      } catch (err) {
        logger.error({ err, id: reminder.id }, 'Failed to send reminder');
      }
    }

    if (changed) save();
  } catch (err) {
    logger.error({ err }, 'Reminder monitor error');
  }
}
