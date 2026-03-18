import { Client } from 'discord.js';
import { startDatabaseMonitor } from './database.monitor.js';
import { startWebsiteMonitor } from './website.monitor.js';
import { startApiHealthMonitor } from './api-health.monitor.js';
import { startReminderMonitor } from './reminder.monitor.js';
import { startCalendarNudgeMonitor } from './calendar-nudge.monitor.js';
import { startGmailMonitor } from './gmail.monitor.js';
import { logger } from '../utils/logger.js';

export function startAllMonitors(client: Client) {
  logger.info('Starting all monitors...');
  startDatabaseMonitor(client);
  startWebsiteMonitor(client);
  startApiHealthMonitor(client);
  startReminderMonitor(client);
  startCalendarNudgeMonitor(client);
  startGmailMonitor(client);
  logger.info('All monitors started');
}
