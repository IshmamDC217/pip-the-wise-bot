import { Client, TextChannel } from 'discord.js';
import { gmailService, ParsedEmail } from '../services/gmail.service.js';
import { buildEmailAlertEmbed } from '../embeds/gmail.embeds.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { loadState, saveState } from '../utils/state.js';

const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Track which email IDs we've already alerted on to avoid duplicates
const alertedIds = new Set<string>();

export function startGmailMonitor(client: Client) {
  if (!gmailService.isConfigured()) {
    logger.warn('Gmail monitor skipped — not configured');
    return;
  }

  logger.info('Gmail monitor started (5 min interval)');

  // Initialize from state
  const state = loadState();
  if (!state.lastGmailCheck) {
    // Default to 1 hour ago on first run so we don't spam old emails
    state.lastGmailCheck = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    saveState(state);
  }

  async function check() {
    try {
      const state = loadState();
      const afterEpoch = Math.floor(new Date(state.lastGmailCheck!).getTime() / 1000);

      const emails = await gmailService.getNewImportantEmails(afterEpoch);

      // Filter out already-alerted emails
      const newEmails = emails.filter((e) => !alertedIds.has(e.id));

      if (newEmails.length > 0) {
        const channel = client.channels.cache.get(config.CHANNEL_GENERAL) as TextChannel | undefined;
        if (!channel) {
          logger.warn('Gmail monitor: general channel not found');
          return;
        }

        for (const email of newEmails) {
          const embed = buildEmailAlertEmbed(email);
          await channel.send({ embeds: [embed] });
          alertedIds.add(email.id);
          logger.info({ from: email.from, subject: email.subject }, 'Gmail alert sent');
        }

        // Keep the alertedIds set from growing forever
        if (alertedIds.size > 200) {
          const iter = alertedIds.values();
          for (let i = 0; i < 100; i++) {
            const val = iter.next().value;
            if (val) alertedIds.delete(val);
          }
        }
      }

      // Update last check time
      state.lastGmailCheck = new Date().toISOString();
      saveState(state);
    } catch (err) {
      logger.error({ err }, 'Gmail monitor error');
    }
  }

  // First check after 10 seconds (let bot finish starting)
  setTimeout(check, 10_000);
  setInterval(check, POLL_INTERVAL);
}
