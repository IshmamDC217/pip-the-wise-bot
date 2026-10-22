import { Client, Events, REST, Routes } from 'discord.js';
import { logger } from '../utils/logger.js';
import { startAllMonitors } from '../monitors/index.js';
import { commands } from '../commands/index.js';
import { setMonitorStopper } from '../utils/lifecycle.js';
import { config } from '../config.js';

export const name = Events.ClientReady;
export const once = true;

export async function execute(client: Client<true>) {
  logger.info(`Logged in as ${client.user.tag}`);
  logger.info(`Serving ${client.guilds.cache.size} guild(s)`);

  // Guild-scoped registration is idempotent and instant; doing it on every boot
  // keeps the registered set in sync with the loaded set (the standalone
  // `npm run register` path was silently broken on Windows for months).
  try {
    const rest = new REST().setToken(config.DISCORD_TOKEN);
    const body = commands.map((c) => c.data.toJSON());
    await rest.put(
      Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID),
      { body },
    );
    logger.info({ count: body.length }, 'Slash commands registered');
  } catch (err) {
    logger.error({ err }, 'Slash command registration failed (continuing without re-registering)');
  }

  setMonitorStopper(startAllMonitors(client));
}
