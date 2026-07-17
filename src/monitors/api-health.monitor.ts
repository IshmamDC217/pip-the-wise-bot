import { Client, TextChannel } from 'discord.js';
import { config } from '../config.js';
import { websiteService } from '../services/website.service.js';
import { buildApiDownEmbed, buildApiRecoveredEmbed } from '../embeds/website.embeds.js';
import { loadState, updateState } from '../utils/state.js';
import { logger } from '../utils/logger.js';

// A single timed-out check should not ping the channel; require two in a row.
const FAILURES_BEFORE_ALERT = 2;
let consecutiveFailures = 0;

export function startApiHealthMonitor(client: Client): NodeJS.Timeout[] {
  logger.info(`API health monitor started (every ${config.POLL_API_HEALTH_MS / 1000}s)`);

  const initial = setTimeout(() => poll(client), 5000);
  const interval = setInterval(() => poll(client), config.POLL_API_HEALTH_MS);
  return [initial, interval];
}

async function poll(client: Client) {
  try {
    const channel = client.channels.cache.get(config.CHANNEL_API_HEALTH) as TextChannel;
    if (!channel) return;

    const health = await websiteService.checkApiHealth();
    const state = loadState();

    if (!health.up) {
      consecutiveFailures++;
      if (state.apiUp && consecutiveFailures >= FAILURES_BEFORE_ALERT) {
        // API is down for real (debounced)
        updateState({ apiUp: false, apiDownSince: new Date().toISOString() });
        await channel.send({ embeds: [buildApiDownEmbed(health.latency)] });
        logger.warn('API is DOWN');
      }
      return;
    }

    consecutiveFailures = 0;
    if (!state.apiUp) {
      // API recovered
      const downtime = state.apiDownSince
        ? formatDuration(Date.now() - new Date(state.apiDownSince).getTime())
        : 'unknown';
      updateState({ apiUp: true, apiDownSince: null });
      await channel.send({ embeds: [buildApiRecoveredEmbed(health.latency, downtime)] });
      logger.info('API recovered');
    }
  } catch (err) {
    logger.error({ err }, 'API health monitor error');
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
