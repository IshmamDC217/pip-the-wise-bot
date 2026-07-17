import { Client } from 'discord.js';
import { startDatabaseMonitor } from './database.monitor.js';
import { startWebsiteMonitor } from './website.monitor.js';
import { startApiHealthMonitor } from './api-health.monitor.js';
import { startReminderMonitor } from './reminder.monitor.js';
import { startCalendarNudgeMonitor } from './calendar-nudge.monitor.js';
import { logger } from '../utils/logger.js';

/** Starts every monitor and returns a stopAll() that clears their timers. */
export function startAllMonitors(client: Client): () => void {
  logger.info('Starting all monitors...');
  const handles: NodeJS.Timeout[] = [
    startDatabaseMonitor(client),
    startWebsiteMonitor(client),
    startApiHealthMonitor(client),
    startReminderMonitor(client),
    startCalendarNudgeMonitor(client),
  ].flat();
  logger.info('All monitors started');

  return () => {
    for (const handle of handles) clearInterval(handle);
    logger.info('All monitors stopped');
  };
}
