import { Client, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { loadCommands } from './commands/index.js';
import { stopAllMonitors } from './utils/lifecycle.js';

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

client.on('error', (err) => logger.error({ err }, 'Discord client error'));
client.on('shardError', (err) => logger.error({ err }, 'Discord shard error'));

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down...');
  try {
    stopAllMonitors();
    await client.destroy();
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// A stray rejection (failed reply, ws hiccup) must not kill the process — the old
// behavior turned every network blip into an NSSM crash-restart loop (the logs
// show thousands of 10-second boot cycles). Log it and keep running.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection (continuing)');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception — exiting for service restart');
  process.exit(1);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Start. Login failures (DNS not up yet at boot, Discord blip) retry in-process
// with capped backoff instead of exiting — re-logging in every 5 seconds via NSSM
// risks Discord anti-abuse throttling of the token.
async function main() {
  await loadCommands(client);

  let delay = 5000;
  for (;;) {
    try {
      await client.login(config.DISCORD_TOKEN);
      return;
    } catch (err) {
      logger.error({ err, retryInMs: delay }, 'Discord login failed, retrying');
      await sleep(delay);
      delay = Math.min(delay * 2, 5 * 60 * 1000);
    }
  }
}

main().catch((err) => {
  logger.error(err, 'Failed to start bot');
  process.exit(1);
});
