import { Client, TextChannel } from 'discord.js';
import { config } from '../config.js';
import { db } from '../services/database.service.js';
import { buildNewUserEmbed, buildUserVerifiedEmbed, buildNewProductEmbed, buildStockChangeEmbed } from '../embeds/shop.embeds.js';
import { loadState, saveState } from '../utils/state.js';
import { logger } from '../utils/logger.js';
import type { MonitorState } from '../types.js';

let state: MonitorState;
let dbUnavailableLogged = false;

export function startDatabaseMonitor(client: Client) {
  state = loadState();
  logger.info(`Database monitor started (every ${config.POLL_DATABASE_MS / 1000}s)`);

  // Run immediately, then on interval
  poll(client);
  setInterval(() => poll(client), config.POLL_DATABASE_MS);
}

async function poll(client: Client) {
  try {
    // Skip silently if DB is unreachable (e.g. RDS not whitelisted)
    const connected = await db.isConnected();
    if (!connected) {
      if (!dbUnavailableLogged) {
        logger.warn('Database unreachable — monitor paused until connection is restored');
        dbUnavailableLogged = true;
      }
      return;
    }
    if (dbUnavailableLogged) {
      logger.info('Database connection restored — monitor resumed');
      dbUnavailableLogged = false;
    }

    const channel = client.channels.cache.get(config.CHANNEL_SHOP) as TextChannel;
    if (!channel) return;

    // Check new users
    const newUsers = await db.getNewUsers(new Date(state.lastUserCheck));
    if (newUsers.length > 0) {
      const totalUsers = await db.getUserCount();
      for (const user of newUsers) {
        await channel.send({ embeds: [buildNewUserEmbed(user, totalUsers)] });
      }
      state.lastUserCheck = new Date().toISOString();
    }

    // Check verified users
    const verified = await db.getVerifiedUsers(new Date(state.lastVerifiedCheck));
    if (verified.length > 0) {
      for (const user of verified) {
        await channel.send({ embeds: [buildUserVerifiedEmbed(user)] });
      }
      state.lastVerifiedCheck = new Date().toISOString();
    }

    // Check new products
    const newProducts = await db.getNewProducts(new Date(state.lastProductCheck));
    if (newProducts.length > 0) {
      for (const product of newProducts) {
        await channel.send({ embeds: [buildNewProductEmbed(product)] });
      }
      state.lastProductCheck = new Date().toISOString();
    }

    // Check stock changes
    const currentStock = await db.getAllProductStock();
    for (const product of currentStock) {
      const oldStock = state.stockSnapshot[product.id];
      if (oldStock !== undefined && oldStock !== product.stock) {
        await channel.send({
          embeds: [buildStockChangeEmbed(product.name, oldStock, product.stock)],
        });
      }
      state.stockSnapshot[product.id] = product.stock;
    }

    saveState(state);
  } catch (err) {
    logger.error({ err }, 'Database monitor error');
  }
}
