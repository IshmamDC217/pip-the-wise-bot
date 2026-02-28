import { Client, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { loadCommands } from './commands/index.js';

// Import events
import * as ready from './events/ready.js';
import * as interactionCreate from './events/interactionCreate.js';
import * as messageCreate from './events/messageCreate.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Register events
if (ready.once) {
  client.once(ready.name, (...args) => ready.execute(...(args as [any])));
} else {
  client.on(ready.name, (...args) => ready.execute(...(args as [any])));
}

client.on(interactionCreate.name, (...args) => interactionCreate.execute(...(args as [any])));
client.on(messageCreate.name, (...args) => messageCreate.execute(...(args as [any])));

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down...');
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Shutting down...');
  client.destroy();
  process.exit(0);
});

// Start
async function main() {
  await loadCommands(client);
  await client.login(config.DISCORD_TOKEN);
}

main().catch((err) => {
  logger.error(err, 'Failed to start bot');
  process.exit(1);
});
