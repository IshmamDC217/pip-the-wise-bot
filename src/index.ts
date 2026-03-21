import { createServer } from 'node:http';
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

// Health server for Render (free tier requires an open port)
const PORT = parseInt(process.env.PORT || '10000');
createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
}).listen(PORT, () => logger.info({ port: PORT }, 'Health server listening'));

// Start
async function main() {
  await loadCommands(client);
  await client.login(config.DISCORD_TOKEN);
}

main().catch((err) => {
  logger.error(err, 'Failed to start bot');
  process.exit(1);
});
