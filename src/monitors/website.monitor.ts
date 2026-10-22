import { Client, TextChannel } from 'discord.js';
import { config } from '../config.js';
import { websiteService } from '../services/website.service.js';
import { buildSiteChangeEmbed } from '../embeds/website.embeds.js';
import { loadState, updateState } from '../utils/state.js';
import { logger } from '../utils/logger.js';

const PAGES_TO_MONITOR = ['/', '/shop'];

export function startWebsiteMonitor(client: Client): NodeJS.Timeout[] {
  logger.info(`Website monitor started (every ${config.POLL_WEBSITE_MS / 1000}s)`);

  // Run after a short delay to not spam on startup
  const initial = setTimeout(() => poll(client), 10000);
  const interval = setInterval(() => poll(client), config.POLL_WEBSITE_MS);
  return [initial, interval];
}

async function poll(client: Client) {
  try {
    const channel = client.channels.cache.get(config.CHANNEL_WEBSITE) as TextChannel;
    if (!channel) return;

    const pageHashes = { ...loadState().pageHashes };

    for (const page of PAGES_TO_MONITOR) {
      const hash = await websiteService.fetchPageHash(page);
      if (!hash) continue;

      const oldHash = pageHashes[page];
      if (oldHash && oldHash !== hash) {
        await channel.send({ embeds: [buildSiteChangeEmbed(page)] });
        logger.info(`Website change detected: ${page}`);
      }
      pageHashes[page] = hash;
    }

    // Merge-write only our own field so slow polls here can't revert what the
    // other monitors wrote in the meantime.
    updateState({ pageHashes });
  } catch (err) {
    logger.error({ err }, 'Website monitor error');
  }
}
