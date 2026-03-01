import { REST, Routes, Collection } from 'discord.js';
import type { Client } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { Command } from '../types.js';

// Import all commands
import * as ping from './ping.js';
import * as status from './status.js';
import * as stats from './stats.js';
import * as products from './products.js';
import * as users from './users.js';
import * as site from './site.js';
import * as calendar from './calendar.js';

const commandModules: Command[] = [ping, status, stats, products, users, site, calendar];

export async function loadCommands(client: Client) {
  const commands = new Collection<string, Command>();
  for (const cmd of commandModules) {
    commands.set(cmd.data.name, cmd);
    logger.info(`Loaded command: /${cmd.data.name}`);
  }
  (client as any).commands = commands;
}

// Run this file directly to register slash commands with Discord
async function registerCommands() {
  const rest = new REST().setToken(config.DISCORD_TOKEN);
  const body = commandModules.map((cmd) => cmd.data.toJSON());

  logger.info(`Registering ${body.length} slash commands...`);
  await rest.put(
    Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID),
    { body },
  );
  logger.info('Commands registered successfully!');
}

// If run directly (npm run register)
const isDirectRun = process.argv[1]?.includes('commands/index');
if (isDirectRun) {
  registerCommands().catch((err) => {
    logger.error(err, 'Failed to register commands');
    process.exit(1);
  });
}
